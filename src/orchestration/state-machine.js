// Deterministic status transitions. Every status change goes through transition(), which applies it
// atomically in SQL only when the current status is an allowed source; concurrent or repeated
// requests (double taps, queue redelivery) therefore change a row at most once.

// Owner-facing tasks (`tasks`). 'pending', 'dispatching' and 'dispatch_failed' are Phase 1 states kept
// so existing rows stay valid: 'pending' means awaiting approval.
// 'paused' = a daily AI quota or budget ran out; the owner resumes with /resume (never auto-switched to paid AI).
export const TASK = {
  planning: ['awaiting_approval', 'queued', 'paused', 'plan_failed', 'failed', 'cancelled'],
  pending: ['queued', 'rejected', 'cancelled'],
  awaiting_approval: ['queued', 'rejected', 'cancelled', 'failed'],
  queued: ['running', 'paused', 'completed', 'failed', 'cancelled'],
  dispatching: ['queued', 'running', 'dispatch_failed', 'completed', 'failed'],
  running: ['qa_review', 'awaiting_approval', 'paused', 'completed', 'failed', 'revision_required'],
  paused: ['planning', 'queued', 'running', 'cancelled', 'failed'],
  qa_review: ['completed', 'revision_required', 'awaiting_approval', 'failed'],
  revision_required: ['planning', 'queued', 'cancelled', 'failed'],
  completed: [], failed: [], cancelled: [], rejected: [], plan_failed: [], dispatch_failed: [],
};

// Agent steps (`agent_tasks`). running -> queued is a retry.
export const AGENT_TASK = {
  pending: ['queued', 'awaiting_approval', 'cancelled', 'failed'],
  awaiting_approval: ['queued', 'rejected', 'cancelled', 'failed'],
  queued: ['running', 'cancelled', 'failed'],
  running: ['queued', 'completed', 'failed', 'qa_review', 'cancelled', 'paused'],
  paused: ['queued', 'cancelled', 'failed'],
  qa_review: ['completed', 'revision_required', 'failed'],
  revision_required: ['queued', 'cancelled', 'failed'],
  completed: [], failed: [], cancelled: [], rejected: [],
};

const MACHINES = { tasks: TASK, agent_tasks: AGENT_TASK };

export const canTransition = (machine, from, to) => Boolean(machine[from]?.includes(to));
export const isTerminal = (machine, status) => (machine[status] ?? []).length === 0;
export const sourcesFor = (machine, to) => Object.keys(machine).filter(s => machine[s].includes(to));

// Returns true when this call changed the row. `set` adds columns, e.g. { error: 'x', finished_at: SQL_NOW }.
export const SQL_NOW = Symbol('CURRENT_TIMESTAMP');
export async function transition(db, table, id, to, { set = {}, from = null } = {}) {
  const machine = MACHINES[table];
  if (!machine) throw new Error(`No state machine for ${table}`);
  let sources = sourcesFor(machine, to);
  if (from) sources = sources.filter(s => from.includes(s));
  if (!sources.length) throw new Error(`Invalid transition to ${to} in ${table}`);
  const cols = Object.keys(set);
  if (cols.some(c => !/^[a-z_]+$/.test(c))) throw new Error('Invalid column name');
  const extra = cols.map(c => `, ${c}=${set[c] === SQL_NOW ? 'CURRENT_TIMESTAMP' : '?'}`).join('');
  const args = cols.filter(c => set[c] !== SQL_NOW).map(c => set[c]);
  const r = await db.prepare(`UPDATE ${table} SET status=?, updated_at=CURRENT_TIMESTAMP${extra} WHERE id=? AND status IN (${sources.map(() => '?').join(',')})`)
    .bind(to, ...args, id, ...sources).run();
  return r.meta?.changes === 1;
}
