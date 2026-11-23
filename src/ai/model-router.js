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

// ---- Chains: who does a job first, and who takes over at a limit ----
// AI_<TIER>_CHAIN = "provider:model,provider:model,..." (in order). Without a chain the tier keeps its
// single route (AI_<TIER>_PROVIDER / _MODEL). A per-agent override (/agent ... set provider=) goes first.
export function parseChain(s) {
  return String(s || '').split(',').map(x => x.trim()).filter(Boolean).map(x => {
    const [p, ...m] = x.split(':');
    const provider = normalizeProvider(p);
    return { provider, model: provider === 'mock' ? 'mock' : (m.join(':') || null) };
  });
}
function tierChain(env, tier) {
  const up = tier.toUpperCase();
  const chain = parseChain(env[`AI_${up}_CHAIN`]);
  if (chain.length) return chain.map(r => ({ ...r, source: `tier ${tier}` }));
  if (tier !== 'default' && !env[`AI_${up}_PROVIDER`]) return tierChain(env, 'default').map(r => ({ ...r, source: `tier ${tier}` }));
  return [{ ...tierRoute(env, tier), source: `tier ${tier}` }];
}
export function resolveChain(env, agentDef, override = null) {
  const chain = tierChain(env, agentDef.tier);
  if (override?.provider) {
    const first = resolveRoute(env, agentDef, override);
    return [first, ...chain.filter(r => !sameRoute(r, first))];
  }
  if (override?.model) return [{ ...chain[0], model: override.model, source: 'agent override' }, ...chain.slice(1)];
  return chain;
}
export const chainLabel = chain => chain.map(r => `${r.provider}/${r.model}`).join(' → ');

// ---- Rest periods: a provider at its limit is skipped until its limit resets ----
const COOLDOWN = p => `ai_cooldown:${p}`;
export async function cooldownOf(env, provider, now = Date.now()) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(COOLDOWN(provider)).first().catch(() => null);
  try { const v = JSON.parse(row?.value || 'null'); return v && v.until > now ? v : null; } catch { return null; }
}
export async function setCooldown(env, provider, until, kind) {
  await env.DB.prepare(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`).bind(COOLDOWN(provider), JSON.stringify({ until, kind })).run();
}
// Next local midnight in a time zone (+5 min margin). Gemini free quotas reset at midnight Pacific time.
export function nextMidnight(timeZone, now = Date.now()) {
  const hour = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' });
  for (let t = Math.ceil((now + 1) / 3600000) * 3600000, i = 0; i < 27; i++, t += 3600000) {
    if (Number(hour.format(t)) === 0) return t + 5 * 60000;
  }
  return now + 86400000;
}
export const nextUtcMidnight = (now = Date.now()) => (Math.floor(now / 86400000) + 1) * 86400000 + 60000;
// How long a provider rests after an error; null = no rest, just try the next AI this time.
export function restUntil(provider, e, now = Date.now()) {
  if (e.kind === 'rate_limit') return now + Math.max(Number(e.retryAfter) || 60, 30) * 1000;
  if (e.kind === 'quota') return provider === 'google' ? nextMidnight('America/Los_Angeles', now) : now + 6 * 3600000;
  if (['auth', 'model_not_found', 'config'].includes(e.kind)) return now + 6 * 3600000;
  return null;
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
