// Token budgets, checked before every AI call. Tokens are tracked per provider/model in
// agent_execution_logs; converting them to money needs current price tables and is left to reports.
import { AIError } from '../ai/errors.js';

const n = (v, d) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : d; };
export const budgets = env => ({ task: n(env.TASK_TOKEN_BUDGET, 60000), daily: n(env.DAILY_TOKEN_BUDGET, 500000) });
const MIN_USEFUL = 500;

export async function tokensUsed(env, taskId) {
  const t = await env.DB.prepare('SELECT COALESCE(SUM(input_tokens+output_tokens),0) used FROM agent_execution_logs WHERE task_id=?').bind(taskId).first();
  const d = await env.DB.prepare("SELECT COALESCE(SUM(input_tokens+output_tokens),0) used FROM agent_execution_logs WHERE created_at >= date('now')").first();
  return { task: Number(t.used), daily: Number(d.used) };
}

// Returns the tokens still available for one call; throws kind 'budget' when exhausted.
export async function checkBudget(env, taskId) {
  const limit = budgets(env);
  const used = await tokensUsed(env, taskId);
  if (used.task + MIN_USEFUL > limit.task) throw new AIError(`Task token budget reached (${used.task}/${limit.task})`, { kind: 'budget' });
  if (used.daily + MIN_USEFUL > limit.daily) throw new AIError(`Daily token budget reached (${used.daily}/${limit.daily})`, { kind: 'budget' });
  return { remaining: Math.min(limit.task - used.task, limit.daily - used.daily) };
}

export async function logExecution(env, e) {
  await env.DB.prepare(`INSERT INTO agent_execution_logs
      (task_id,agent_task_id,agent,provider,model,attempt,outcome,error_kind,input_tokens,output_tokens,duration_ms,prompt_version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(e.taskId, e.agentTaskId, e.agent, e.provider, e.model, e.attempt, e.outcome, e.errorKind ?? null,
      e.usage?.inputTokens ?? 0, e.usage?.outputTokens ?? 0, e.durationMs ?? null, e.promptVersion ?? null).run();
}
