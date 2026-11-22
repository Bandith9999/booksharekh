// booksharekh.com top-ups -> Telegram (receipt photo + Approve/Reject) -> owner decision -> website API.
// Money: the owner decides every manual top-up. The Worker remembers exactly what was shown and sends
// that amount and transaction ID back; the site credits only if the record still matches and is pending.
import { clamp } from '../helpers.js';
import { audit } from '../db.js';
import { notifyOwner, tg, tgForm } from '../telegram.js';
import { T } from '../i18n.js';
import { WebsiteApiError, apiConfigured, approveTopup, listTopups, rejectTopup, topupImage } from './laravel-api.js';

const CURSOR = 'last_topup_id';
const shownKey = id => `topup_shown:${Number(id)}`;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // Telegram sendPhoto limit

const getSetting = async (env, key) => (await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first())?.value ?? null;
const setSetting = (env, key, value) => env.DB.prepare(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`).bind(key, String(value)).run();
const delSetting = (env, key) => env.DB.prepare('DELETE FROM settings WHERE key=?').bind(key).run();

// Only what the owner needs to decide; no email or contact data.
const clean = t => ({
  id: Number(t.id), user: clamp(t.user || '', 60), amount: String(t.amount), currency: clamp(t.currency || 'USD', 5),
  method: clamp(t.method || '', 20), transaction_id: t.transaction_id == null ? null : clamp(String(t.transaction_id), 100),
  notes: t.notes ? clamp(t.notes, 200) : '', has_image: Boolean(t.has_image),
});
const needsOwner = t => t.status === 'pending' && !t.auto_verified;

export const topupKeyboard = (id, env) => {
  const b = T.topupButtons(env);
  return { inline_keyboard: [[{ text: b.approve, callback_data: `ta:${Number(id)}` }, { text: b.reject, callback_data: `tr:${Number(id)}` }]] };
};

// Send one alert: receipt photo with caption + buttons; text only if there is no usable image.
export async function sendTopupAlert(env, raw) {
  const t = clean(raw);
  await setSetting(env, shownKey(t.id), JSON.stringify(t));
  const caption = clamp(T.topupAlert(env, t), 1000);
  const reply_markup = topupKeyboard(t.id, env);
  if (t.has_image) {
    try {
      const r = await topupImage(env, t.id);
      const bytes = await r.arrayBuffer();
      if (bytes.byteLength > 0 && bytes.byteLength <= MAX_PHOTO_BYTES) {
        const form = new FormData();
        form.set('chat_id', String(Number(env.OWNER_TELEGRAM_ID)));
        form.set('caption', caption);
        form.set('reply_markup', JSON.stringify(reply_markup));
        form.set('photo', new Blob([bytes], { type: r.headers.get('content-type') || 'image/jpeg' }), `topup-${t.id}.jpg`);
        return await tgForm(env, 'sendPhoto', form);
      }
    } catch (e) { console.error('top-up image failed', t.id, String(e)); }
  }
  return notifyOwner(env, caption, { reply_markup });
}

// Cron: alert on new manual top-ups. First run also alerts on top-ups already waiting.
export async function pollTopups(env) {
  if (!apiConfigured(env)) return { skipped: 'website API not connected' };
  const stored = await getSetting(env, CURSOR);
  let announced = 0;
  if (stored === null) {
    const res = await listTopups(env, 0, true);
    for (const t of (res.data || []).filter(needsOwner).slice(-10)) { await sendTopupAlert(env, t); announced++; }
    await setSetting(env, CURSOR, Number(res.latest_id) || 0);
    return { announced, cursor: Number(res.latest_id) || 0 };
  }
  let cursor = Number(stored);
  for (let page = 0; page < 10; page++) {
    const { data = [] } = await listTopups(env, cursor);
    for (const t of data) {
      if (needsOwner(t)) { await sendTopupAlert(env, t); announced++; }
      cursor = Math.max(cursor, Number(t.id));
      await setSetting(env, CURSOR, cursor); // never alert twice if a later send fails
    }
    if (data.length < 50) break;
  }
  return { announced, cursor };
}

// /topups: re-send alerts for manual top-ups still waiting.
export async function pendingTopups(env, limit = 5) {
  const { data = [] } = await listTopups(env, 0, true);
  return data.filter(needsOwner).slice(-limit);
}

// Owner tapped Approve / Reject on an alert.
export async function decideTopup(env, id, approve, userId, message) {
  const json = await getSetting(env, shownKey(id));
  if (!json) return T.topupUnknown(env);
  const t = JSON.parse(json);
  const body = { amount: t.amount, transaction_id: t.transaction_id };
  let text;
  try {
    if (approve) {
      const approvalId = `TG-${Number(userId)}-${Date.now()}`;
      const res = await approveTopup(env, id, { ...body, approval_id: approvalId });
      await audit(env, null, 'TOPUP_APPROVED', userId, `#${id} ${t.amount} ${t.currency} ${approvalId}`);
      text = T.topupApproved(env, t, `${res.balance ?? '?'} ${t.currency}`);
    } else {
      await rejectTopup(env, id, { ...body, note: 'Rejected by the owner in Telegram' });
      await audit(env, null, 'TOPUP_REJECTED', userId, `#${id} ${t.amount} ${t.currency}`);
      text = T.topupRejected(env, id);
    }
  } catch (e) {
    if (!(e instanceof WebsiteApiError)) throw e;
    // 409: already decided (admin panel, Bakong) or changed since shown. Stop offering the buttons.
    if (e.kind === 'rejected') { await delSetting(env, shownKey(id)); await clearButtons(env, message); }
    return T.topupProblem(env, id, e.message.replace(/^Website refused: /, ''));
  }
  await delSetting(env, shownKey(id));
  await clearButtons(env, message);
  return text;
}

async function clearButtons(env, message) {
  if (!message?.message_id) return;
  await tg(env, 'editMessageReplyMarkup', { chat_id: message.chat.id, message_id: message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
}
