// Website Operations: findings in D1. The fingerprint (kind + record + exact change) makes every
// finding unique: an unchanged problem is not reported again, a decided one (rejected, applied,
// sent to the Developer) is not proposed again unless the evidence changes (new fingerprint).
import { sha256Hex } from '../helpers.js';

export const fingerprint = x => sha256Hex(JSON.stringify([x.kind, x.ref, x.op ?? null]));
const ACTIVE = "('open','approved','executing','revise')";

// Insert new findings; refresh the ones still seen; resolve open ones the run no longer sees.
// Returns { created: [...ids], seen }.
export async function saveFindings(env, runId, list) {
  const created = [];
  const seenFps = [];
  for (const x of list) {
    const fp = await fingerprint(x);
    seenFps.push(fp);
    const r = await env.DB.prepare(`INSERT INTO ops_findings (fingerprint,kind,area,ref,line,op,risk,safe,source,run_id,last_run_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(fingerprint) DO UPDATE SET last_run_id=excluded.last_run_id,
        status=CASE WHEN ops_findings.status IN ('resolved','stale') THEN 'open' ELSE ops_findings.status END
        RETURNING id, run_id`)
      .bind(fp, x.kind, x.area, x.ref ?? null, x.line, x.op ? JSON.stringify(x.op) : null, x.risk || 'low', x.safe ? 1 : 0, x.source || 'rule', runId, runId).first();
    if (r && Number(r.run_id) === Number(runId)) created.push(r.id);
  }
  // Open findings this run did not see any more are fixed (by someone, or the data changed).
  await env.DB.prepare(`UPDATE ops_findings SET status='resolved', decided_at=CURRENT_TIMESTAMP
      WHERE status IN ('open','revise') AND (last_run_id IS NULL OR last_run_id < ?) AND area <> 'dev'`).bind(runId).run();
  return { created, seen: seenFps.length };
}

export const getFinding = (env, id) => env.DB.prepare('SELECT * FROM ops_findings WHERE id=?').bind(id).first();

export async function listFindings(env, { area = null, status = 'open', limit = 8, offset = 0, withOp = null } = {}) {
  const where = ['status=?'];
  const args = [status];
  if (Array.isArray(area)) { where.push(`area IN (${area.map(() => '?').join(',')})`); args.push(...area); }
  else if (area) { where.push('area=?'); args.push(area); }
  if (withOp === true) where.push('op IS NOT NULL');
  if (withOp === false) where.push('op IS NULL');
  const rows = (await env.DB.prepare(`SELECT * FROM ops_findings WHERE ${where.join(' AND ')} ORDER BY risk='high' DESC, risk='medium' DESC, id LIMIT ? OFFSET ?`)
    .bind(...args, limit, offset).all()).results || [];
  const total = (await env.DB.prepare(`SELECT COUNT(*) n FROM ops_findings WHERE ${where.join(' AND ')}`).bind(...args).first()).n;
  return { rows, total: Number(total) };
}

// Owner decision on one finding: only from 'open' (or 'revise'), so a tap cannot be replayed.
export async function decideFinding(env, id, decision) {
  const to = { approve: 'approved', reject: 'rejected', revise: 'revise', assign: 'assigned' }[decision];
  const from = decision === 'approve' ? "('open')" : "('open','revise')";
  const r = await env.DB.prepare(`UPDATE ops_findings SET status=?, decided_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ${from}
      ${decision === 'approve' ? 'AND op IS NOT NULL' : ''} RETURNING *`).bind(to, id).first();
  return r || null;
}

// Safe batch: every open, non-destructive change marked safe (never report-only or developer items).
export async function approveSafe(env) {
  const r = await env.DB.prepare("UPDATE ops_findings SET status='approved', decided_at=CURRENT_TIMESTAMP WHERE status='open' AND safe=1 AND op IS NOT NULL RETURNING id").all();
  return (r.results || []).length;
}
export async function rejectAllProposals(env) {
  const r = await env.DB.prepare("UPDATE ops_findings SET status='rejected', decided_at=CURRENT_TIMESTAMP WHERE status='open' AND op IS NOT NULL RETURNING id").all();
  return (r.results || []).length;
}

export async function counts(env) {
  const rows = (await env.DB.prepare(`SELECT area, kind, status, op IS NOT NULL has_op, safe, COUNT(*) n FROM ops_findings
      WHERE status IN ${ACTIVE} GROUP BY area, kind, status, has_op, safe`).all()).results || [];
  const c = { pending: 0, safe: 0, approved: 0, reports: 0, dev: 0, byArea: {} };
  for (const r of rows) {
    const n = Number(r.n);
    if (r.status === 'open' && r.area === 'dev') c.dev += n;
    else if (r.status === 'open' && r.has_op) { c.pending += n; if (r.safe) c.safe += n; }
    else if (r.status === 'open') c.reports += n;
    if (r.status === 'approved') c.approved += n;
    if (r.status === 'open') c.byArea[r.area] = (c.byArea[r.area] || 0) + n;
  }
  return c;
}

// ---- cache for AI answers and link checks ----
export async function cacheGet(env, key, fp) {
  const r = await env.DB.prepare('SELECT fingerprint, value FROM ops_cache WHERE key=?').bind(key).first();
  return r && r.fingerprint === fp ? JSON.parse(r.value) : null;
}
export const cachePut = (env, key, fp, value) => env.DB.prepare(`INSERT INTO ops_cache (key,fingerprint,value,updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET fingerprint=excluded.fingerprint, value=excluded.value, updated_at=CURRENT_TIMESTAMP`).bind(key, fp, JSON.stringify(value)).run();
export const cacheDrop = (env, key) => env.DB.prepare('DELETE FROM ops_cache WHERE key=?').bind(key).run();
