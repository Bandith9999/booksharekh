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

export const openaiProvider = {
  name: 'openai',
  keyName: 'OPENAI_API_KEY',
  modelPattern: /^(gpt|o\d|chatgpt|codex)[a-z0-9._-]{0,60}$/i,

  async generate(env, req) {
    const body = {
      model: req.model,
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
    const { response, body } = await fetchJson('openai', `${API}/models/${encodeURIComponent(model)}`,
      { headers: { authorization: `Bearer ${String(env.OPENAI_API_KEY || '').trim()}` } }, 10000);
    return { ok: response.ok, status: response.status, detail: response.ok ? '' : clamp(errorDetail(body), 150), hint: response.ok ? '' : hint(response.status) };
  },
};
