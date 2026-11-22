// Workflow engine. A task (`tasks`) is the owner's request; its steps (`agent_tasks`) are assigned to
// agents and linked by `task_dependencies`. Steps whose dependencies are complete run in parallel;
// steps that need approval wait for the owner. All work runs from the queue, never in the webhook.
import { backoffSeconds, clamp, classifyTask } from '../helpers.js';
import { audit, getAgentOverride, getAgentTask, getTask, listAgentTasks, listDependencies, newId } from '../db.js';
import { DEMO_JOB_STEP, getAction, getAgent } from '../agents/registry.js';
import { runAIAction } from '../agents/runner.js';
import { keyboards, notifyTaskOwner } from '../telegram.js';
import { decide, requestApproval, revokeOpenApprovals } from './approvals.js';
import { jobPayload, runGithubJob } from './github.js';
import { SQL_NOW, TASK, isTerminal, transition } from './state-machine.js';

const notify = (env, task, text, more) => notifyTaskOwner(env, task, text, more).catch(e => console.error('notify failed', String(e)));

// ---------- queue ----------
export const stepMessage = agentTaskId => ({ v: 1, type: 'run_agent_task', agentTaskId });
export async function enqueueStep(env, agentTaskId) {
  if (!env.TASK_QUEUE) throw new Error('TASK_QUEUE binding missing: create the Cloudflare queues and deploy (see README)');
  await env.TASK_QUEUE.send(stepMessage(agentTaskId));
}

// ---------- scheduling (pure) ----------
const DEAD = new Set(['failed', 'cancelled', 'rejected']);
export function schedule(steps, deps) {
  const byId = new Map(steps.map(s => [s.id, s]));
  const runnable = [], blocked = [];
  for (const s of steps) {
    if (s.status !== 'pending') continue;
    const ds = deps.filter(d => d.agent_task_id === s.id).map(d => byId.get(d.depends_on_id));
    if (ds.some(d => !d || DEAD.has(d.status))) blocked.push(s);
    else if (ds.every(d => d.status === 'completed')) runnable.push(s);
  }
  return { runnable, blocked };
}

async function insertStep(env, { taskId, agent, action, status, dependsOn = [], input = {} }) {
  const override = await getAgentOverride(env, agent);
  const key = `${taskId}:${agent}:${action}`; // idempotency: one step per agent action per task
  const id = newId('AT');
  const r = await env.DB.prepare(`INSERT OR IGNORE INTO agent_tasks (id,task_id,agent,action,status,input,max_attempts,idempotency_key)
      VALUES (?,?,?,?,?,?,?,?)`).bind(id, taskId, agent, action, status, JSON.stringify(input), override?.max_attempts ?? getAgent(agent).maxAttempts, key).run();
  if (r.meta?.changes !== 1) return (await env.DB.prepare('SELECT id FROM agent_tasks WHERE idempotency_key=?').bind(key).first()).id;
  for (const dep of dependsOn) await env.DB.prepare('INSERT OR IGNORE INTO task_dependencies (agent_task_id,depends_on_id) VALUES (?,?)').bind(id, dep).run();
  return id;
}

// ---------- task lifecycle ----------
export async function createTask(env, { userId, description }) {
  const limit = Number(env.TASK_RATE_LIMIT_PER_HOUR) || 20;
  const recent = await env.DB.prepare("SELECT COUNT(*) n FROM tasks WHERE telegram_user_id=? AND created_at > datetime('now','-1 hour')").bind(String(userId)).first();
  if (recent.n >= limit) return { rateLimited: true, limit };

  const id = newId('BSK');
  const type = classifyTask(description);
  await env.DB.prepare('INSERT INTO tasks (id,telegram_user_id,request_text,task_type,proposal,status) VALUES (?,?,?,?,?,?)')
    .bind(id, String(userId), clamp(description, 2000), type, '(planning)', 'planning').run();
  const planId = await insertStep(env, { taskId: id, agent: 'manager', action: 'plan', status: 'queued' });
  const job = DEMO_JOB_STEP[type];
  await insertStep(env, { taskId: id, agent: job.agent, action: job.action, status: 'pending', dependsOn: [planId] });
  await audit(env, id, 'TASK_CREATED', userId, type);
  try {
    await enqueueStep(env, planId);
  } catch (e) {
    await failStep(env, await getTask(env, id), await getAgentTask(env, planId), e.message);
    return { id, type, failed: true };
  }
  return { id, type };
}

export async function advance(env, taskId) {
  const task = await getTask(env, taskId);
  if (!task || isTerminal(TASK, task.status)) return;
  const steps = await listAgentTasks(env, taskId);
  const { runnable, blocked } = schedule(steps, await listDependencies(env, taskId));
  for (const s of blocked) await transition(env.DB, 'agent_tasks', s.id, 'cancelled', { from: ['pending'] });
  for (const s of runnable) {
    const action = getAction(s.agent, s.action);
    if (action.requiresApproval) await requestStepApproval(env, task, s, action);
    else if (await transition(env.DB, 'agent_tasks', s.id, 'queued', { from: ['pending'] })) await enqueueStep(env, s.id);
  }
  const after = await listAgentTasks(env, taskId);
  if (after.length && after.every(s => s.status === 'completed')) await transition(env.DB, 'tasks', taskId, 'completed');
}

async function payloadFor(env, task, action) {
  if (action.kind === 'github_job') return jobPayload(env, task);
  throw new Error(`No approval payload for action kind ${action.kind}`);
}

async function requestStepApproval(env, task, step, action) {
  const req = await requestApproval(env, { task, agentTaskId: step.id, actionType: action.approvalAction, payload: await payloadFor(env, task, action) });
  if (!req) return; // already requested (e.g. queue redelivery)
  if (!await transition(env.DB, 'agent_tasks', step.id, 'awaiting_approval', { from: ['pending'] })) {
    await env.DB.prepare("UPDATE task_approvals SET status='revoked' WHERE id=?").bind(req.id).run();
    return;
  }
  await transition(env.DB, 'tasks', task.id, 'awaiting_approval');
  await audit(env, task.id, 'APPROVAL_REQUESTED', 'system', `${action.approvalAction} ${req.id}`);
  const fresh = await getTask(env, task.id);
  await notify(env, fresh, `Task ${task.id}\nType: ${task.task_type}\n\n${fresh.proposal}\n\nProposed action: ${action.description}\nApproval expires in ${req.ttlHours} h.`,
    { reply_markup: keyboards.approval(req.id, task.id) });
}

// ---------- step execution (queue consumer) ----------
export async function runAgentTask(env, agentTaskId) {
  // Claim: queued, or running with an expired lease (the previous consumer died mid-step).
  const claimed = await env.DB.prepare(`UPDATE agent_tasks SET status='running', attempts=attempts+1,
      started_at=COALESCE(started_at,CURRENT_TIMESTAMP), lease_until=datetime('now','+10 minutes'), updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND (status='queued' OR (status='running' AND lease_until < CURRENT_TIMESTAMP))`).bind(agentTaskId).run();
  if (claimed.meta?.changes !== 1) return { skipped: true };
  const at = await getAgentTask(env, agentTaskId);
  const task = await getTask(env, at.task_id);
  if (isTerminal(TASK, task.status)) {
    await transition(env.DB, 'agent_tasks', at.id, 'cancelled', { from: ['running'] });
    return { skipped: true };
  }
  try {
    const action = getAction(at.agent, at.action);
    if (action.kind === 'ai') {
      const result = await runAIAction(env, { task, agentTask: at, action });
      if (isTerminal(TASK, (await getTask(env, task.id)).status)) { // cancelled while the model was working
        await transition(env.DB, 'agent_tasks', at.id, 'cancelled', { from: ['running'] });
        return { skipped: true };
      }
      const output = action.onComplete ? await action.onComplete(env, { task, agentTask: at, result }) : (result.structuredOutput ?? result.content);
      await transition(env.DB, 'agent_tasks', at.id, 'completed', { from: ['running'], set: { output: JSON.stringify(output ?? null), error: null, finished_at: SQL_NOW } });
      await audit(env, task.id, 'STEP_COMPLETED', 'worker', `${at.agent}.${at.action} via ${result.provider}/${result.model}`);
      await advance(env, task.id);
    } else if (action.kind === 'github_job') {
      await runGithubJob(env, task, at);
    }
    return { ok: true };
  } catch (e) {
    return handleStepError(env, task, at, e);
  }
}

async function handleStepError(env, task, at, e) {
  const message = e?.message || String(e);
  if (e?.retryable && at.attempts < at.max_attempts &&
      await transition(env.DB, 'agent_tasks', at.id, 'queued', { from: ['running'], set: { error: clamp(message, 500) } })) {
    await audit(env, task.id, 'STEP_RETRY', 'worker', `${at.agent}.${at.action} attempt ${at.attempts}/${at.max_attempts}: ${message}`);
    return { retryDelay: backoffSeconds(at.attempts, e.retryAfter) };
  }
  await failStep(env, task, at, message);
  return { failed: true };
}

async function failStep(env, task, at, message) {
  await transition(env.DB, 'agent_tasks', at.id, 'failed', { set: { error: clamp(message, 500), finished_at: SQL_NOW } });
  const planning = at.action === 'plan';
  const note = { set: { result_note: clamp(message, 500) } };
  if (!(planning && await transition(env.DB, 'tasks', task.id, 'plan_failed', note))) await transition(env.DB, 'tasks', task.id, 'failed', note);
  await cancelOpenSteps(env, task.id);
  await revokeOpenApprovals(env, task.id);
  await audit(env, task.id, planning ? 'PLAN_FAILED' : 'STEP_FAILED', 'worker', `${at.agent}.${at.action}: ${message}`);
  await notify(env, task, planning
    ? `Task ${task.id}\nType: ${task.task_type}\n\n⚠️ AI planning failed: ${clamp(message, 400)}\n\nThis task cannot be approved or dispatched. Run /diag, fix the problem, then send the /task again.`
    : `⚠️ Task ${task.id} failed at ${at.agent}.${at.action}:\n${clamp(message, 400)}\n\nNo automatic retry.`);
}

const cancelOpenSteps = (env, taskId) => env.DB.prepare(`UPDATE agent_tasks SET status='cancelled', updated_at=CURRENT_TIMESTAMP
    WHERE task_id=? AND status IN ('pending','awaiting_approval','queued','revision_required')`).bind(taskId).run();

// Dead-letter queue: a step whose message failed past the queue's retry limit.
export async function handleDeadLetter(env, agentTaskId) {
  const at = await getAgentTask(env, agentTaskId);
  if (!at) return;
  const message = 'Processing failed repeatedly and reached the dead-letter queue. No further automatic retries.';
  await env.DB.prepare(`UPDATE agent_tasks SET status='failed', error=?, finished_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND status IN ('queued','running')`).bind(message, at.id).run();
  const task = await getTask(env, at.task_id);
  if (task && !isTerminal(TASK, task.status)) {
    await transition(env.DB, 'tasks', task.id, 'failed', { set: { result_note: message } });
    await cancelOpenSteps(env, task.id);
    await revokeOpenApprovals(env, task.id);
    await notify(env, task, `⚠️ Task ${task.id}: ${message}`);
  }
  await audit(env, at.task_id, 'DEAD_LETTER', 'queue', `${at.agent}.${at.action}`);
}

// ---------- owner decisions ----------
export async function approveStep(env, approvalId, userId) {
  const d = await decide(env, approvalId, userId, 'approved');
  if (!d.ok) return d;
  const ap = d.approval;
  if (!await transition(env.DB, 'agent_tasks', ap.agent_task_id, 'queued', { from: ['awaiting_approval'] })) {
    await env.DB.prepare("UPDATE task_approvals SET status='revoked' WHERE id=?").bind(ap.id).run();
    return { ok: false, reason: 'step_not_waiting' };
  }
  await transition(env.DB, 'tasks', ap.task_id, 'queued');
  await audit(env, ap.task_id, 'APPROVE', userId, `${ap.action_type} ${ap.id}`);
  try { await enqueueStep(env, ap.agent_task_id); }
  catch (e) {
    await failStep(env, await getTask(env, ap.task_id), await getAgentTask(env, ap.agent_task_id), e.message);
    return { ok: false, reason: 'enqueue_failed', approval: ap };
  }
  return { ok: true, approval: ap };
}

export async function rejectStep(env, approvalId, userId) {
  const d = await decide(env, approvalId, userId, 'rejected');
  if (!d.ok) return d;
  const ap = d.approval;
  await transition(env.DB, 'agent_tasks', ap.agent_task_id, 'rejected', { from: ['awaiting_approval'] });
  await transition(env.DB, 'tasks', ap.task_id, 'rejected');
  await cancelOpenSteps(env, ap.task_id);
  await audit(env, ap.task_id, 'REJECT', userId, `${ap.action_type} ${ap.id}`);
  return { ok: true, approval: ap };
}

// Phase 1 buttons (approve:/reject:<task id>) on tasks still in legacy 'pending'.
export async function legacyDecision(env, taskId, decision, userId) {
  const task = await getTask(env, taskId);
  if (!task || task.status !== 'pending' || task.telegram_user_id !== String(userId)) return { ok: false, reason: 'already_handled' };
  if (decision === 'reject') {
    if (!await transition(env.DB, 'tasks', taskId, 'rejected', { from: ['pending'] })) return { ok: false, reason: 'already_handled' };
    await audit(env, taskId, 'REJECT', userId, 'legacy');
    return { ok: true, approval: { task_id: taskId } };
  }
  // The owner approved the proposal shown in the Phase 1 message: bind an approval to it, then run it.
  const step = DEMO_JOB_STEP[task.task_type] || DEMO_JOB_STEP.report;
  const stepId = await insertStep(env, { taskId, agent: step.agent, action: step.action, status: 'awaiting_approval' });
  const action = getAction(step.agent, step.action);
  const req = await requestApproval(env, { task, agentTaskId: stepId, actionType: action.approvalAction, payload: await payloadFor(env, task, action) });
  if (!req) return { ok: false, reason: 'already_handled' };
  return approveStep(env, req.id, userId);
}

export async function cancelTask(env, taskId, userId) {
  const task = await getTask(env, taskId);
  if (!task || task.telegram_user_id !== String(userId)) return { ok: false, reason: 'not_found' };
  if (['running', 'dispatching'].includes(task.status)) return { ok: false, reason: 'running' };
  if (!await transition(env.DB, 'tasks', taskId, 'cancelled')) return { ok: false, reason: `status ${task.status}` };
  await cancelOpenSteps(env, taskId);
  await revokeOpenApprovals(env, taskId);
  await audit(env, taskId, 'CANCELLED', userId);
  return { ok: true };
}

