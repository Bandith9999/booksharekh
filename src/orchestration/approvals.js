// Owner approvals. Each approval covers one task, one agent step, one action type and the exact
// proposed payload (stored with its SHA-256). Execution re-computes the payload and refuses to run
// if it differs, so an approval can never be reused for a changed action.
import { canonical, sha256Hex } from '../helpers.js';
import { newId } from '../db.js';

const DEFAULT_TTL_HOURS = 24;

// Returns { id } or null when an open approval already exists for this step (idempotent).
export async function requestApproval(env, { task, agentTaskId, actionType, payload }) {
  const id = newId('APR');
  const body = canonical(payload);
  const ttl = Math.min(Math.max(Number(env.APPROVAL_TTL_HOURS) || DEFAULT_TTL_HOURS, 1), 168);
  const r = await env.DB.prepare(`INSERT OR IGNORE INTO task_approvals
      (id,task_id,agent_task_id,action_type,payload,payload_hash,owner_id,expires_at)
      VALUES (?,?,?,?,?,?,?,datetime('now', ?))`)
    .bind(id, task.id, agentTaskId, actionType, body, await sha256Hex(body), String(task.telegram_user_id), `+${ttl} hours`).run();
  return r.meta?.changes === 1 ? { id, ttlHours: ttl } : null;
}

export const getApproval = (env, id) => env.DB.prepare('SELECT * FROM task_approvals WHERE id=?').bind(id).first();

// Atomic owner decision. Only the task's owner, only while 'requested' and unexpired.
export async function decide(env, approvalId, userId, decision) {
  if (!['approved', 'rejected'].includes(decision)) throw new Error('bad decision');
  const r = await env.DB.prepare(`UPDATE task_approvals SET status=?, decided_by=?, decided_at=CURRENT_TIMESTAMP
      WHERE id=? AND owner_id=? AND status='requested' AND expires_at > CURRENT_TIMESTAMP`)
    .bind(decision, String(userId), approvalId, String(userId)).run();
  const row = await getApproval(env, approvalId);
  if (r.meta?.changes === 1) return { ok: true, approval: row };
  if (!row || row.owner_id !== String(userId)) return { ok: false, reason: 'not_found' };
  if (row.status === 'requested') {
    await env.DB.prepare("UPDATE task_approvals SET status='expired' WHERE id=? AND status='requested'").bind(approvalId).run();
    return { ok: false, reason: 'expired', approval: row };
  }
  return { ok: false, reason: `already_${row.status}`, approval: row };
}

// Called right before execution: the action about to run must hash to what the owner approved.
export async function consumeApproval(env, approvalId, payload) {
  const hash = await sha256Hex(canonical(payload));
  const r = await env.DB.prepare("UPDATE task_approvals SET status='executing' WHERE id=? AND status='approved' AND payload_hash=?")
    .bind(approvalId, hash).run();
  if (r.meta?.changes === 1) return { ok: true };
  const row = await getApproval(env, approvalId);
  if (row?.status === 'approved') {
    await env.DB.prepare("UPDATE task_approvals SET status='revoked' WHERE id=? AND status='approved'").bind(approvalId).run();
    return { ok: false, reason: 'payload_changed' };
  }
  return { ok: false, reason: `status_${row?.status ?? 'missing'}` };
}

// For a step about to execute: find its approval and consume it against the exact payload.
// An approval already 'executing' means a redelivered message after a crash; the caller's
// operations must be idempotent (they are: idempotency keys and server-side checks).
export async function consumeStepApproval(env, agentTaskId, payload) {
  const ap = await env.DB.prepare(`SELECT * FROM task_approvals WHERE agent_task_id=? AND status IN ('approved','executing')
      ORDER BY requested_at DESC LIMIT 1`).bind(agentTaskId).first();
  if (!ap) throw new Error('No valid owner approval for this step');
  if (ap.status === 'approved') {
    const c = await consumeApproval(env, ap.id, payload);
    if (!c.ok) throw new Error(c.reason === 'payload_changed'
      ? 'The action changed after it was approved, so the approval no longer applies.'
      : `Approval cannot be used (${c.reason}).`);
  }
  return ap;
}

export async function finishApproval(env, approvalId, succeeded) {
  await env.DB.prepare("UPDATE task_approvals SET status=?, executed_at=CURRENT_TIMESTAMP WHERE id=? AND status='executing'")
    .bind(succeeded ? 'executed' : 'failed', approvalId).run();
}
// A retryable execution error returns the approval to 'approved' so the retry can consume it again.
export async function releaseApproval(env, approvalId) {
  await env.DB.prepare("UPDATE task_approvals SET status='approved' WHERE id=? AND status='executing'").bind(approvalId).run();
}
export async function revokeOpenApprovals(env, taskId) {
  await env.DB.prepare("UPDATE task_approvals SET status='revoked' WHERE task_id=? AND status IN ('requested','approved')").bind(taskId).run();
}
