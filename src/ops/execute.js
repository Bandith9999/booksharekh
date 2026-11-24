// Website Operations: apply owner-approved corrections, verify them, report, and roll back on request.
// The website checks every change against the value the owner saw (no change if the record moved on),
// runs the batch in one transaction, ignores a repeated approval id, and re-reads every value.
import { clamp, sha256Hex } from '../helpers.js';
import { audit } from '../db.js';
import { WebsiteApiError, opsApply, opsRollback } from '../website/laravel-api.js';
import { sendCompletion } from './telegram.js';

const MAX_ATTEMPTS = 3, MAX_BATCH = 50;
export const executeMessage = () => ({ v: 1, type: 'ops_apply' });

// Claim the approved findings (approved → executing) so two consumers never apply the same change.
async function claim(env) {
  const rows = (await env.DB.prepare("SELECT id, op FROM ops_findings WHERE status='approved' AND op IS NOT NULL ORDER BY id LIMIT ?").bind(MAX_BATCH).all()).results || [];
  if (!rows.length) return { batchId: null, rows: [] };
  const batchId = `OPS-${(await sha256Hex(rows.map(r => r.id).join(',') + Date.now())).slice(0, 20)}`;
  const claimed = [];
  for (const r of rows) {
    const ok = await env.DB.prepare("UPDATE ops_findings SET status='executing', batch_id=?, attempts=attempts+1 WHERE id=? AND status='approved' RETURNING id, op, attempts")
      .bind(batchId, r.id).first();
    if (ok) claimed.push({ id: ok.id, op: JSON.parse(ok.op), attempts: ok.attempts });
  }
  return { batchId, rows: claimed };
}

const mark = (env, id, status, extra = {}) => env.DB.prepare(`UPDATE ops_findings SET status=?, error=?, batch_id=COALESCE(?, batch_id),
    applied_at=CASE WHEN ?='applied' THEN CURRENT_TIMESTAMP ELSE applied_at END WHERE id=?`)
  .bind(status, extra.error ? clamp(extra.error, 300) : null, extra.batchId ?? null, status, id).run();

// Returns { applied, failed, conflicts, retry } — retry=true lets the queue try again later.
export async function executeApproved(env) {
  const { batchId, rows } = await claim(env);
  if (!rows.length) return { applied: 0, failed: 0, conflicts: 0 };
  let res;
  try {
    res = await opsApply(env, batchId, rows.map(r => r.op));
  } catch (e) {
    // Network or server trouble: back to approved (bounded attempts), then failed.
    const retry = !(e instanceof WebsiteApiError) || e.retryable;
    for (const r of rows) await mark(env, r.id, retry && r.attempts < MAX_ATTEMPTS ? 'approved' : 'failed', { error: e.message });
    if (!(retry && rows.every(r => r.attempts < MAX_ATTEMPTS))) await report(env, batchId, 0, rows.length, rows.length, false, e.message);
    return { applied: 0, failed: rows.length, conflicts: 0, retry: retry && rows.some(r => r.attempts < MAX_ATTEMPTS) };
  }
  if (res.status === 'applied') {
    for (const r of rows) await mark(env, r.id, 'applied', { batchId });
    const verified = (res.changes || []).length === rows.length;
    await audit(env, null, 'OPS_APPLIED', 'system', `${batchId}: ${rows.length} change(s), verified=${verified}${res.duplicate ? ' (already applied)' : ''}`);
    await report(env, batchId, rows.length, 0, rows.length, verified);
    return { applied: rows.length, failed: 0, conflicts: 0 };
  }
  // conflict / invalid: nothing was written. Records that changed are stale (the next inspection
  // proposes again from the new values); the rest are applied one by one to isolate the problem.
  const bad = new Set((res.conflicts || []).map(c => c.index));
  let applied = 0, failed = 0;
  for (const [i, r] of rows.entries()) {
    if (bad.has(i)) { await mark(env, r.id, 'stale', { error: 'record changed after approval' }); failed++; continue; }
    const one = await opsApply(env, `${batchId}-${i}`, [r.op]).catch(e => ({ status: 'error', error: e.message }));
    if (one.status === 'applied') { await mark(env, r.id, 'applied', { batchId: `${batchId}-${i}` }); applied++; }
    else { await mark(env, r.id, one.status === 'conflict' ? 'stale' : 'failed', { error: one.error || one.status }); failed++; }
  }
  await audit(env, null, 'OPS_APPLIED', 'system', `${batchId}: ${applied} applied, ${failed} not applied (${res.status})`);
  await report(env, batchId, applied, failed, rows.length, true, res.status === 'invalid' ? res.error : 'some records changed after approval');
  return { applied, failed, conflicts: bad.size };
}

async function report(env, batchId, applied, failed, total, verified, note = '') {
  await sendCompletion(env, { batchId, applied, failed, total, verified, note }).catch(e => console.error('ops completion notice', String(e)));
}

// Undo one completed batch (and its one-by-one parts). Values changed since are left alone.
export async function rollbackBatch(env, batchId) {
  const refs = ((await env.DB.prepare("SELECT DISTINCT batch_id FROM ops_findings WHERE status='applied' AND (batch_id=? OR batch_id LIKE ?)")
    .bind(batchId, `${batchId}-%`).all()).results || []).map(r => r.batch_id);
  let undone = 0, conflicts = 0;
  for (const ref of refs) {
    const r = await opsRollback(env, ref);
    if (r.status === 'rolled_back') {
      const n = await env.DB.prepare("UPDATE ops_findings SET status='rolled_back' WHERE batch_id=? AND status='applied' RETURNING id").bind(ref).all();
      undone += (n.results || []).length;
    } else if (r.status === 'conflict') conflicts++;
  }
  await audit(env, null, 'OPS_ROLLBACK', 'owner', `${batchId}: ${undone} undone, ${conflicts} conflict(s)`);
  return { undone, conflicts };
}
