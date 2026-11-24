// Website Operations: the weekly run (Friday 08:00 Asia/Phnom_Penh by default, set with /admin ops).
// Scheduled → inspect (rules) → AI only where needed → save findings (no repeats) → one summary in
// Telegram when there is something new → owner approves → apply → verify → report. Silent otherwise.
import { clamp } from '../helpers.js';
import { audit, newId } from '../db.js';
import { getSetting, setSetting } from '../marketing/promo.js';
import { WebsiteApiError, apiConfigured, listRequests, opsBooks, opsMedia, opsReviews, opsStats, opsTaxonomy } from '../website/laravel-api.js';
import { checkWebsite, siteUrl } from '../website/health.js';
import { checkBooks, checkMedia, checkRequests, checkReviews, checkTaxonomy, devRecommendations, genreCandidates } from './checks.js';
import { classifyReviews, suggestGenres } from './ai.js';
import { cacheGet, cachePut, saveFindings } from './store.js';
import { sendWeeklySummary } from './telegram.js';

// ---------- schedule ----------
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const PP_OFFSET_MS = 7 * 3600 * 1000; // Asia/Phnom_Penh is UTC+7 all year (no daylight saving)
export const DEFAULT_SCHEDULE = { day: 5, hour: 8, minute: 0, enabled: true };

export async function getSchedule(env) {
  try { return { ...DEFAULT_SCHEDULE, ...JSON.parse(await getSetting(env, 'ops_schedule') || '{}') }; } catch { return { ...DEFAULT_SCHEDULE }; }
}
// "fri 08:00", "monday 7:30", "off", "on"
export function parseSchedule(text, cur = DEFAULT_SCHEDULE) {
  const t = String(text || '').trim().toLowerCase();
  if (t === 'off') return { ...cur, enabled: false };
  if (t === 'on') return { ...cur, enabled: true };
  const m = /^([a-z]{3})[a-z]*\s+(\d{1,2})(?::(\d{2}))?$/.exec(t);
  if (!m || !DAYS.includes(m[1]) || Number(m[2]) > 23 || Number(m[3] || 0) > 59) return null;
  return { day: DAYS.indexOf(m[1]), hour: Number(m[2]), minute: Number(m[3] || 0), enabled: true };
}
export const scheduleLabel = s => `${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][s.day]} ${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')} (Phnom Penh)${s.enabled ? '' : ' · off'}`;

// The run of this week is due once the scheduled day and time have passed (Phnom Penh time).
export function dueKey(schedule, now = Date.now()) {
  if (!schedule.enabled) return null;
  const pp = new Date(now + PP_OFFSET_MS);
  if (pp.getUTCDay() !== schedule.day || pp.getUTCHours() * 60 + pp.getUTCMinutes() < schedule.hour * 60 + schedule.minute) return null;
  return pp.toISOString().slice(0, 10); // the local date of this week's run
}

// Cron (every 2 minutes): start this week's run once. The run itself goes through the queue.
export async function pollOps(env, now = Date.now()) {
  if (!apiConfigured(env) || !env.TASK_QUEUE) return { skipped: true };
  const key = dueKey(await getSchedule(env), now);
  if (!key) return { due: false };
  const claim = await env.DB.prepare("INSERT INTO settings (key,value,updated_at) VALUES ('ops_last_run_key',?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP WHERE settings.value <> excluded.value RETURNING value")
    .bind(key).first();
  if (!claim) return { due: true, alreadyRan: true };
  await env.TASK_QUEUE.send({ v: 1, type: 'ops_run', trigger: 'schedule' });
  return { due: true, started: true };
}

// ---------- data ----------
async function pages(fetchPage, max = 60) {
  const all = [];
  let after = 0;
  for (let i = 0; i < max; i++) {
    const r = await fetchPage(after);
    all.push(...(r.data || []));
    if (!r.next_after_id) break;
    after = r.next_after_id;
  }
  return all;
}
async function allRequests(env) {
  const all = [];
  let after = 0;
  for (let i = 0; i < 40; i++) {
    const { data = [] } = await listRequests(env, after);
    all.push(...data);
    if (data.length < 50) break;
    after = data.at(-1).id;
  }
  return all;
}

// YouTube links: oEmbed answers 404/400 for removed or private videos. Cached for 30 days, bounded per run.
async function youtubeChecks(env, ids, max = 40) {
  const out = [];
  let checked = 0;
  const month = new Date().toISOString().slice(0, 7);
  for (const id of ids) {
    const hit = await cacheGet(env, `yt:${id}`, month);
    if (hit) { if (!hit.ok) out.push(id); continue; }
    if (checked++ >= max) break;
    let ok = true;
    try {
      const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`, { signal: AbortSignal.timeout(8000) });
      ok = !(r.status === 404 || r.status === 400);
    } catch { continue; } // network trouble: check again next week
    await cachePut(env, `yt:${id}`, month, { ok });
    if (!ok) out.push(id);
  }
  return out;
}

async function healthFindings(env, books, stats) {
  const out = [];
  const site = await checkWebsite(env).catch(() => null);
  for (const x of site?.findings || []) {
    if (x.level === 'critical') out.push({ kind: 'health_site', area: 'health', ref: `site:${clamp(x.text, 40)}`, line: clamp(x.text, 120), risk: 'high', op: null });
  }
  // A sample of book pages must open (newest 5).
  for (const b of books.filter(b => b.slug).slice(-5)) {
    const r = await fetch(`${siteUrl(env)}/book/${encodeURIComponent(b.slug)}`, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10000) }).catch(() => null);
    if (!r || r.status >= 400) out.push({ kind: 'page_broken', area: 'health', ref: `page:${b.slug}`, line: `Book page error ${r ? `HTTP ${r.status}` : 'no answer'} · /book/${clamp(b.slug, 60)}`, risk: 'high', op: null });
  }
  if (stats?.failed_jobs > 0) out.push({ kind: 'failed_jobs', area: 'health', ref: `failed_jobs:${stats.failed_jobs}`, line: `${stats.failed_jobs} failed background job(s)`, risk: 'medium', op: null });
  return out;
}

// ---------- the run ----------
export async function runInspection(env, { trigger = 'schedule' } = {}) {
  if (!apiConfigured(env)) return { skipped: 'website API not connected' };
  const taskId = newId('BSK');
  await env.DB.prepare("INSERT INTO tasks (id,telegram_user_id,request_text,task_type,proposal,status) VALUES (?,?,?,?,?,'running')")
    .bind(taskId, String(env.OWNER_TELEGRAM_ID), `Website Operations inspection (${trigger})`, 'website_ops', '').run();
  const run = await env.DB.prepare('INSERT INTO ops_runs (trigger, task_id) VALUES (?, ?) RETURNING id').bind(trigger, taskId).first();
  const task = { id: taskId, telegram_user_id: String(env.OWNER_TELEGRAM_ID), task_type: 'website_ops' };
  try {
    const [books, taxonomy, reviews, media, stats, requests] = await Promise.all([
      pages(after => opsBooks(env, after)), opsTaxonomy(env), pages(after => opsReviews(env, after), 20), opsMedia(env), opsStats(env), allRequests(env)]);

    // 1. Rules (no AI).
    const rev = checkReviews(reviews);
    const med = checkMedia(media);
    const findings = [...checkBooks(books, taxonomy), ...checkTaxonomy(taxonomy), ...rev.findings, ...med.findings, ...checkRequests(requests, books)];
    for (const id of await youtubeChecks(env, med.youtubeIds)) findings.push({ kind: 'media_unavailable', area: 'media', ref: `yt:${id}`, line: `YouTube video unavailable · ${id}`, risk: 'medium', op: null });
    findings.push(...await healthFindings(env, books, stats));

    // 2. AI only where meaning matters, only for new or changed records.
    const g = await suggestGenres(env, task, genreCandidates(books, taxonomy), taxonomy);
    const r = await classifyReviews(env, task, reviews.filter(x => !rev.flagged.has(x.id)));
    findings.push(...g.findings, ...r.findings);
    findings.push(...devRecommendations({ findings, stats }));

    // 3. Save: unchanged findings are not new; decided ones are not proposed again.
    const saved = await saveFindings(env, run.id, findings);
    const summary = { books: books.length, genres: (taxonomy.genres || []).length, reviews: reviews.length, media: (media.audiobooks || []).length + (media.videos || []).length, requests: requests.length };
    const ruleChecks = books.length + (taxonomy.genres || []).length + (taxonomy.authors || []).length + reviews.length + summary.media + requests.length;
    await env.DB.prepare(`UPDATE ops_runs SET status='done', books_checked=?, rule_checks=?, ai_items=?, ai_cached=?, new_findings=?, summary=?, finished_at=CURRENT_TIMESTAMP WHERE id=?`)
      .bind(books.length, ruleChecks, g.sent + r.sent, g.cached + r.cached, saved.created.length, JSON.stringify(summary), run.id).run();
    await env.DB.prepare("UPDATE tasks SET status='completed', result_note=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(`${saved.created.length} new finding(s); AI items ${g.sent + r.sent}, cached ${g.cached + r.cached}`, taskId).run();
    await audit(env, taskId, 'OPS_RUN', 'system', `run ${run.id}: ${books.length} books, ${findings.length} findings, ${saved.created.length} new, AI ${g.sent + r.sent} (cached ${g.cached + r.cached})`);

    // 4. Telegram: only when something new needs the owner (a manual run always answers).
    if (saved.created.length || trigger === 'manual') await sendWeeklySummary(env, run.id, { books: books.length, newCount: saved.created.length, manual: trigger === 'manual' });
    return { runId: run.id, findings: findings.length, created: saved.created.length, aiItems: g.sent + r.sent, aiCached: g.cached + r.cached };
  } catch (e) {
    const msg = e instanceof WebsiteApiError ? e.message : clamp(e?.message || String(e), 300);
    await env.DB.prepare("UPDATE ops_runs SET status='failed', error=?, finished_at=CURRENT_TIMESTAMP WHERE id=?").bind(msg, run.id).run();
    await env.DB.prepare("UPDATE tasks SET status='failed', result_note=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(msg, taskId).run();
    await audit(env, taskId, 'OPS_RUN_FAILED', 'system', msg);
    if (trigger === 'manual' || e instanceof WebsiteApiError) {
      const { notifyOwner } = await import('../telegram.js');
      await notifyOwner(env, `⚠️ Website Operations: inspection failed\n${msg}`).catch(() => {});
    }
    return { runId: run.id, failed: msg };
  }
}
export { setSetting };
