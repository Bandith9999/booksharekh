// Cloudflare Queues consumer for the main queue and its dead-letter queue.
// Delivery is at-least-once, so runAgentTask() claims each step atomically before doing work.
// Website Operations messages: ops_run (one inspection) and ops_apply (apply approved corrections).
import { backoffSeconds } from '../helpers.js';
import { handleDeadLetter, runAgentTask } from './engine.js';

const isStep = b => b && b.v === 1 && b.type === 'run_agent_task' && /^AT-[a-f0-9-]{36}$/.test(String(b.agentTaskId));
const isOps = b => b && b.v === 1 && (b.type === 'ops_apply' || (b.type === 'ops_run' && ['schedule', 'manual'].includes(b.trigger)));

async function handleOps(env, m, deadLetter) {
  if (deadLetter) { console.error('ops message reached the dead-letter queue', m.body.type); m.ack(); return; }
  if (m.body.type === 'ops_run') {
    const { runInspection } = await import('../ops/run.js');
    await runInspection(env, { trigger: m.body.trigger }); // never retried: a failed run is recorded and reported
    m.ack();
    return;
  }
  const { executeApproved } = await import('../ops/execute.js');
  const r = await executeApproved(env);
  if (r.retry) m.retry({ delaySeconds: backoffSeconds(m.attempts) });
  else m.ack();
}

export async function handleQueueBatch(batch, env) {
  const deadLetter = /-dlq$/.test(batch.queue);
  for (const m of batch.messages) {
    if (!isStep(m.body) && !isOps(m.body)) { console.error('discarding invalid queue message'); m.ack(); continue; }
    try {
      if (isOps(m.body)) { await handleOps(env, m, deadLetter); continue; }
      if (deadLetter) {
        await handleDeadLetter(env, m.body.agentTaskId);
        m.ack();
        continue;
      }
      const r = await runAgentTask(env, m.body.agentTaskId);
      if (r?.retryDelay != null) m.retry({ delaySeconds: r.retryDelay });
      else m.ack();
    } catch (e) {
      // Unexpected error (e.g. D1 unavailable): let the queue retry, then dead-letter.
      console.error('queue message error', String(e));
      m.retry({ delaySeconds: backoffSeconds(m.attempts) });
    }
  }
}
