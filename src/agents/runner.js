// Runs one AI action for one agent step: route → budget → provider call → log → (opt-in) fallback.
import { AIError, AVAILABILITY_KINDS } from '../ai/errors.js';
import { fallbackRoute, resolveRoute, sameRoute, validateRoute } from '../ai/model-router.js';
import { getProvider } from '../ai/provider-factory.js';
import { audit, getAgentOverride } from '../db.js';
import { checkBudget, logExecution } from '../orchestration/budget.js';
import { getAgent } from './registry.js';

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
  const route = resolveRoute(env, def, override);
  validateRoute(env, route);

  const built = await action.buildRequest(env, { task, agentTask, def });
  const { remaining } = await checkBudget(env, task.id);
  const req = { ...built, agent: def.name, maxOutputTokens: Math.min(built.maxOutputTokens ?? def.maxOutputTokens, remaining) };
  const ctx = { task, agentTask, def };

  try {
    return await attempt(env, ctx, route, req);
  } catch (e) {
    const fb = fallbackRoute(env, def);
    // Fallback only for availability problems; never for refusals, auth, bad requests or budget.
    if (!fb || !(e instanceof AIError) || !AVAILABILITY_KINDS.has(e.kind) || sameRoute(fb, route)) throw e;
    validateRoute(env, fb);
    await checkBudget(env, task.id);
    await audit(env, task.id, 'PROVIDER_FALLBACK', 'system', `${def.name}: ${route.provider}/${route.model} → ${fb.provider}/${fb.model} after ${e.kind}`);
    return attempt(env, ctx, fb, req);
  }
}
