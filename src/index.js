// HTTP entry (Telegram webhook, GitHub job callbacks) and Cloudflare Queues entry.
// The webhook only validates, records and enqueues; AI calls and GitHub dispatch run from the queue.
import { clamp, safeTaskId } from './helpers.js';
import { addArtifact, audit } from './db.js';
import { reply } from './telegram.js';
import { T } from './i18n.js';
import { advance } from './orchestration/engine.js';
import { deployShaOf, prReviewText } from './orchestration/github.js';
import { handleCallback, handleMessage } from './commands.js';
import { handleQueueBatch } from './orchestration/queue-consumer.js';
import { pollBookRequests } from './books/requests.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

async function telegramWebhook(request, env) {
  if (!env.TELEGRAM_WEBHOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_WEBHOOK_SECRET) return new Response('Forbidden', { status: 403 });
  const upd = await request.json().catch(() => null);
  if (!Number.isSafeInteger(upd?.update_id)) return json({ ok: false }, 400);
  const claimed = await env.DB.prepare('INSERT OR IGNORE INTO telegram_updates (update_id) VALUES (?)').bind(upd.update_id).run();
  if (claimed.meta?.changes !== 1) return json({ ok: true, duplicate: true });
  try {
    if (upd.message) await handleMessage(env, upd.message);
    if (upd.callback_query) await handleCallback(env, upd.callback_query);
  } catch (e) {
    console.error('update processing error', String(e));
    // The update is already claimed, so a Telegram redelivery would be ignored. Tell the owner
    // instead, and answer 200 so Telegram stops retrying.
    await reply(env, Number(env.OWNER_TELEGRAM_ID), T.processingError(env, clamp(e?.message, 150))).catch(() => {});
    return json({ ok: false, error: 'processing error' });
  }
  return json({ ok: true });
}

function authorizedJob(request, env) {
  return Boolean(env.JOB_CALLBACK_SECRET && request.headers.get('Authorization') === `Bearer ${env.JOB_CALLBACK_SECRET}`);
}
async function getJob(env, id) {
  const job = await env.DB.prepare('SELECT id,request_text,task_type,status FROM tasks WHERE id=?').bind(id).first();
  if (!job) return json({ error: 'not found' }, 404);
  if (!['queued', 'dispatching', 'running'].includes(job.status)) return json({ error: 'not queued' }, 409);
  // Deploy jobs verify they were dispatched for the approved commit.
  const deploy = await env.DB.prepare("SELECT input FROM agent_tasks WHERE task_id=? AND action='deploy_job' AND status='running'").bind(id).first();
  return json(deploy ? { ...job, deploy_sha: deployShaOf(deploy) } : job);
}
async function finishJob(request, env) {
  const data = await request.json().catch(() => null);
  if (!data || !safeTaskId(data.task_id)) return json({ error: 'bad task' }, 400);
  const state = data.status === 'completed' ? 'completed' : 'failed';
  const url = String(data.run_url || '');
  if (url && !/^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/actions\/runs\/\d+$/.test(url)) return json({ error: 'bad URL' }, 400);
  const note = clamp(data.note, 500);
  // Laravel Developer jobs also report the pull request and its head commit.
  const prUrl = data.pr_url ? String(data.pr_url) : '';
  if (prUrl && !/^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/pull\/\d+$/.test(prUrl)) return json({ error: 'bad PR URL' }, 400);
  const headSha = data.head_sha ? String(data.head_sha) : '';
  if (headSha && !/^[0-9a-f]{40}$/.test(headSha)) return json({ error: 'bad commit SHA' }, 400);
  // A website change that opened a PR is not finished: it continues to the owner's merge approval.
  const current = await env.DB.prepare('SELECT task_type FROM tasks WHERE id=?').bind(data.task_id).first();
  const toMerge = current?.task_type === 'website_code_change' && state === 'completed' && prUrl && headSha;
  const deploying = await env.DB.prepare("SELECT id FROM agent_tasks WHERE task_id=? AND action='deploy_job' AND status='running'").bind(data.task_id).first();
  const deployedSha = /^[0-9a-f]{40}$/.test(String(data.deployed_sha || '')) ? String(data.deployed_sha) : '';
  const row = await env.DB.prepare(`UPDATE tasks SET status=?,result_url=?,result_note=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND status IN ('queued','dispatching','running') RETURNING telegram_user_id, task_type`)
    .bind(toMerge ? 'running' : state, url, note, data.task_id).first();
  if (!row) return json({ error: 'unknown or already completed task' }, 409);
  // Phase 2 bookkeeping; these match nothing for tasks created before Phase 2.
  await env.DB.prepare(`UPDATE agent_tasks SET status=?, output=?, error=?, finished_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
      WHERE task_id=? AND action LIKE '%_job' AND status='running'`)
    .bind(state, JSON.stringify({ run_url: url, note, pr_url: prUrl || undefined, head_sha: headSha || undefined }), state === 'failed' ? note : null, data.task_id).run();
  await env.DB.prepare("UPDATE workflow_runs SET status=?, run_url=?, updated_at=CURRENT_TIMESTAMP WHERE task_id=? AND status IN ('dispatched','unknown')")
    .bind(state, url || null, data.task_id).run();
  if (url) await addArtifact(env, { taskId: data.task_id, kind: 'github_run', uri: url, contentType: 'text/uri-list' });
  if (prUrl) await addArtifact(env, { taskId: data.task_id, kind: 'pull_request', uri: prUrl, content: JSON.stringify({ pr_url: prUrl, head_sha: headSha || null }) });
  await audit(env, data.task_id, 'JOB_' + state.toUpperCase(), 'github-actions', clamp(data.note, 250));
  if (state === 'failed') await env.DB.prepare("UPDATE agent_tasks SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE task_id=? AND status='pending'").bind(data.task_id).run();
  if (toMerge) {
    await env.DB.prepare('UPDATE tasks SET proposal=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(clamp(await prReviewText(env, prUrl, headSha, note), 3000), data.task_id).run();
    await advance(env, data.task_id); // sends the diff with Approve (merge) / Reject (close PR)
    return json({ ok: true });
  }
  if (deploying) {
    if (state === 'completed' && deployedSha) {
      await env.DB.prepare(`INSERT INTO settings (key,value,updated_at) VALUES ('last_deployed_sha',?,CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`).bind(deployedSha).run();
    }
    await reply(env, Number(row.telegram_user_id), T.deployDone(env, state === 'completed', clamp(data.note, 300), url));
    return json({ ok: true });
  }
  await reply(env, Number(row.telegram_user_id), T.jobDone(env, data.task_id, state, clamp(data.note, 300), url, row.task_type !== 'website_code_change', prUrl));
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const u = new URL(request.url);
    try {
      if (request.method === 'GET' && u.pathname === '/health') return json({ ok: true, service: 'booksharekh-ai-manager' });
      if (request.method === 'POST' && u.pathname === '/telegram') return await telegramWebhook(request, env);
      if (u.pathname.startsWith('/job/') && request.method === 'GET') {
        if (!authorizedJob(request, env)) return json({ error: 'unauthorized' }, 401);
        const id = u.pathname.slice(5);
        return safeTaskId(id) ? await getJob(env, id) : json({ error: 'bad id' }, 400);
      }
      if (request.method === 'POST' && u.pathname === '/job-result') {
        if (!authorizedJob(request, env)) return json({ error: 'unauthorized' }, 401);
        return await finishJob(request, env);
      }
      return json({ error: 'not found' }, 404);
    } catch (e) { console.error('Worker failure', String(e)); return json({ error: 'internal error' }, 500); }
  },
  async queue(batch, env) {
    await handleQueueBatch(batch, env);
  },
  // Cron trigger (wrangler.jsonc): announce new booksharekh.com book requests in Telegram.
  async scheduled(event, env) {
    try { await pollBookRequests(env); } catch (e) { console.error('book request poll failed', String(e)); }
  },
};
