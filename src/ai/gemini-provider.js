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
// Gemini reports an invalid key as HTTP 400 INVALID_ARGUMENT, not 401.
function classify(status, body) {
  const msg = `${body?.error?.message || ''} ${JSON.stringify(body?.error?.details || '')}`;
  if (status === 400 && /API[_ ]KEY/i.test(msg)) return 'auth';
  return kindForStatus(status);
}
function hint(kind) {
  if (kind === 'auth') return 'Key rejected: run `npx wrangler secret put GEMINI_API_KEY` with a valid Google AI Studio key.';
  if (kind === 'model_not_found') return 'Model not available: check the configured Gemini model.';
  if (kind === 'rate_limit') return 'Rate limited or quota exhausted: try again later.';
  return '';
}

export const geminiProvider = {
  name: 'google',
  keyName: 'GEMINI_API_KEY',
  modelPattern: /^gemini-[a-z0-9][a-z0-9.-]{1,60}$/,

  async generate(env, req) {
    const generationConfig = { maxOutputTokens: req.maxOutputTokens ?? 2000 };
    if (req.temperature != null) generationConfig.temperature = req.temperature;
    if (req.responseSchema) {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseJsonSchema = toProviderSchema(req.responseSchema, { dropAdditionalProperties: true });
    }
    const body = {
      systemInstruction: { parts: [{ text: req.systemPrompt }] },
      contents: req.messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig,
    };
    const { response, body: res } = await fetchJson('google', `${API}/models/${encodeURIComponent(req.model)}:generateContent`,
      { method: 'POST', headers: headers(env), body: JSON.stringify(body) }, TIMEOUT_MS);
    if (!response.ok) {
      const kind = classify(response.status, res);
      throw new AIError(`gemini API HTTP ${response.status}: ${clamp(errorDetail(res), 150)}. ${hint(kind)}`.trim(),
        { kind, status: response.status, provider: 'google', retryAfter: retryAfterSeconds(response) });
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

  async checkModel(env, model) {
    const { response, body } = await fetchJson('google', `${API}/models/${encodeURIComponent(model)}`, { headers: headers(env) }, 10000);
    const kind = response.ok ? null : classify(response.status, body);
    return { ok: response.ok, status: response.status, detail: response.ok ? '' : clamp(errorDetail(body), 150), hint: response.ok ? '' : hint(kind) };
  },
};
