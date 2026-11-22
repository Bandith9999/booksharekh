// Resolves which provider/model an agent uses. Configuration only: nothing here switches providers
// at run time. A runtime fallback happens only through fallbackRoute(), and only when enabled.
import { AIError } from './errors.js';
import { getProvider, normalizeProvider } from './provider-factory.js';

export const TIERS = ['default', 'fast', 'code', 'review'];

// AI_<TIER>_PROVIDER / AI_<TIER>_MODEL. An unset tier uses the default tier.
// The default tier also accepts the Phase 1 names AI_PROVIDER / AI_MODEL.
export function tierRoute(env, tier) {
  const up = tier.toUpperCase();
  let provider = env[`AI_${up}_PROVIDER`];
  let model = env[`AI_${up}_MODEL`];
  if (tier === 'default' && !provider) { provider = env.AI_PROVIDER; model = model || env.AI_MODEL; }
  if (!provider) return tier === 'default' ? { provider: 'mock', model: 'mock' } : tierRoute(env, 'default');
  provider = normalizeProvider(provider);
  return { provider, model: provider === 'mock' ? 'mock' : (model || null) };
}

// override: a row from the D1 `agents` table (provider/model may be NULL = use the tier).
export function resolveRoute(env, agentDef, override = null) {
  if (override?.provider) {
    const provider = normalizeProvider(override.provider);
    return { provider, model: provider === 'mock' ? 'mock' : (override.model || null), source: 'agent override' };
  }
  const route = tierRoute(env, agentDef.tier);
  return { ...route, model: override?.model || route.model, source: override?.model ? 'agent override' : `tier ${agentDef.tier}` };
}

export function validateModelId(provider, model) {
  const p = getProvider(provider);
  if (!model) throw new AIError(`No model configured for provider ${p.name}`, { kind: 'config' });
  if (!p.modelPattern.test(model)) throw new AIError(`"${model}" is not a valid ${p.name} model id`, { kind: 'config' });
  return p;
}

// ---- Free-tier guard ----
// Paid AI stays locked until the owner sets AI_PAID_ENABLED=true in wrangler.jsonc and redeploys.
// While locked, only the mock provider and Gemini models on the AI_FREE_MODELS allowlist may run.
export const DEFAULT_FREE_MODELS = 'gemini-3.8-flash,gemini-3.6-flash,gemini-3.5-flash-lite';
export const paidEnabled = env => env.AI_PAID_ENABLED === 'true';
export const freeModels = env => String(env.AI_FREE_MODELS || DEFAULT_FREE_MODELS).split(',').map(s => s.trim()).filter(Boolean);
export const isFreeRoute = (env, route) => route.provider === 'mock' || (route.provider === 'google' && freeModels(env).includes(route.model));

// Throws a config AIError if the route cannot be used. Never prints key values.
export function validateRoute(env, route) {
  const p = validateModelId(route.provider, route.model);
  if (!paidEnabled(env) && !isFreeRoute(env, route)) {
    throw new AIError(`${route.provider}/${route.model} is not a free-tier model and paid AI is locked. Only the owner can unlock it: set AI_PAID_ENABLED=true in wrangler.jsonc and redeploy.`, { kind: 'config' });
  }
  if (p.keyName && !env[p.keyName]) throw new AIError(`${p.keyName} is not set (needed for ${p.name}/${route.model})`, { kind: 'config' });
  return p;
}

// Google may use free-tier (unpaid) Gemini prompts and responses to improve its products, and human
// reviewers may read them. Agents that handle confidential material must not use it by default.
export function checkDataPolicy(env, agentDef, route) {
  if (!agentDef.confidential || route.provider !== 'google' || env.GEMINI_PAID_TIER === 'true') return;
  if (env.AI_ALLOW_CONFIDENTIAL_ON_FREE_TIER === 'true') return;
  throw new AIError(`${agentDef.name} handles confidential content, and free-tier Gemini prompts may be used by Google to improve its products (human reviewers may read them). Use a paid Gemini project (GEMINI_PAID_TIER=true) or another paid provider.`, { kind: 'config' });
}

// Explicit opt-in: AI_FALLBACK_ENABLED=true plus AI_FALLBACK_PROVIDER/MODEL, and the agent must allow it.
export function fallbackRoute(env, agentDef) {
  if (env.AI_FALLBACK_ENABLED !== 'true' || !agentDef.allowFallback) return null;
  if (!env.AI_FALLBACK_PROVIDER || !env.AI_FALLBACK_MODEL) return null;
  return { provider: normalizeProvider(env.AI_FALLBACK_PROVIDER), model: env.AI_FALLBACK_MODEL, source: 'fallback' };
}

export const sameRoute = (a, b) => a.provider === b.provider && a.model === b.model;
