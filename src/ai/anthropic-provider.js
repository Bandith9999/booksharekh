import { anthropicHint, clamp } from '../helpers.js';
import { AIError, errorDetail, fetchJson, kindForStatus, retryAfterSeconds } from './errors.js';
import { makeResponse } from './provider-interface.js';
import { parseStructured, toProviderSchema } from './schema.js';

const API = 'https://api.anthropic.com/v1';
const VERSION = '2023-06-01';
const TIMEOUT_MS = 25000;
// Models that accept output_config.effort.
const EFFORT_MODELS = /^claude-(fable-5|mythos-5|opus-5|opus-4-[5-8]|sonnet-5|sonnet-4-6|haiku-5)/;
// Models that accept Anthropic's server-side refusal fallback. Off unless ANTHROPIC_REFUSAL_FALLBACK=true,
// because it serves a declined request from a different model.
const REFUSAL_FALLBACK_MODELS = /^claude-(fable-5|opus-5|sonnet-5-5)/;

function headers(env) {
  return { 'x-api-key': String(env.ANTHROPIC_API_KEY || '').trim(), 'anthropic-version': VERSION, 'content-type': 'application/json' };
}

export const anthropicProvider = {
  name: 'anthropic',
  keyName: 'ANTHROPIC_API_KEY',
  modelPattern: /^claude-[a-z0-9][a-z0-9.-]{2,60}$/,

  async generate(env, req) {
    const h = headers(env);
    const body = {
      model: req.model,
      // Recent Claude models think before answering and that counts toward max_tokens.
      max_tokens: req.maxOutputTokens ?? 2000,
      system: req.systemPrompt,
      messages: req.messages,
    };
    // temperature is not sent: current Claude models reject non-default sampling parameters.
    const outputConfig = {};
    if (req.effort && EFFORT_MODELS.test(req.model)) outputConfig.effort = req.effort;
    if (req.responseSchema) outputConfig.format = { type: 'json_schema', schema: toProviderSchema(req.responseSchema) };
    if (Object.keys(outputConfig).length) body.output_config = outputConfig;
    if (env.ANTHROPIC_REFUSAL_FALLBACK === 'true' && REFUSAL_FALLBACK_MODELS.test(req.model)) {
      h['anthropic-beta'] = 'server-side-fallback-2026-07-01';
      body.fallbacks = 'default';
    }

    const { response, body: res } = await fetchJson('anthropic', `${API}/messages`, { method: 'POST', headers: h, body: JSON.stringify(body) }, TIMEOUT_MS);
    if (!response.ok) {
      // An empty credit balance is a quota (another AI takes over), not a bad request.
      const noCredit = response.status === 400 && /credit balance|billing/i.test(errorDetail(res));
      throw new AIError(`anthropic API HTTP ${response.status}: ${clamp(errorDetail(res), 150)}. ${noCredit ? 'Credit balance too low: add credits in the Claude Console.' : anthropicHint(response.status)}`,
        { kind: noCredit ? 'quota' : kindForStatus(response.status), status: response.status, provider: 'anthropic', retryAfter: retryAfterSeconds(response) });
    }
    const usage = { inputTokens: res?.usage?.input_tokens ?? 0, outputTokens: res?.usage?.output_tokens ?? 0 };
    if (res?.stop_reason === 'refusal') {
      const category = res?.stop_details?.category ? ` (${res.stop_details.category})` : '';
      throw new AIError(`Claude declined this request${category}`, { kind: 'refusal', provider: 'anthropic', usage });
    }
    if (res?.stop_reason === 'max_tokens') throw new AIError('Claude reply was cut off (max_tokens)', { kind: 'truncated', provider: 'anthropic', usage });
    const content = (res?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (!content) throw new AIError('Claude returned no text', { kind: 'invalid_output', provider: 'anthropic', usage });
    return makeResponse({
      provider: 'anthropic', model: res?.model || req.model, content,
      structuredOutput: req.responseSchema ? parseStructured(content, req.responseSchema, 'anthropic') : undefined,
      ...usage, finishReason: res?.stop_reason || 'end_turn',
    });
  },

  async checkModel(env, model) {
    const { response, body } = await fetchJson('anthropic', `${API}/models/${encodeURIComponent(model)}`, { headers: headers(env) }, 10000);
    return { ok: response.ok, status: response.status, detail: response.ok ? '' : clamp(errorDetail(body), 150), hint: response.ok ? '' : anthropicHint(response.status) };
  },
};
