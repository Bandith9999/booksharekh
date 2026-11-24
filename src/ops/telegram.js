// Website Operations in Telegram (under /admin): deterministic templates, one line per finding,
// pages of 6, buttons for every decision. Messages are edited in place while browsing.
// Texts: ops/i18n.js (Khmer with BOT_LANGUAGE=km; technical words stay English).
// Callback data: wo:s:<section>:<page> | wo:a|r|v|d:<id>:<section>:<page> | wo:sa | wo:ra | wo:rb:<batch> | wo:run | wo:auto:on|off
import { clamp } from '../helpers.js';
import { notifyOwner, reply, tg } from '../telegram.js';
import { WebsiteApiError, opsStats } from '../website/laravel-api.js';
import { counts, getFinding, listFindings } from './store.js';
import { opsBudgets, opsTokensUsed } from './ai.js';
import { OPS_EN, opsText } from './i18n.js';

const PAGE = 6;
// label: English name (also used to match "/admin ops <section>"); the shown name comes from opsText.
export const SECTIONS = {
  ov: {}, ap: { withOp: true },
  bk: { area: 'books' }, gn: { area: 'genres' }, au: { area: 'authors' }, ct: { area: 'categories' }, fl: { area: 'files' }, rv: { area: 'reviews' },
  md: { area: 'media' }, rq: { area: 'requests' }, dv: { area: ['dev', 'health'] }, an: {}, at: {}, ai: {},
};
for (const [k, s] of Object.entries(SECTIONS)) s.label = OPS_EN.sections[k];
const fmt = n => (n == null ? '-' : Number(n).toLocaleString('en-US'));
const pct = (a, b) => (b ? `${a >= b ? '+' : ''}${Math.round(((a - b) / b) * 100)}%` : '');
const btn = (text, data) => ({ text, callback_data: data });
const menuRow = L => [btn(L.b.menu, 'wo:s:ov:0')];

function menuKeyboard(L) {
  const keys = ['ap', 'bk', 'gn', 'au', 'ct', 'fl', 'an', 'rv', 'md', 'rq', 'dv', 'at', 'ai'];
  const rows = [];
  for (let i = 0; i < keys.length; i += 3) rows.push(keys.slice(i, i + 3).map(k => btn(L.sections[k], `wo:s:${k}:0`)));
  return { inline_keyboard: rows };
}

// ---------- weekly summary ----------
async function areaCounts(env) {
  const rows = (await env.DB.prepare("SELECT kind, area, COUNT(*) n FROM ops_findings WHERE status='open' GROUP BY kind, area").all()).results || [];
  const sum = test => rows.filter(test).reduce((a, r) => a + Number(r.n), 0);
  return {
    genre: sum(r => r.area === 'genres' || r.area === 'categories'), metadata: sum(r => r.area === 'books'), author: sum(r => r.area === 'authors'),
    files: sum(r => r.area === 'files'), reviews: sum(r => r.area === 'reviews'), media: sum(r => r.area === 'media'), requests: sum(r => r.area === 'requests'),
  };
}

export async function summaryMessage(env, { books, newCount = 0, manual = false } = {}) {
  const L = opsText(env);
  const a = await areaCounts(env);
  const c = await counts(env);
  const lines = [`${L.title} | ${manual ? L.inspection : L.weekly}`, ''];
  if (books != null) lines.push(`${L.booksChecked}: ${fmt(books)}`);
  const add = (label, n) => { if (n) lines.push(`${label}: ${fmt(n)}`); };
  add(L.genreFix, a.genre); add(L.metaFix, a.metadata); add(L.authorFix, a.author);
  add(L.brokenFiles, a.files); add(L.reviewsFlagged, a.reviews); add(L.mediaIssues, a.media); add(L.requestsUpdate, a.requests);
  lines.push('', `${L.pending}: ${fmt(c.pending)}${c.safe ? ` (${L.safe} ${fmt(c.safe)})` : ''}`, `${L.devIssues}: ${fmt(c.dev)}`);
  if (manual && !newCount) lines.push('', L.noNew);
  const kb = [[btn(L.b.review, 'wo:s:ap:0'), ...(c.safe ? [btn(L.b.approveSafe(c.safe), 'wo:sa')] : [])],
    [btn(L.b.devTasks, 'wo:s:dv:0'), ...(c.pending ? [btn(L.b.rejectAll, 'wo:ra')] : [])], menuRow(L)];
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: kb } };
}
export async function sendWeeklySummary(env, runId, info) {
  const m = await summaryMessage(env, info);
  return notifyOwner(env, m.text, { reply_markup: m.reply_markup });
}

export async function sendCompletion(env, { batchId, applied, failed, total, verified, note }) {
  const L = opsText(env);
  const lines = [L.done, '', `${L.updated}: ${applied}/${total}`, `${L.failed}: ${failed}`,
    `${L.verification}: ${verified && applied ? L.verif.pass : applied ? L.verif.partial : L.verif.none}`];
  if (failed && note) lines.push(`${L.note}: ${clamp(note, 150)}`);
  const kb = [[...(applied ? [btn(L.b.rollback, `wo:rb:${batchId}`)] : []), btn(L.b.approvals, 'wo:s:ap:0')]];
  return notifyOwner(env, lines.join('\n'), { reply_markup: { inline_keyboard: kb } });
}

// ---------- sections ----------
async function findingsSection(env, key, page) {
  const L = opsText(env);
  const s = SECTIONS[key];
  const { rows, total } = await listFindings(env, { area: s.area ?? null, withOp: s.withOp ?? null, limit: PAGE, offset: page * PAGE });
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const lines = [`${L.title} | ${L.sections[key]}`, `${fmt(total)} ${L.open}${total > PAGE ? ` · ${L.page} ${page + 1}/${pages}` : ''}`, ''];
  if (!rows.length) lines.push(L.nothingOpen);
  const kb = [];
  for (const r of rows) {
    lines.push(`#${r.id} ${r.line}${r.risk !== 'low' ? ` · ${L.risk[r.risk] || r.risk}` : ''}${r.source === 'ai' ? ` · ${L.ai}` : ''}`);
    const at = `${key}:${page}`;
    if (r.area === 'dev' || r.area === 'health') kb.push([btn(L.b.approveDev(r.id), `wo:d:${r.id}:${at}`), btn(L.b.reject(r.id), `wo:r:${r.id}:${at}`)]);
    else if (r.op) kb.push([btn(`✅ #${r.id}`, `wo:a:${r.id}:${at}`), btn(`❌ #${r.id}`, `wo:r:${r.id}:${at}`), ...(r.source === 'ai' ? [btn(`✏️ #${r.id}`, `wo:v:${r.id}:${at}`)] : [])]);
    else kb.push([btn(L.b.dismiss(r.id), `wo:r:${r.id}:${at}`)]);
  }
  const nav = [];
  if (page > 0) nav.push(btn(L.b.prev, `wo:s:${key}:${page - 1}`));
  if (page + 1 < pages) nav.push(btn(L.b.next, `wo:s:${key}:${page + 1}`));
  if (nav.length) kb.push(nav);
  kb.push(menuRow(L));
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: kb } };
}

async function overview(env) {
  const L = opsText(env);
  const c = await counts(env);
  const last = await env.DB.prepare('SELECT status, finished_at, books_checked FROM ops_runs ORDER BY id DESC LIMIT 1').first();
  const { getSchedule, scheduleLabel } = await import('./run.js');
  const lines = [L.title, '',
    `${L.pending}: ${fmt(c.pending)}${c.safe ? ` (${L.safe} ${fmt(c.safe)})` : ''}`, `${L.approvedWaiting}: ${fmt(c.approved)}`,
    `${L.reports}: ${fmt(c.reports)}`, `${L.devIssues}: ${fmt(c.dev)}`, '',
    `${L.next}: ${scheduleLabel(await getSchedule(env), env)}`,
    `${L.lastRun}: ${last ? `${last.finished_at || L.running} · ${last.status} · ${fmt(last.books_checked)} ${L.books}` : L.never}`];
  return { text: lines.join('\n'), reply_markup: menuKeyboard(L) };
}

async function analytics(env) {
  const L = opsText(env), A = L.a;
  let s;
  try { s = await opsStats(env); } catch (e) { return { text: `${L.title} | ${A.title}\n\n${e instanceof WebsiteApiError ? e.message : A.unavailable}`, reply_markup: { inline_keyboard: [menuRow(L)] } }; }
  const months = Object.entries(s.views_by_month || {});
  const buys = Object.entries(s.purchases_by_month || {});
  const top = (list, n = 5) => (list || []).slice(0, n).map((b, i) => `${i + 1}. ${clamp(b.title, 40)} (${fmt(b.views)})`).join('\n');
  const lines = [`${L.title} | ${A.title}`, '',
    `${A.books}: ${fmt(s.books)}${s.books_deleted ? ` · ${A.deleted} ${fmt(s.books_deleted)}` : ''}`,
    `${A.viewsLife}: ${fmt(s.views_total)}`];
  if (s.views_last_7_days != null) lines.push(`${A.views7}: ${fmt(s.views_last_7_days)} ${pct(s.views_last_7_days, s.views_prev_7_days)}`.trim());
  if (months.length) lines.push(`${A.views} ${months[0][0]}: ${fmt(months[0][1])}${months[1] ? ` · ${months[1][0]}: ${fmt(months[1][1])} ${pct(months[0][1], months[1][1])}` : ''}`.trim());
  lines.push(`${A.downloads}: ${fmt(s.downloads_total)}`);
  if (s.purchases_total != null) lines.push(`${A.purchases}: ${fmt(s.purchases_total)}${buys[0] ? ` · ${buys[0][0]}: ${fmt(buys[0][1])}` : ''}${buys[1] ? ` · ${buys[1][0]}: ${fmt(buys[1][1])}` : ''}`);
  if (s.reviews_total != null) lines.push(A.ratings(s.rating_avg || '-', fmt(s.reviews_total)));
  if (s.popular?.length) lines.push('', A.mostViewed, top(s.popular));
  if (s.trending?.length) lines.push('', A.thisMonth, s.trending.slice(0, 5).map((b, i) => `${i + 1}. ${clamp(b.title, 40)} (${fmt(b.views)}${b.prev ? `, ${pct(b.views, b.prev)}` : `, ${A.newBook}`})`).join('\n'));
  if (s.genre_views?.length) lines.push('', A.topGenres, s.genre_views.slice(0, 5).map(g => `• ${clamp(g.name, 30)} · ${fmt(g.views)} · ${fmt(g.books)} ${L.books}`).join('\n'));
  if (s.high_views_low_sales?.length) lines.push('', A.noSales, top(s.high_views_low_sales, 3));
  if (s.low_engagement != null) lines.push('', A.low(fmt(s.low_engagement)));
  return { text: clamp(lines.join('\n'), 3900), reply_markup: { inline_keyboard: [menuRow(L)] } };
}

async function aiUsage(env) {
  const L = opsText(env), U = L.u;
  const u = await opsTokensUsed(env), b = opsBudgets(env);
  const runs = (await env.DB.prepare("SELECT SUM(rule_checks) r, SUM(ai_items) a, SUM(ai_cached) c FROM ops_runs WHERE started_at >= datetime('now','-30 days')").first()) || {};
  const byProvider = (await env.DB.prepare(`SELECT provider, COUNT(*) n, SUM(input_tokens+output_tokens) t FROM agent_execution_logs
      WHERE agent='website_ops' AND created_at >= datetime('now','-30 days') GROUP BY provider`).all()).results || [];
  const rule = Number(runs.r || 0), ai = Number(runs.a || 0), cached = Number(runs.c || 0);
  const share = rule + ai ? Math.round((rule / (rule + ai)) * 100) : 100;
  const lines = [`${L.title} | ${L.sections.ai}`, '',
    `${U.week}: ${fmt(u.week)} / ${fmt(b.weekly)} ${U.tokens} · ${fmt(u.weekCalls)} ${U.calls}`,
    `${U.days30}: ${fmt(u.month)} / ${fmt(b.monthly)} ${U.tokens} · ${fmt(u.monthCalls)} ${U.calls}`,
    ...byProvider.map(p => `• ${p.provider}: ${fmt(p.n)} ${U.calls} · ${fmt(p.t)} ${U.tokens}`), '',
    `${U.noAi}: ${share}% (${fmt(rule)} ${U.records})`, `${U.sent}: ${fmt(ai)} · ${U.cache}: ${fmt(cached)}`];
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: [menuRow(L)] } };
}

async function automation(env) {
  const L = opsText(env);
  const { getSchedule, scheduleLabel } = await import('./run.js');
  const s = await getSchedule(env);
  const lines = [`${L.title} | ${L.sections.at}`, '', `${L.weeklyInspection}: ${scheduleLabel(s, env)}`, `${L.change}: /admin ops schedule fri 08:00`];
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: [[btn(L.b.runNow, 'wo:run'), btn(s.enabled ? L.b.turnOff : L.b.turnOn, `wo:auto:${s.enabled ? 'off' : 'on'}`)], menuRow(L)] } };
}

export async function renderSection(env, key, page = 0) {
  if (key === 'ov' || !SECTIONS[key]) return overview(env);
  if (key === 'an') return analytics(env);
  if (key === 'ai') return aiUsage(env);
  if (key === 'at') return automation(env);
  return findingsSection(env, key, Math.max(0, page));
}

export async function sendOpsMenu(env, chat, key = 'ov') {
  const m = await renderSection(env, key, 0);
  return reply(env, chat, m.text, { reply_markup: m.reply_markup });
}
// Browse by editing the same message; if it cannot be edited (too old), send a new one.
async function show(env, message, key, page) {
  const m = await renderSection(env, key, page);
  if (message?.message_id) {
    // An error here is usually "message is not modified" (same content): nothing to send.
    await tg(env, 'editMessageText', { chat_id: message.chat.id, message_id: message.message_id, text: m.text, reply_markup: m.reply_markup }).catch(() => {});
    return;
  }
  await reply(env, message?.chat?.id ?? Number(env.OWNER_TELEGRAM_ID), m.text, { reply_markup: m.reply_markup });
}

// ---------- button taps (the owner was already verified by handleCallback) ----------
export async function handleOpsCallback(env, q, data, userId) {
  const L = opsText(env);
  const { decideFinding, approveSafe, rejectAllProposals, cacheDrop } = await import('./store.js');
  const { executeMessage, rollbackBatch } = await import('./execute.js');
  const enqueueApply = () => env.TASK_QUEUE?.send(executeMessage());
  let m;
  if ((m = /^wo:s:([a-z]{2}):(\d{1,4})$/.exec(data))) return show(env, q.message, m[1], Number(m[2]));
  if ((m = /^wo:([arvd]):(\d{1,9}):([a-z]{2}):(\d{1,4})$/.exec(data))) {
    const [, act, id, key, page] = m;
    const f = await getFinding(env, Number(id));
    if (f && act === 'a') { if (await decideFinding(env, f.id, 'approve')) await enqueueApply(); }
    if (f && act === 'r') await decideFinding(env, f.id, 'reject');
    if (f && act === 'v' && f.source === 'ai') { if (await decideFinding(env, f.id, 'revise')) await cacheDrop(env, f.ref.replace(/^book:/, 'genre:')); }
    if (f && act === 'd' && (f.area === 'dev' || f.area === 'health')) await assignToDeveloper(env, f, userId);
    return show(env, q.message, key, Number(page));
  }
  if (data === 'wo:sa') {
    const n = await approveSafe(env);
    if (n) await enqueueApply();
    return reply(env, q.message.chat.id, n ? L.safeApproved(n) : L.noSafe);
  }
  if (data === 'wo:ra') return reply(env, q.message.chat.id, L.rejected(await rejectAllProposals(env)));
  if ((m = /^wo:rb:(OPS-[a-f0-9]{20})$/.exec(data))) {
    const r = await rollbackBatch(env, m[1]);
    return reply(env, q.message.chat.id, [L.rolledBack, '', `${L.restored}: ${r.undone}`, ...(r.conflicts ? [`${L.notRestored}: ${r.conflicts}`] : [])].join('\n'));
  }
  if (data === 'wo:run') {
    await env.TASK_QUEUE?.send({ v: 1, type: 'ops_run', trigger: 'manual' });
    return reply(env, q.message.chat.id, L.started);
  }
  if ((m = /^wo:auto:(on|off)$/.exec(data))) {
    const { getSchedule, setSetting } = await import('./run.js');
    await setSetting(env, 'ops_schedule', JSON.stringify({ ...(await getSchedule(env)), enabled: m[1] === 'on' }));
    return show(env, q.message, 'at', 0);
  }
}

// Approved improvement or technical issue → the existing Developer pipeline (plan, PR, merge and
// deploy each need their own approval). Marked 'assigned' so it is not recommended again.
async function assignToDeveloper(env, f, userId) {
  const L = opsText(env);
  if (!env.WEBSITE_REPO) return reply(env, Number(env.OWNER_TELEGRAM_ID), L.devMissing);
  const { decideFinding } = await import('./store.js');
  if (!await decideFinding(env, f.id, 'assign')) return;
  const { createTask } = await import('../orchestration/engine.js');
  const { taskReply } = await import('../telegram.js');
  const r = await createTask(env, { userId, description: `Website Operations: ${f.line}. Plan the smallest safe change for the BookShareKH Laravel website.`, type: 'website_code_change' });
  if (r.id) await taskReply(env, Number(env.OWNER_TELEGRAM_ID), r.id, L.sentToDev(f.id));
}
