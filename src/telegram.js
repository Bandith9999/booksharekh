import { clamp } from './helpers.js';
import { T } from './i18n.js';

const HTTP_TIMEOUT_MS = 15000;

export async function tg(env, method, data) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const body = await r.json().catch(() => null);
  if (!r.ok || !body?.ok) throw new Error(`Telegram ${method} failed (${r.status})`);
  return body;
}
export const reply = (env, chat_id, text, more = {}) => tg(env, 'sendMessage', { chat_id, text: clamp(text, 3900), ...more });
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
