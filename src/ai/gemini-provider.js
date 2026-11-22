import { clamp } from '../helpers.js';
import { AIError, errorDetail, fetchJson, kindForStatus, retryAfterSeconds } from './errors.js';
import { makeResponse } from './provider-interface.js';
import { parseStructured, toProviderSchema } from './schema.js';

const API = 'https://generativelanguage.googleapis.com/v1beta';
const TIMEOUT_MS = 25000;
const BLOCKED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']);

function headers(env) {
  return { 'x-goog-api-key': String(env.GEMINI_API_KEY || '').trim(), 'content-type': 'application/json' };
}

// Gemini error bodies come in two shapes:
//   new:    { error: { code: 'quota_exceeded' | 'rate_limit_exceeded' | 'too_many_requests', message } }
//   legacy: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [QuotaFailure{quotaId}, RetryInfo{retryDelay}] } }
function classify(status, body) {
  const e = body?.error || {};
  const text = `${e.code ?? ''} ${e.status ?? ''} ${e.message ?? ''} ${JSON.stringify(e.details ?? '')}`;
  if (status === 400 && /API[_ ]KEY/i.test(text)) return 'auth';
  if (status === 403 && /FREE_TIER_VERIFICATION/i.test(text)) return 'config';
  if (status === 429) return e.code === 'quota_exceeded' || /PerDay|per day|daily/i.test(text) ? 'quota' : 'rate_limit';
  return kindForStatus(status);
}
function retryDelaySeconds(body, response) {
  const info = (body?.error?.details || []).find(d => String(d?.['@type'] || '').endsWith('RetryInfo'));
  const s = parseFloat(info?.retryDelay);
  return Number.isFinite(s) ? Math.min(Math.ceil(s), 3600) : retryAfterSeconds(response);
}
function hint(kind) {
  if (kind === 'auth') return 'Key rejected: run `npx wrangler secret put GEMINI_API_KEY` with a valid Google AI Studio key.';
  if (kind === 'model_not_found') return 'Model not available: check AI_DEFAULT_MODEL / AI_FREE_MODELS.';
  if (kind === 'quota') return 'Free-tier daily quota used up; Google resets it at midnight Pacific time.';
  if (kind === 'rate_limit') return 'Free-tier per-minute limit reached; retrying later.';
  if (kind === 'config') return 'Google requires free-tier verification for this project (FREE_TIER_VERIFICATION_REQUIRED). Complete it in AI Studio; linking billing would move the project to the paid tier.';
  return '';
}

// OpenAPI-style schema for the older `responseSchema` field: no type arrays (use nullable), upper-case types.
function toOpenApi(schema) {
  if (Array.isArray(schema)) return schema.map(toOpenApi);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'type') {
      const types = [].concat(v);
      out.type = types.find(t => t !== 'null').toUpperCase();
      if (types.includes('null')) out.nullable = true;
    } else if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v).map(([p, s]) => [p, toOpenApi(s)]));
    else out[k] = typeof v === 'object' ? toOpenApi(v) : v;
  }
  return out;
}

export const geminiProvider = {
  name: 'google',
  keyName: 'GEMINI_API_KEY',
  modelPattern: /^gemini-[a-z0-9][a-z0-9.-]{1,60}$/,

  async generate(env, req) {
    const generationConfig = { maxOutputTokens: req.maxOutputTokens ?? 2000 };
    if (req.temperature != null) generationConfig.temperature = req.temperature;
    let system = req.systemPrompt;
    if (req.responseSchema) {
      generationConfig.responseMimeType = 'application/json';
      // GEMINI_SCHEMA_MODE: json_schema (default) | openapi | prompt. The output is validated locally in every mode.
      const mode = env.GEMINI_SCHEMA_MODE || 'json_schema';
      const plain = toProviderSchema(req.responseSchema, { dropAdditionalProperties: true });
      if (mode === 'openapi') generationConfig.responseSchema = toOpenApi(plain);
      else if (mode === 'prompt') system += `\n\nRespond with only one JSON object that matches this JSON Schema:\n${JSON.stringify(plain)}`;
      else generationConfig.responseJsonSchema = plain;
    }
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: req.messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig,
    };
    const { response, body: res } = await fetchJson('google', `${API}/models/${encodeURIComponent(req.model)}:generateContent`,
      { method: 'POST', headers: headers(env), body: JSON.stringify(body) }, TIMEOUT_MS);
    if (!response.ok) {
      const kind = classify(response.status, res);
      throw new AIError(`gemini API HTTP ${response.status}: ${clamp(errorDetail(res), 150)}. ${hint(kind)}`.trim(),
        { kind, status: response.status, provider: 'google', retryAfter: retryDelaySeconds(res, response) });
    }
    const meta = res?.usageMetadata || {};
    const usage = { inputTokens: meta.promptTokenCount ?? 0, outputTokens: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0) };
    if (res?.promptFeedback?.blockReason) throw new AIError(`Gemini blocked the prompt (${res.promptFeedback.blockReason})`, { kind: 'refusal', provider: 'google', usage });
    const cand = res?.candidates?.[0];
    if (BLOCKED.has(cand?.finishReason)) throw new AIError(`Gemini declined this request (${cand.finishReason})`, { kind: 'refusal', provider: 'google', usage });
    if (cand?.finishReason === 'MAX_TOKENS') throw new AIError('Gemini reply was cut off (MAX_TOKENS)', { kind: 'truncated', provider: 'google', usage });
    const content = (cand?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('').trim();
    if (!content) throw new AIError('Gemini returned no text', { kind: 'invalid_output', provider: 'google', usage });
    return makeResponse({
      provider: 'google', model: res?.modelVersion || req.model, content,
      structuredOutput: req.responseSchema ? parseStructured(content, req.responseSchema, 'google') : undefined,
      ...usage, finishReason: cand?.finishReason || 'STOP',
    });
  },

  // Free: reads model metadata, no generation.
  async checkModel(env, model) {
    const { response, body } = await fetchJson('google', `${API}/models/${encodeURIComponent(model)}`, { headers: headers(env) }, 10000);
    const kind = response.ok ? null : classify(response.status, body);
    return { ok: response.ok, status: response.status, detail: response.ok ? '' : clamp(errorDetail(body), 150), hint: response.ok ? '' : hint(kind) };
  },
};
