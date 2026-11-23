// Runs one AI action for one agent step.
// AI chain (AI_<TIER>_CHAIN, owner request): each job type has an ordered list of AIs (e.g. Claude →
// Codex → Gemini). An AI at its limit (rate limit, quota, no credit) rests until the limit resets and
// the next AI takes the work; a broken AI (bad key, missing model) is skipped for a while. Refusals are
// never shopped around. If every AI is at a limit, the step fails with kind 'quota' + resumeAt and the
// engine pauses the task and resumes it automatically. With a single AI (no chain) the original
// behaviour is kept: route → budget → call → (opt-in) availability fallback.
import { AIError, AVAILABILITY_KINDS } from '../ai/errors.js';
import { checkDataPolicy, cooldownOf, fallbackRoute, isFreeRoute, nextUtcMidnight, resolveChain, restUntil, sameRoute, setCooldown, validateRoute } from '../ai/model-router.js';
import { getProvider } from '../ai/provider-factory.js';
import { audit, getAgentOverride } from '../db.js';
import { checkBudget, logExecution } from '../orchestration/budget.js';
import { notifyOwner } from '../telegram.js';
import { T } from '../i18n.js';
import { getAgent } from './registry.js';

// Errors where another AI may succeed. Refusals and our own per-task budget never switch.
const SWITCH = new Set(['rate_limit', 'overloaded', 'server', 'timeout', 'network', 'quota', 'auth', 'model_not_found', 'config', 'invalid_output', 'truncated', 'bad_request']);
// Limits that reset by themselves: worth waiting for. (A bad key or missing model needs the owner.)
const LIMIT = new Set(['rate_limit', 'quota']);
const LONG_REST_MS = 30 * 60000;

async function attempt(env, ctx, route, req) {
  const started = Date.now();
  const base = { taskId: ctx.task.id, agentTaskId: ctx.agentTask.id, agent: ctx.def.name, provider: route.provider, model: route.model,
    attempt: ctx.agentTask.attempts, promptVersion: req.promptVersion };
  try {
    const res = await getProvider(route.provider).generate(env, { ...req, model: route.model });
    await logExecution(env, { ...base, model: res.model, outcome: 'success', usage: res.usage, durationMs: Date.now() - started });
    return res;
  } catch (e) {
    await logExecution(env, { ...base, outcome: e?.kind === 'refusal' ? 'refusal' : 'error', errorKind: e?.kind ?? 'unexpected', usage: e?.usage, durationMs: Date.now() - started });
    throw e;
  }
}

export async function runAIAction(env, { task, agentTask, action }) {
  const def = getAgent(agentTask.agent);
  const override = await getAgentOverride(env, def.name);
  if (override && override.enabled === 0) throw new AIError(`Agent ${def.name} is disabled (/agent ${def.name} set enabled=on)`, { kind: 'config' });
  let chain = resolveChain(env, def, override);
  // e.g. the QA Reviewer should not review with the same AI that wrote the work.
  const avoid = action.avoidProviders ? await action.avoidProviders(env, { task, agentTask }) : [];
  if (avoid.length) chain = [...chain.filter(r => !avoid.includes(r.provider)), ...chain.filter(r => avoid.includes(r.provider))];
  const built = await action.buildRequest(env, { task, agentTask, def });
  const ctx = { task, agentTask, def };
  return chain.length > 1 ? runChain(env, ctx, chain, built) : runSingle(env, ctx, chain[0], built);
}

async function runChain(env, ctx, chain, built) {
  const { task, def } = ctx;
  const tried = [];
  let lastError = null, wakeAt = null;
  const wake = t => { if (t && (!wakeAt || t < wakeAt)) wakeAt = t; };

  for (const route of chain) {
    const resting = await cooldownOf(env, route.provider);
    if (resting) { tried.push(`${route.provider}: resting (${resting.kind})`); if (LIMIT.has(resting.kind)) wake(resting.until); continue; }
    try { validateRoute(env, route); checkDataPolicy(env, def, route); } catch (e) { tried.push(`${route.provider}: ${e.message}`); lastError ??= e; continue; }
    let remaining;
    try { ({ remaining } = await checkBudget(env, task.id, { free: isFreeRoute(env, route), paidOnly: true })); } catch (e) {
      if (e.kind !== 'quota') throw e; // per-task budget fails; per-minute limit retries the step
      tried.push(`${route.provider}: daily budget`); lastError = e; wake(nextUtcMidnight()); continue;
    }
    const req = { ...built, agent: def.name, maxOutputTokens: Math.min(built.maxOutputTokens ?? def.maxOutputTokens, remaining) };
    try {
      const res = await attempt(env, ctx, route, req);
      if (tried.length) await audit(env, task.id, 'PROVIDER_SWITCH', 'system', `${def.name} done by ${route.provider}/${res.model} after: ${tried.join('; ').slice(0, 300)}`);
      return res;
    } catch (e) {
      if (!(e instanceof AIError) || !SWITCH.has(e.kind)) throw e;
      lastError = e;
      tried.push(`${route.provider}: ${e.kind}`);
      const until = restUntil(route.provider, e);
      if (!until) continue;
      const was = await cooldownOf(env, route.provider);
      await setCooldown(env, route.provider, until, e.kind);
      if (LIMIT.has(e.kind)) wake(until);
      // Tell the owner (silently) once when an AI is out for a long time, e.g. daily quota or no credit.
      if (!was && until - Date.now() >= LONG_REST_MS) await notifyOwner(env, T.aiResting(env, route.provider, e.kind, until)).catch(() => {});
    }
  }
  if (wakeAt) throw new AIError(`All AIs are busy or at their limits (${tried.join('; ').slice(0, 300)})`, { kind: 'quota', resumeAt: wakeAt });
  throw lastError || new AIError('No AI provider is available', { kind: 'config' });
}

// One AI only: route → budget → call → (opt-in) availability fallback. Unchanged from Phase 2.
async function runSingle(env, ctx, route, built) {
  const { task, def } = ctx;
  validateRoute(env, route);
  checkDataPolicy(env, def, route);
  const { remaining } = await checkBudget(env, task.id);
  const req = { ...built, agent: def.name, maxOutputTokens: Math.min(built.maxOutputTokens ?? def.maxOutputTokens, remaining) };
  try {
    return await attempt(env, ctx, route, req);
  } catch (e) {
    const fb = fallbackRoute(env, def);
    // Fallback only for availability problems; never for refusals, auth, bad requests or budget.
    if (!fb || !(e instanceof AIError) || !AVAILABILITY_KINDS.has(e.kind) || sameRoute(fb, route)) throw e;
    try {
      validateRoute(env, fb); // a paid fallback is refused while paid AI is locked
      checkDataPolicy(env, def, fb);
    } catch (blocked) {
      // A disallowed fallback means "no fallback": keep the original (retryable) error.
      await audit(env, task.id, 'FALLBACK_BLOCKED', 'system', `${def.name}: ${fb.provider}/${fb.model}: ${blocked.message}`);
      throw e;
    }
    await checkBudget(env, task.id);
    await audit(env, task.id, 'PROVIDER_FALLBACK', 'system', `${def.name}: ${route.provider}/${route.model} → ${fb.provider}/${fb.model} after ${e.kind}`);
    return attempt(env, ctx, fb, req);
  }
}
