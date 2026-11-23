import { clamp } from './helpers.js';
import { T } from './i18n.js';

const HTTP_TIMEOUT_MS = 15000;

// Every message is silent (no sound or vibration) unless the caller passes disable_notification: false.
// Owner request: only the top-up alert (money waiting for approval) makes a sound.
const SEND = /^send[A-Z]/;

export async function tg(env, method, data) {
  if (SEND.test(method) && data.disable_notification === undefined) data = { ...data, disable_notification: true };
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const body = await r.json().catch(() => null);
  if (!r.ok || !body?.ok) throw new Error(`Telegram ${method} failed (${r.status})`);
  return body;
}
// Multipart upload (sendPhoto with image bytes).
export async function tgForm(env, method, form) {
  if (SEND.test(method) && !form.has('disable_notification')) form.set('disable_notification', 'true');
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
  const body = await r.json().catch(() => null);
  if (!r.ok || !body?.ok) throw new Error(`Telegram ${method} failed (${r.status})`);
  return body;
}
export const reply =(env, chat_id, text, more = {}) => tg(env, 'sendMessage', { chat_id, text: clamp(text, 3900), ...more });
// Owners use private chats, where chat id = user id.
export const notifyTaskOwner = (env, task, text, more = {}) => reply(env, Number(task.telegram_user_id), text, more);
export const notifyOwner = (env, text, more = {}) => reply(env, Number(env.OWNER_TELEGRAM_ID), text, more);

export const keyboards = {
  approval: (approvalId, taskId, env) => {
    const b = T.buttons(env);
    return { inline_keyboard: [
      [{ text: b.approve, callback_data: `ap:${approvalId}` }, { text: b.reject, callback_data: `rj:${approvalId}` }],
      [{ text: b.cancel, callback_data: `cx:${taskId}` }],
    ] };
  },
};
