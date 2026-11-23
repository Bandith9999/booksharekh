// Book requests from booksharekh.com visitors -> Telegram alerts -> legal-source search -> import.
import { clamp } from '../helpers.js';
import { audit } from '../db.js';
import { notifyOwner } from '../telegram.js';
import { apiConfigured, getRequest, listRequests, updateRequest } from '../website/laravel-api.js';
import { searchPublicDomain } from './gutenberg.js';
import { T } from '../i18n.js';

const CURSOR = 'last_book_request_id';
const getSetting = async (env, key) => (await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first())?.value ?? null;
const setSetting = (env, key, value) => env.DB.prepare(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`).bind(key, String(value)).run();

export const requestKeyboard = (id, env) => {
  const b = T.requestButtons(env);
  return { inline_keyboard: [[{ text: b.find, callback_data: `rq:${id}` }, { text: b.reject, callback_data: `rr:${id}` }]] };
};

// Runs from the cron trigger. The first run only records where to start (no flood of old requests).
export async function pollBookRequests(env) {
  if (!apiConfigured(env)) return { skipped: 'website API not connected' };
  const stored = await getSetting(env, CURSOR);
  let cursor = Number(stored ?? 0);
  let announced = 0;
  for (let page = 0; page < 10; page++) {
    const { data = [] } = await listRequests(env, cursor);
    for (const r of data) {
      if (stored !== null && r.status === 'pending') {
        await notifyOwner(env, T.requestAlert(env, { id: r.id, book_title: clamp(r.book_title, 150), author: r.author ? clamp(r.author, 100) : '', language: r.language ? clamp(r.language, 20) : '' }),
          { reply_markup: requestKeyboard(r.id, env) });
        announced++;
      }
      cursor = Math.max(cursor, r.id);
    }
    if (data.length < 50) break;
  }
  await setSetting(env, CURSOR, cursor);
  if (stored === null) await notifyOwner(env, T.watching(env, cursor)).catch(() => {});
  return { announced, cursor };
}

export function candidatesMessage(query, books, requestId = 0, env = null) {
  const L = T.candidates(env);
  if (!books.length) return { text: L.none(clamp(query, 100)) };
  return {
    text: [L.head(clamp(query, 100)),
      ...books.map((b, i) => `${i + 1}. ${b.title} — ${b.author}${b.languages.length ? ` (${b.languages.join(', ')})` : ''}\n   ${b.pageUrl}`),
      '', L.foot].join('\n'),
    reply_markup: { inline_keyboard: books.map((b, i) => [{ text: L.button(i + 1), callback_data: `bi:${b.id}:${requestId || 0}` }]) },
  };
}

// Owner tapped "Find a legal copy" on a request: mark it approved and search legal sources.
export async function findForRequest(env, requestId, userId) {
  const r = await getRequest(env, requestId);
  await updateRequest(env, requestId, { status: 'approved', note: 'Searching public-domain sources' });
  await audit(env, null, 'BOOK_REQUEST_APPROVED', userId, `#${requestId} ${clamp(r.book_title, 100)}`);
  const books = await searchPublicDomain(`${r.book_title} ${r.author || ''}`.trim(), { languages: env.BOOK_LANGUAGES });
  return candidatesMessage(r.book_title, books, requestId, env);
}

export async function rejectRequest(env, requestId, userId) {
  await updateRequest(env, requestId, { status: 'rejected', note: 'Rejected by the owner' });
  await audit(env, null, 'BOOK_REQUEST_REJECTED', userId, `#${requestId}`);
}

// /requests: pending requests near the newest one (covers requests made before the watcher started).
export async function recentPendingRequests(env, limit = 10) {
  const cursor = Number(await getSetting(env, CURSOR) ?? 0);
  const { data = [] } = await listRequests(env, Math.max(0, cursor - 40));
  return data.filter(r => r.status === 'pending').slice(-limit).reverse();
}
