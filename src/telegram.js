import { clamp } from './helpers.js';
import { T } from './i18n.js';

const HTTP_TIMEOUT_MS = 15000;

// Every message is silent (no sound or vibration) unless the caller passes disable_notification: false.
// Owner request: only the top-up alert (money waiting for approval) makes a sound.
const SEND = /^send[A-Z]/;

// Telegram limits bursts to one chat (e.g. file + caption + "done" in one second) with HTTP 429 and
// parameters.retry_after. Wait and try once more when the wait is short.
const MAX_WAIT_S = 10;
const sleep = s => new Promise(r => setTimeout(r, s * 1000));
async function send(env, method, init, timeout) {
  for (let tries = 0; ; tries++) {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { ...init, signal: AbortSignal.timeout(timeout) });
    const body = await r.json().catch(() => null);
    if (r.ok && body?.ok) return body;
    const wait = Number(body?.parameters?.retry_after);
    if (r.status === 429 && tries === 0 && wait >= 0 && wait <= MAX_WAIT_S) { await sleep(wait + 0.2); continue; }
    throw new Error(`Telegram ${method} failed (${r.status})`);
  }
}

export async function tg(env, method, data) {
  if (SEND.test(method) && data.disable_notification === undefined) data = { ...data, disable_notification: true };
  return send(env, method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }, HTTP_TIMEOUT_MS);
}
// Multipart upload (sendPhoto / sendVideo / sendDocument with file bytes).
export async function tgForm(env, method, form) {
  if (SEND.test(method) && !form.has('disable_notification')) form.set('disable_notification', 'true');
  return send(env, method, { method: 'POST', body: form }, 30000);
}
export const reply =(env, chat_id, text, more = {}) => tg(env, 'sendMessage', { chat_id, text: clamp(text, 3900), ...more });
// Owners use private chats, where chat id = user id.
export const notifyTaskOwner = (env, task, text, more = {}) => reply(env, Number(task.telegram_user_id), text, more);
export const notifyOwner = (env, text, more = {}) => reply(env, Number(env.OWNER_TELEGRAM_ID), text, more);

// ---------- clean chat (owner request) ----------
// Progress and approval messages of a task are remembered; when the task's final result is sent they
// are deleted, so the chat keeps only the result. A tapped approval message is deleted right away.
// Cleanup never blocks or fails the work: Telegram/D1 errors are ignored.
const TRAIL = 'tg_trail:';
const trailPrefix = taskId => `${TRAIL}${taskId}:`;

export async function trackMessage(env, taskId, sent) {
  const m = sent?.result;
  if (!taskId || !m?.message_id || !m.chat?.id) return;
  await env.DB.prepare("INSERT OR IGNORE INTO settings (key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)")
    .bind(`${trailPrefix(taskId)}${m.chat.id}:${m.message_id}`, 'sent').run().catch(() => {});
}

export async function clearTrail(env, taskId) {
  if (!taskId) return;
  try {
    const rows = (await env.DB.prepare('SELECT key FROM settings WHERE key LIKE ?').bind(`${trailPrefix(taskId)}%`).all()).results || [];
    const byChat = new Map();
    for (const { key } of rows) {
      const [chat, id] = key.slice(trailPrefix(taskId).length).split(':').map(Number);
      if (chat && id) byChat.set(chat, [...(byChat.get(chat) || []), id]);
    }
    for (const [chat_id, ids] of byChat) {
      for (let i = 0; i < ids.length; i += 100) await tg(env, 'deleteMessages', { chat_id, message_ids: ids.slice(i, i + 100) }).catch(() => {});
    }
    await env.DB.prepare('DELETE FROM settings WHERE key LIKE ?').bind(`${trailPrefix(taskId)}%`).run();
    // Remember when the result was sent (see dropIfFinished); old marks are pruned.
    await env.DB.prepare(`INSERT INTO settings (key,value,updated_at) VALUES (?, 'final', CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET updated_at=CURRENT_TIMESTAMP`).bind(`${FINAL}${taskId}`).run();
    await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'tg_final:%' AND updated_at < datetime('now','-1 day')").run();
  } catch (e) { console.error('clear trail failed', String(e)); }
}

// A fast step (publish a book, merge a PR) can finish and send its result before the "✅ running…"
// note of the approval tap is sent. That late note is removed at once instead of staying under the result.
const FINAL = 'tg_final:';
export async function dropIfFinished(env, taskId, sent) {
  const m = sent?.result;
  if (!taskId || !m?.message_id) return;
  try {
    const done = await env.DB.prepare("SELECT 1 FROM settings WHERE key=? AND updated_at >= datetime('now','-5 minutes')").bind(`${FINAL}${taskId}`).first();
    if (!done) return;
    await removeMessage(env, m);
    await env.DB.prepare('DELETE FROM settings WHERE key=?').bind(`${trailPrefix(taskId)}${m.chat.id}:${m.message_id}`).run();
  } catch (e) { console.error('drop late note failed', String(e)); }
}

// Delete one message (e.g. the approval whose button was tapped). Telegram refuses deletes of messages
// older than 48 hours: then at least remove its buttons.
export async function removeMessage(env, message) {
  if (!message?.message_id || !message.chat?.id) return;
  const at = { chat_id: message.chat.id, message_id: message.message_id };
  await tg(env, 'deleteMessage', at).catch(() => tg(env, 'editMessageReplyMarkup', { ...at, reply_markup: { inline_keyboard: [] } }).catch(() => {}));
}

// A task message. Progress (default) is remembered and removed later; final: true sends the result and
// then removes the task's earlier messages.
export async function taskReply(env, chat, taskId, text, { final = false, ...more } = {}) {
  const sent = await reply(env, chat, text, more);
  if (final) await clearTrail(env, taskId); else await trackMessage(env, taskId, sent);
  return sent;
}
export const notifyTaskProgress = (env, task, text, more = {}) => taskReply(env, Number(task.telegram_user_id), task.id, text, more);
export const notifyTaskResult = (env, task, text, more = {}) => taskReply(env, Number(task.telegram_user_id), task.id, text, { ...more, final: true });

export const keyboards = {
  approval: (approvalId, taskId, env) => {
    const b = T.buttons(env);
    return { inline_keyboard: [
      [{ text: b.approve, callback_data: `ap:${approvalId}` }, { text: b.reject, callback_data: `rj:${approvalId}` }],
      [{ text: b.cancel, callback_data: `cx:${taskId}` }],
    ] };
  },
};
