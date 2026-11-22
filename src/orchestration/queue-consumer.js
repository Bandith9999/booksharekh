// Cloudflare Queues consumer for the main queue and its dead-letter queue.
// Delivery is at-least-once, so runAgentTask() claims each step atomically before doing work.
import { backoffSeconds } from '../helpers.js';
import { handleDeadLetter, runAgentTask } from './engine.js';

const isValid = b => b && b.v === 1 && b.type === 'run_agent_task' && /^AT-[a-f0-9-]{36}$/.test(String(b.agentTaskId));

export async function handleQueueBatch(batch, env) {
  const deadLetter = /-dlq$/.test(batch.queue);
  for (const m of batch.messages) {
    if (!isValid(m.body)) { console.error('discarding invalid queue message'); m.ack(); continue; }
    try {
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
