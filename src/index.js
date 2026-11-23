// HTTP entry (Telegram webhook, GitHub job callbacks) and Cloudflare Queues entry.
// The webhook only validates, records and enqueues; AI calls and GitHub dispatch run from the queue.
import { clamp, safeTaskId } from './helpers.js';
import { addArtifact, audit } from './db.js';
import { reply, tgForm } from './telegram.js';
import { markPromoted, promoOf } from './marketing/promo.js';
import { posterOf } from './marketing/poster.js';
import { T } from './i18n.js';
import { advance } from './orchestration/engine.js';
import { deployShaOf, prReviewText } from './orchestration/github.js';
import { handleCallback, handleMessage } from './commands.js';
import { handleQueueBatch } from './orchestration/queue-consumer.js';
import { pollBookRequests } from './books/requests.js';
import { pollTopups } from './website/topups.js';
import { pollUsers } from './website/users.js';
import { pollPurchases } from './website/purchases.js';
import { pollRecommend } from './marketing/recommend.js';

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
async function getJob(env, id, request) {
  const job = await env.DB.prepare('SELECT id,request_text,task_type,status FROM tasks WHERE id=?').bind(id).first();
  if (!job) return json({ error: 'not found' }, 404);
  if (!['queued', 'dispatching', 'running'].includes(job.status)) return json({ error: 'not queued' }, 409);
  // Deploy jobs verify they were dispatched for the approved commit.
  const deploy = await env.DB.prepare("SELECT input FROM agent_tasks WHERE task_id=? AND action='deploy_job' AND status='running'").bind(id).first();
  if (deploy) return json({ ...job, deploy_sha: deployShaOf(deploy) });
  // Promo jobs get the approved script (the same artifact the approval is bound to) and the voice.
  if (job.task_type === 'book_promo') {
    // An old runner on main would render an empty video from the new script format.
    if (Number(request.headers.get('X-Runner-Version') || 0) < 2) return json({ error: 'runner out of date: merge the latest code into main' }, 409);
    const promo = await promoOf(env, id);
    const voice = /^km-KH-[A-Za-z]+Neural$/.test(env.PROMO_VOICE || '') ? env.PROMO_VOICE : 'km-KH-SreymomNeural';
    return json({ ...job, videos: (promo?.videos || []).slice(0, 1).map(v => ({ scenes: v.scenes, covers: v.covers || [], voice })) });
  }
  // Poster jobs get the approved poster text; they need the runner with the poster renderer (v3).
  if (job.task_type === 'poster') {
    if (Number(request.headers.get('X-Runner-Version') || 0) < 3) return json({ error: 'runner out of date: merge the latest code into main' }, 409);
    const p = await posterOf(env, id);
    return json({ ...job, posters: (p?.posters || []).slice(0, 1).map(x => ({ headline: x.headline, subline: x.subline, points: x.points, cta: x.cta, covers: x.covers || [] })) });
  }
  return json(job);
}

// Media jobs upload the finished file; the Worker forwards it to the owner with its caption.
// book_promo: MP4 video (sendVideo). poster: PNG sent as a file (sendDocument) so it keeps full quality.
const MEDIA_OUT = {
  book_promo: { max: 48 * 1024 * 1024, mime: 'video/mp4', method: 'sendVideo', field: 'video', name: 'booksharekh-promo.mp4',
    item: async (env, id, i) => (await promoOf(env, id))?.videos?.[i], heading: (env, v, req) => T.promoVideo(env, v, new URL(req.url).searchParams.get('voiced') === '0' ? false : undefined) },
  poster: { max: 10 * 1024 * 1024, mime: 'image/png', method: 'sendDocument', field: 'document', name: 'booksharekh-poster.png',
    item: async (env, id, i) => (await posterOf(env, id))?.posters?.[i], heading: (env, p) => T.posterImage(env, p) },
};
async function receiveMedia(request, env, taskId, index, type) {
  const out = MEDIA_OUT[type];
  const task = await env.DB.prepare("SELECT id,telegram_user_id,task_type,status FROM tasks WHERE id=?").bind(taskId).first();
  if (!task || task.task_type !== type || task.status !== 'running') return json({ error: 'not a running task of this kind' }, 409);
  const v = await out.item(env, taskId, index);
  if (!v) return json({ error: 'bad index' }, 400);
  if (Number(request.headers.get('content-length') || 0) > out.max) return json({ error: 'file too large' }, 413);
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > out.max) return json({ error: 'empty or too large' }, 413);
  // Each file is sent once, even if the runner retries the upload.
  const key = `promo_sent:${taskId}:${index}`;
  const claimed = await env.DB.prepare("INSERT OR IGNORE INTO settings (key,value,updated_at) VALUES (?, 'sent', CURRENT_TIMESTAMP)").bind(key).run();
  if (claimed.meta?.changes !== 1) return json({ ok: true, duplicate: true });
  const chat = Number(task.telegram_user_id);
  const form = new FormData();
  form.set('chat_id', String(chat));
  form.set('caption', clamp(out.heading(env, v, request), 1000));
  if (type === 'book_promo') form.set('supports_streaming', 'true');
  form.set(out.field, new Blob([bytes], { type: out.mime }), out.name);
  try {
    await tgForm(env, out.method, form);
    await reply(env, chat, v.caption); // caption alone: easy to copy into TikTok / Facebook / Instagram
  } catch (e) {
    await env.DB.prepare('DELETE FROM settings WHERE key=?').bind(key).run();
    throw e;
  }
  await markPromoted(env, v.cover_ids || []);
  await audit(env, taskId, type === 'poster' ? 'POSTER_SENT' : 'PROMO_VIDEO_SENT', 'github-actions', `${clamp(v.title, 80)} ${bytes.byteLength} bytes`);
  return json({ ok: true });
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
  if (MEDIA_OUT[row.task_type]) {
    // Report success only if the file really arrived (an outdated runner on main would send none).
    const got = await env.DB.prepare("SELECT COUNT(*) n FROM settings WHERE key LIKE ?").bind(`promo_sent:${data.task_id}:%`).first();
    const ok = state === 'completed' && got.n > 0;
    const done = row.task_type === 'poster' ? T.posterDone : T.promoDone;
    await reply(env, Number(row.telegram_user_id), done(env, ok, ok ? '' : state === 'completed'
      ? 'nothing was received: the GitHub job on main is out of date (merge the latest code into main)' : clamp(data.note, 300)));
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
      const vm = /^\/job-(video|image)\/([^/]+)\/(\d)$/.exec(u.pathname);
      if (vm && request.method === 'POST') {
        if (!authorizedJob(request, env)) return json({ error: 'unauthorized' }, 401);
        return safeTaskId(vm[2]) ? await receiveMedia(request, env, vm[2], Number(vm[3]), vm[1] === 'image' ? 'poster' : 'book_promo') : json({ error: 'bad id' }, 400);
      }
      if (u.pathname.startsWith('/job/') && request.method === 'GET') {
        if (!authorizedJob(request, env)) return json({ error: 'unauthorized' }, 401);
        const id = u.pathname.slice(5);
        return safeTaskId(id) ? await getJob(env, id, request) : json({ error: 'bad id' }, 400);
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
    try { await pollTopups(env); } catch (e) { console.error('top-up poll failed', String(e)); }
    try { await pollUsers(env); } catch (e) { console.error('user activity poll failed', String(e)); }
    try { await pollPurchases(env); } catch (e) { console.error('purchase poll failed', String(e)); }
    try { await pollRecommend(env, new Date(event?.scheduledTime || Date.now())); } catch (e) { console.error('book recommendations failed', String(e)); }
    try { await pollBookRequests(env); } catch (e) { console.error('book request poll failed', String(e)); }
  },
};
