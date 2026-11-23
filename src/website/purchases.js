// booksharekh.com book purchases -> one silent Telegram message per check (owner request):
// buyer email, user name and book title. The first run only records where to start.
import { clamp } from '../helpers.js';
import { notifyOwner } from '../telegram.js';
import { T } from '../i18n.js';
import { apiConfigured, listPurchases } from './laravel-api.js';

const CURSOR = 'last_purchase_id';
const MAX_SHOWN = 10;

const getSetting = async (env, key) => (await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first())?.value ?? null;
const setSetting = (env, key, value) => env.DB.prepare(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`).bind(key, String(value)).run();

export const purchaseLines = rows => {
  const list = rows.slice(0, MAX_SHOWN).map(p =>
    `🛒 ${[p.email ? clamp(p.email, 80) : '', clamp(p.user || '?', 40)].filter(Boolean).join(' · ')}\n📖 ${clamp(p.book_title || '?', 150)}`);
  if (rows.length > MAX_SHOWN) list.push(`+${rows.length - MAX_SHOWN}`);
  return list.join('\n\n');
};

export async function pollPurchases(env) {
  if (!apiConfigured(env)) return { skipped: 'website API not connected' };
  const stored = await getSetting(env, CURSOR);
  if (stored === null) {
    const { latest_id: latest = 0 } = await listPurchases(env, 0);
    await setSetting(env, CURSOR, Number(latest) || 0);
    return { started: Number(latest) || 0 };
  }
  let cursor = Number(stored);
  const bought = [];
  for (let page = 0; page < 10; page++) {
    const { data = [] } = await listPurchases(env, cursor);
    for (const p of data) { bought.push(p); cursor = Math.max(cursor, Number(p.id)); }
    if (data.length < 50) break;
  }
  if (bought.length) await notifyOwner(env, T.purchaseAlert(env, purchaseLines(bought))); // silent (default)
  await setSetting(env, CURSOR, cursor);
  return { announced: bought.length, cursor };
}
