import { clamp } from '../helpers.js';
import { AIError, errorDetail, fetchJson, kindForStatus, retryAfterSeconds } from './errors.js';
import { makeResponse } from './provider-interface.js';
import { parseStructured, toProviderSchema } from './schema.js';

const API = 'https://api.openai.com/v1';
const TIMEOUT_MS = 25000;

function hint(status, code) {
  if (code === 'insufficient_quota') return 'OpenAI account has no remaining quota: check billing.';
  if (status === 401) return 'Key rejected: run `npx wrangler secret put OPENAI_API_KEY` with a valid platform API key.';
  if (status === 403) return 'Key or project lacks access to this model.';
  if (status === 404) return 'Model not available to this account: check the configured OpenAI model.';
  if (status === 429) return 'Rate limited: try again shortly.';
  return '';
}

// model "auto": ask OpenAI which models this key can use and pick the newest general GPT model,
// preferring the affordable "Sol" line (e.g. gpt-6.2-sol). Cached in D1 settings for 7 days.
const SKIP = /(mini|nano|audio|realtime|search|image|tts|transcribe|embedding|moderation|preview|instruct)/i;
const version = id => Number((/^gpt-(\d+(?:\.\d+)?)/i.exec(id) || [])[1] || 0);
export function pickOpenAIModel(ids) {
  const usable = ids.filter(id => /^gpt-\d/i.test(id) && !SKIP.test(id));
  const best = list => list.sort((a, b) => version(b) - version(a) || a.length - b.length)[0];
  return best(usable.filter(id => /-sol$/i.test(id))) || best(usable.filter(id => /^gpt-\d+(\.\d+)?$/i.test(id))) || best(usable) || null;
}
export async function resolveOpenAIModel(env, { refresh = false } = {}) {
  const cached = refresh ? null : await env.DB?.prepare("SELECT value, updated_at FROM settings WHERE key='openai_model' AND updated_at > datetime('now','-7 days')").first().catch(() => null);
  if (cached?.value) return cached.value;
  const { response, body } = await fetchJson('openai', `${API}/models`, { headers: { authorization: `Bearer ${String(env.OPENAI_API_KEY || '').trim()}` } }, 10000);
  if (!response.ok) throw new AIError(`openai model list HTTP ${response.status}: ${clamp(errorDetail(body), 120)}. ${hint(response.status)}`, { kind: kindForStatus(response.status), status: response.status, provider: 'openai' });
  const model = pickOpenAIModel((body?.data || []).map(m => String(m.id)));
  if (!model) throw new AIError('No suitable GPT model is available to this OpenAI key', { kind: 'model_not_found', provider: 'openai' });
  await env.DB?.prepare(`INSERT INTO settings (key,value,updated_at) VALUES ('openai_model',?,CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`).bind(model).run();
  return model;
}

export const openaiProvider = {
  name: 'openai',
  keyName: 'OPENAI_API_KEY',
  modelPattern: /^((gpt|o\d|chatgpt|codex)[a-z0-9._-]{0,60}|auto)$/i,

  async generate(env, req) {
    const body = {
      model: req.model === 'auto' ? await resolveOpenAIModel(env) : req.model,
      messages: [{ role: 'system', content: req.systemPrompt }, ...req.messages],
      // max_completion_tokens (not max_tokens) is accepted by both reasoning and non-reasoning models.
      max_completion_tokens: req.maxOutputTokens ?? 2000,
    };
    if (req.temperature != null) body.temperature = req.temperature;
    if (req.responseSchema) {
      body.response_format = { type: 'json_schema', json_schema: { name: 'output', strict: true, schema: toProviderSchema(req.responseSchema) } };
    }
    const { response, body: res } = await fetchJson('openai', `${API}/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${String(env.OPENAI_API_KEY || '').trim()}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    }, TIMEOUT_MS);
    if (!response.ok) {
      const code = res?.error?.code;
      const kind = code === 'insufficient_quota' ? 'quota' : kindForStatus(response.status);
      throw new AIError(`openai API HTTP ${response.status}: ${clamp(errorDetail(res), 150)}. ${hint(response.status, code)}`.trim(),
        { kind, status: response.status, provider: 'openai', retryAfter: retryAfterSeconds(response) });
    }
    const usage = { inputTokens: res?.usage?.prompt_tokens ?? 0, outputTokens: res?.usage?.completion_tokens ?? 0 };
    const choice = res?.choices?.[0];
    if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') {
      throw new AIError(`OpenAI declined this request${choice?.message?.refusal ? `: ${clamp(choice.message.refusal, 120)}` : ''}`, { kind: 'refusal', provider: 'openai', usage });
    }
    if (choice?.finish_reason === 'length') throw new AIError('OpenAI reply was cut off (length)', { kind: 'truncated', provider: 'openai', usage });
    const content = String(choice?.message?.content || '').trim();
    if (!content) throw new AIError('OpenAI returned no text', { kind: 'invalid_output', provider: 'openai', usage });
    return makeResponse({
      provider: 'openai', model: res?.model || req.model, content,
      structuredOutput: req.responseSchema ? parseStructured(content, req.responseSchema, 'openai') : undefined,
      ...usage, finishReason: choice?.finish_reason || 'stop',
    });
  },

  async checkModel(env, model) {
    if (model === 'auto') {
      try { const m = await resolveOpenAIModel(env, { refresh: true }); return { ok: true, status: 200, detail: '', hint: '', model: m }; }
      catch (e) { return { ok: false, status: e.status || 0, detail: clamp(e.message, 150), hint: '' }; }
    }
    const { response, body } = await fetchJson('openai', `${API}/models/${encodeURIComponent(model)}`,
      { headers: { authorization: `Bearer ${String(env.OPENAI_API_KEY || '').trim()}` } }, 10000);
    return { ok: response.ok, status: response.status, detail: response.ok ? '' : clamp(errorDetail(body), 150), hint: response.ok ? '' : hint(response.status) };
  },
};
