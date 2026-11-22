// booksharekh.com sign-ups and sign-ins -> one short Telegram message per check, with the user total.
// New members show email and user name; logins show user names only. Never IP addresses.
import { clamp } from '../helpers.js';
import { notifyOwner } from '../telegram.js';
import { T } from '../i18n.js';
import { apiConfigured, userActivity } from './laravel-api.js';

const CURSOR = 'users_since';
const MAX_NAMES = 10;

const getSetting = async (env, key) => (await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first())?.value ?? null;
const setSetting = (env, key, value) => env.DB.prepare(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`).bind(key, String(value)).run();

const VALID_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const fmt = n => Number(n || 0).toLocaleString('en-US');

// Logins: "sok, vanna" — at most 10 names, then "+N".
export function names(rows = []) {
  const list = rows.slice(0, MAX_NAMES).map(r => clamp(r.user || '?', 40));
  if (rows.length > MAX_NAMES) list.push(`+${rows.length - MAX_NAMES}`);
  return list.join(', ');
}

// New members (owner request): "🆕 email · user name", one per line, at most 10.
export function members(rows = []) {
  const list = rows.slice(0, MAX_NAMES).map(r => `🆕 ${[r.email ? clamp(r.email, 80) : '', clamp(r.user || '?', 40)].filter(Boolean).join(' · ')}`);
  if (rows.length > MAX_NAMES) list.push(`+${rows.length - MAX_NAMES}`);
  return list.join('\n');
}

// Cron: the first run only records the start time (no flood of old activity).
export async function pollUsers(env) {
  if (!apiConfigured(env)) return { skipped: 'website API not connected' };
  const stored = await getSetting(env, CURSOR);
  const since = stored && VALID_TIME.test(stored) ? stored : '2000-01-01 00:00:00';
  const res = await userActivity(env, since);
  const now = VALID_TIME.test(res?.now || '') ? res.now : null;
  if (!now) return { skipped: 'bad response' };
  const reg = res.registered || [], logins = res.logins || [];
  if (stored && (reg.length || logins.length)) {
    await notifyOwner(env, T.userActivity(env, members(reg), names(logins), fmt(res.total_users)));
  }
  await setSetting(env, CURSOR, now);
  return { registered: reg.length, logins: logins.length, total: res.total_users };
}

// /users: total plus the last 24 hours (site time).
export async function usersSummary(env) {
  const res = await userActivity(env, 24); // the site counts the 24 hours in its own time zone
  const count = list => (list?.length >= 50 ? '50+' : String(list?.length || 0));
  return T.usersSummary(env, fmt(res.total_users), count(res.registered), count(res.logins));
}
