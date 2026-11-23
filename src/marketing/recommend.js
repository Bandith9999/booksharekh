// Admin: every few days, recommend at least 10 popular books (title + author) that booksharekh.com
// does not have yet. Sources: Open Library weekly trending (any rights) and Project Gutenberg's most
// downloaded (public domain). Only public-domain ones get an import button; copyrighted titles need a
// licence first. Nothing is added to the website without the owner's approvals.
import { clamp } from '../helpers.js';
import { notifyOwner } from '../telegram.js';
import { T } from '../i18n.js';
import { apiConfigured, searchBooks } from '../website/laravel-api.js';
import { popularPublicDomain } from '../books/gutenberg.js';

const LAST_RUN = 'recommend_last_run';
const SEEN = 'recommended_titles';
const WANT = 10, MAX = 12, MAX_SITE_CHECKS = 36, REPEAT_DAYS = 21;
const UA = { 'User-Agent': 'BookShareKH-AI-Manager/1.0 (+https://booksharekh.com)' };

const getSetting = async (env, key) => (await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first())?.value ?? null;
const setSetting = (env, key, value) => env.DB.prepare(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`).bind(key, String(value)).run();

export const norm = s => String(s || '').toLowerCase().split(/[:(;]/)[0].replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();

async function trending() {
  try {
    const r = await fetch('https://openlibrary.org/trending/weekly.json?limit=60', { headers: UA, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return [];
    const works = (await r.json())?.works || [];
    return works.filter(w => w.title && w.author_name?.[0] && (!w.language || w.language.includes('eng')))
      .map(w => ({ title: clamp(w.title, 120), author: clamp(w.author_name[0], 80), year: Number(w.first_publish_year) || null, publicDomain: false }));
  } catch { return []; }
}

async function publicDomain(env) {
  try {
    return (await popularPublicDomain({ languages: env.BOOK_LANGUAGES }))
      .map(b => ({ title: clamp(b.title, 120), author: clamp(b.author, 80), year: null, publicDomain: true, gutenbergId: b.id }));
  } catch { return []; }
}

// True if the website already has a book with this title.
async function onSite(env, title) {
  const key = norm(title);
  if (!key) return true;
  const found = await searchBooks(env, key.slice(0, 80));
  return found.some(b => { const t = norm(b.title); return t && (t === key || t.includes(key) || key.includes(t)); });
}

export async function recommendBooks(env) {
  let seen = {};
  try { seen = JSON.parse(await getSetting(env, SEEN) || '{}'); } catch { /* reset */ }
  const cutoff = Date.now() - REPEAT_DAYS * 86400000;
  seen = Object.fromEntries(Object.entries(seen).filter(([, t]) => t > cutoff));

  const [hot, pd] = await Promise.all([trending(), publicDomain(env)]);
  // Mix: trending first (what people read now), then public domain (can be imported legally).
  const pool = [];
  for (let h = 0, p = 0; h < hot.length || p < pd.length;) {
    for (let k = 0; k < 2 && h < hot.length; k++) pool.push(hot[h++]);
    if (p < pd.length) pool.push(pd[p++]);
  }

  const picked = [], keys = new Set();
  let checks = 0;
  for (const b of pool) {
    if (picked.length >= MAX || checks >= MAX_SITE_CHECKS) break;
    const key = norm(b.title);
    if (!key || keys.has(key) || seen[key]) continue;
    keys.add(key);
    checks++;
    if (await onSite(env, b.title)) continue;
    picked.push(b);
  }
  for (const b of picked) seen[norm(b.title)] = Date.now();
  await setSetting(env, SEEN, JSON.stringify(seen));
  return picked;
}

export function recommendMessage(env, books) {
  if (!books.length) return { text: T.recommendNone(env) };
  const text = T.recommend(env, books.map((b, i) => `${i + 1}. ${b.title} — ${b.author}${b.year ? ` (${b.year})` : ''} ${b.publicDomain ? '🟢' : '🔒'}`), books.length < WANT);
  const buttons = books.map((b, i) => (b.publicDomain && b.gutenbergId ? { text: `📥 ${i + 1}`, callback_data: `bi:${b.gutenbergId}:0` } : null)).filter(Boolean).slice(0, 8);
  const rows = [];
  for (let i = 0; i < buttons.length; i += 4) rows.push(buttons.slice(i, i + 4));
  return rows.length ? { text, reply_markup: { inline_keyboard: rows } } : { text };
}

export async function sendRecommendations(env) {
  const m = recommendMessage(env, await recommendBooks(env));
  await notifyOwner(env, m.text, m.reply_markup ? { reply_markup: m.reply_markup } : {});
}

// Cron: every RECOMMEND_EVERY_DAYS days (default 3; 7 = weekly) at 09:00 Phnom Penh (02:00 UTC).
export async function pollRecommend(env, now = new Date()) {
  if (!apiConfigured(env) || now.getUTCHours() !== 2) return { skipped: true };
  const days = Math.min(Math.max(Number(env.RECOMMEND_EVERY_DAYS) || 3, 1), 30);
  const last = Number(await getSetting(env, LAST_RUN) || 0);
  if (now.getTime() - last < days * 86400000 - 2 * 3600000) return { skipped: true };
  await setSetting(env, LAST_RUN, now.getTime()); // before sending: never twice in the same window
  await sendRecommendations(env);
  return { sent: true };
}
