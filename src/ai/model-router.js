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

// Throws a config AIError if the route cannot be used. Never prints key values.
export function validateRoute(env, route) {
  const p = validateModelId(route.provider, route.model);
  if (p.keyName && !env[p.keyName]) throw new AIError(`${p.keyName} is not set (needed for ${p.name}/${route.model})`, { kind: 'config' });
  return p;
}

// Explicit opt-in: AI_FALLBACK_ENABLED=true plus AI_FALLBACK_PROVIDER/MODEL, and the agent must allow it.
export function fallbackRoute(env, agentDef) {
  if (env.AI_FALLBACK_ENABLED !== 'true' || !agentDef.allowFallback) return null;
  if (!env.AI_FALLBACK_PROVIDER || !env.AI_FALLBACK_MODEL) return null;
  return { provider: normalizeProvider(env.AI_FALLBACK_PROVIDER), model: env.AI_FALLBACK_MODEL, source: 'fallback' };
}

export const sameRoute = (a, b) => a.provider === b.provider && a.model === b.model;
