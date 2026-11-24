// Website Operations agent: weekly schedule, rule-based inspection, no repeated findings, incremental
// AI with cache and budget, owner-only approvals, approved execution (once), failures, rollback, audit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OWNER, drain, makeEnv, mockFetch, msg, routes, sent, telegram } from './harness.mjs';
import { dueKey, parseSchedule, pollOps, runInspection } from '../src/ops/run.js';
import { checkBooks, checkTaxonomy } from '../src/ops/checks.js';
import { executeApproved } from '../src/ops/execute.js';
import { AGENTS } from '../src/agents/registry.js';
import { resolveChain } from '../src/ai/model-router.js';

const SITE = 'https://booksharekh.com';
const fixture = () => ({
  books: [
    { id: 10, title: ' Atomic  Habits', slug: 'atomic-habits', author_id: 1, author: 'James clear', category_id: null, genre_ids: [1], publish_date: '2018-10-16',
      description: 'Tiny changes, remarkable results.', description_length: 60, publisher: 'Avery', edition: '1', youtube_link: null,
      cover: { path: 'images/covers/a.jpg', ok: true }, files: [{ type: 'pdf', ok: true }], views: 120, downloads: 4, purchases: 1 },
    { id: 11, title: 'Emma', slug: 'emma', author_id: 2, author: 'Jane Austen', category_id: 1, genre_ids: [4], publish_date: null,
      description: '', description_length: 0, publisher: null, edition: null, youtube_link: 'https://example.com/v', cover: { path: null, ok: false }, files: [], views: 3, downloads: 0, purchases: 0 },
  ],
  taxonomy: {
    genres: [{ id: 1, name: 'General', books: 1 }, { id: 2, name: 'Self Development', books: 0 }, { id: 3, name: 'self development ', books: 0 }, { id: 4, name: 'Novel', books: 1 }],
    categories: [{ id: 1, name: 'Books', type: 'book', books: 1 }],
    authors: [{ id: 1, name: 'James clear', books: 1 }, { id: 2, name: 'Jane Austen', books: 1 }],
  },
  reviews: [{ id: 1, book_id: 10, rating: 5, comment: 'Great http://spam.example', reviewer: 'abc' }, { id: 2, book_id: 11, rating: 2, comment: 'Not for me, too slow.', reviewer: 'def' }],
  media: { audiobooks: [{ id: 1, title: 'Emma (audio)', youtube_video_id: 'dQw4w9WgXcQ', description: '' }], videos: [], playlists: [], channels: [], video_categories: {} },
  stats: { books: 2, books_deleted: 0, views_total: 123, downloads_total: 4, failed_jobs: 0, table_rows: { tags: 0, favorites: null, reading_lists: null, book_reports: null }, popular: [] },
  requests: [{ id: 5, book_title: 'emma', status: 'pending' }, { id: 6, book_title: 'Dune', status: 'pending' }],
});

function website(data, { apply } = {}) {
  const calls = { apply: [], rollback: [] };
  const route = [/booksharekh\.com|youtube\.com\/oembed/, (url, init) => {
    const u = new URL(url);
    if (u.hostname.includes('youtube')) return Response.json({ title: 'ok' });
    const p = u.pathname;
    if (p === '/api/ai/ops/books') return Response.json({ data: data.books, next_after_id: null });
    if (p === '/api/ai/ops/taxonomy') return Response.json(data.taxonomy);
    if (p === '/api/ai/ops/reviews') return Response.json({ data: data.reviews, next_after_id: null });
    if (p === '/api/ai/ops/media') return Response.json(data.media);
    if (p === '/api/ai/ops/stats') return Response.json(data.stats);
    if (p === '/api/ai/requests') return Response.json({ data: Number(u.searchParams.get('after_id')) ? [] : data.requests });
    if (p === '/api/ai/ops/apply') { const body = JSON.parse(init.body); calls.apply.push(body); return apply ? apply(body) : Response.json({ status: 'applied', changes: body.ops.map((o, i) => ({ id: i + 1, op: o.op })), conflicts: [] }); }
    if (p === '/api/ai/ops/rollback') { calls.rollback.push(JSON.parse(init.body)); return Response.json({ status: 'rolled_back', changes: [] }); }
    if (p === '/' || p.startsWith('/book/')) return new Response('ok', { status: 200 });
    return new Response('nope', { status: 404 });
  }];
  return { route, calls };
}
const env = (more = {}) => makeEnv({ LARAVEL_API_URL: SITE, LARAVEL_API_TOKEN: 'bsk_ai_x', WEBSITE_URL: SITE, ...more });
const findings = (e, where = '1=1') => e.DB.db.prepare(`SELECT * FROM ops_findings WHERE ${where} ORDER BY id`).all();
const aiCalls = e => e.DB.db.prepare("SELECT COUNT(*) n FROM agent_execution_logs WHERE agent='website_ops'").get().n;
const tap = (data, from = OWNER) => ({ callback_query: { id: 'q', from: { id: from }, message: { message_id: 77, chat: { id: from, type: 'private' } }, data } });

test('schedule: Friday 08:00 Phnom Penh, once per week, configurable', async () => {
  const fri0800 = Date.UTC(2026, 10, 27, 1, 0); // Fri 27 Nov 2026 08:00 in Phnom Penh (UTC+7)
  const s = { day: 5, hour: 8, minute: 0, enabled: true };
  assert.equal(dueKey(s, fri0800 - 60000), null, '07:59 is too early');
  assert.equal(dueKey(s, fri0800), '2026-11-27');
  assert.equal(dueKey(s, fri0800 - 86400000), null, 'not on Thursday');
  assert.equal(dueKey({ ...s, enabled: false }, fri0800), null);
  assert.deepEqual(parseSchedule('monday 7:30'), { day: 1, hour: 7, minute: 30, enabled: true });
  assert.equal(parseSchedule('someday'), null);

  const e = env();
  mockFetch([routes.telegram]);
  assert.equal((await pollOps(e, fri0800)).started, true);
  assert.equal((await pollOps(e, fri0800 + 120000)).alreadyRan, true, 'the cron every 2 minutes starts it once');
  assert.deepEqual(e.__queue.sent.map(m => m.type), ['ops_run']);
});

test('rules find real problems without AI, never invent data, never propose deletes', () => {
  const d = fixture();
  const list = [...checkBooks(d.books, d.taxonomy), ...checkTaxonomy(d.taxonomy)];
  const kinds = list.map(x => x.kind);
  for (const k of ['title_spacing', 'category_missing', 'cover_missing', 'file_missing', 'youtube_invalid', 'missing_description', 'author_case', 'genre_duplicate', 'genre_unused']) assert.ok(kinds.includes(k), k);
  assert.deepEqual(list.find(x => x.kind === 'title_spacing').op, { op: 'book.set', target: 10, field: 'title', before: ' Atomic  Habits', after: 'Atomic Habits' });
  assert.equal(list.find(x => x.kind === 'author_case').op.after, 'James Clear');
  assert.equal(list.find(x => x.kind === 'missing_description').op, null, 'missing data is reported, not filled in');
  assert.ok(!list.some(x => x.op && /delete|merge|price/.test(JSON.stringify(x.op))));
  assert.ok(!list.some(x => x.kind === 'genre_spacing' && x.ref === 'genre:3'), 'a rename that would collide with another genre is not proposed');
});

test('weekly run: one concise summary; the next run with the same data is silent and sends nothing to the AI', async () => {
  const e = env();
  const site = website(fixture());
  const calls = mockFetch([routes.telegram, site.route]);
  const r1 = await runInspection(e, { trigger: 'schedule' });
  assert.ok(r1.created > 5);
  assert.equal(r1.aiItems, 2, '1 book to classify + 1 review (the other review was already flagged by the rules)');
  const summary = sent(calls).at(-1);
  assert.match(summary.text, /^Website Operations \| Weekly\n\nBooks checked: 2\n/);
  assert.match(summary.text, /Pending corrections: \d+ \(safe \d+\)/);
  assert.doesNotMatch(summary.text, /[{}]|SELECT/, 'no JSON or SQL');
  assert.deepEqual(summary.reply_markup.inline_keyboard.flat().map(b => b.text).slice(0, 2), ['Review', summary.reply_markup.inline_keyboard[0][1].text]);
  const genre = findings(e, "kind='genre_suggest'")[0];
  assert.deepEqual(JSON.parse(genre.op), { op: 'book.genres', target: 10, before: [1], after: [4] });
  assert.equal(genre.source, 'ai');

  const before = sent(calls).length;
  const r2 = await runInspection(e, { trigger: 'schedule' });
  assert.equal(r2.created, 0, 'nothing new');
  assert.equal(r2.aiItems, 0, 'unchanged records come from the cache');
  assert.equal(sent(calls).length, before, 'silent when nothing is new');
  assert.equal(aiCalls(e), 2, 'no extra AI calls in week 2');

  // A changed book is the only one sent again.
  const d = fixture();
  d.books[0].description = 'A new description about habits.';
  mockFetch([routes.telegram, website(d).route]);
  const r3 = await runInspection(e, { trigger: 'schedule' });
  assert.equal(r3.aiItems, 1);
});

test('website_ops uses the cheapest AI first (Gemini) and stops at its token budget; rules still run', async () => {
  const LIVE = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')).vars;
  assert.equal(resolveChain(LIVE, AGENTS.website_ops)[0].provider, 'google');
  assert.equal(AGENTS.website_ops.tier, 'review');

  const e = env({ AI_OPS_WEEKLY_TOKENS: '10' });
  e.DB.db.prepare("INSERT INTO tasks (id,telegram_user_id,request_text,task_type,proposal,status) VALUES ('BSK-x','111','x','website_ops','','completed')").run();
  e.DB.db.prepare("INSERT INTO agent_execution_logs (task_id,agent,provider,model,outcome,input_tokens,output_tokens) VALUES ('BSK-x','website_ops','google','g','success',50,50)").run();
  mockFetch([routes.telegram, website(fixture()).route]);
  const r = await runInspection(e, { trigger: 'schedule' });
  assert.equal(r.aiItems, 0, 'budget used up: no AI');
  assert.ok(r.created > 5, 'rule-based findings still made');
});

test('approvals: owner only, exact change applied once, verified, reported; rollback restores', async () => {
  const e = env();
  const site = website(fixture());
  const calls = mockFetch([routes.telegram, site.route]);
  await runInspection(e, { trigger: 'schedule' });
  const title = findings(e, "kind='title_spacing'")[0];

  await telegram(e, tap(`wo:a:${title.id}:ap:0`, 999));
  assert.equal(findings(e, `id=${title.id}`)[0].status, 'open', 'a stranger cannot approve');

  await telegram(e, tap(`wo:a:${title.id}:ap:0`));
  await telegram(e, tap(`wo:a:${title.id}:ap:0`)); // double tap
  assert.equal(findings(e, `id=${title.id}`)[0].status, 'approved');
  await drain(e);
  assert.equal(site.calls.apply.length, 1, 'applied once');
  assert.deepEqual(site.calls.apply[0].ops, [{ op: 'book.set', target: 10, field: 'title', before: ' Atomic  Habits', after: 'Atomic Habits' }]);
  const done = findings(e, `id=${title.id}`)[0];
  assert.equal(done.status, 'applied');
  assert.match(sent(calls).at(-1).text, /^Update Completed\n\nUpdated: 1\/1\nFailed: 0\nVerification: Passed/);
  assert.deepEqual(await executeApproved(e), { applied: 0, failed: 0, conflicts: 0 }, 'nothing left to apply');

  // Safe batch: only non-destructive safe changes.
  await telegram(e, tap('wo:sa'));
  await drain(e);
  const batch = site.calls.apply.at(-1).ops.map(o => o.op);
  assert.ok(batch.length >= 2 && batch.every(o => ['book.set', 'book.category', 'request.status', 'genre.rename', 'author.rename'].includes(o)));
  assert.ok(!batch.includes('book.genres'), 'AI genre suggestions are never in the safe batch');

  await telegram(e, tap(`wo:rb:${done.batch_id}`));
  assert.deepEqual(site.calls.rollback.map(r => r.approval_id), [done.batch_id]);
  assert.equal(findings(e, `id=${title.id}`)[0].status, 'rolled_back');
  const events = e.DB.db.prepare("SELECT event FROM audit_log WHERE event LIKE 'OPS_%'").all().map(r => r.event);
  for (const ev of ['OPS_RUN', 'OPS_APPLIED', 'OPS_ROLLBACK']) assert.ok(events.includes(ev), ev);
});

test('failures: server errors retry a bounded number of times; changed records become stale, nothing is claimed as done', async () => {
  const e = env();
  let mode = 'down';
  const site = website(fixture(), { apply: body => (mode === 'down' ? new Response('x', { status: 500 })
    : Response.json({ status: 'conflict', changes: [], conflicts: [{ index: 0, current: 'Someone changed it' }] }, { status: 409 })) });
  const calls = mockFetch([routes.telegram, site.route]);
  await runInspection(e, { trigger: 'schedule' });
  const id = findings(e, "kind='title_spacing'")[0].id;
  await telegram(e, tap(`wo:a:${id}:ap:0`));
  await drain(e);
  assert.equal(site.calls.apply.length, 3, 'tried 3 times');
  assert.equal(findings(e, `id=${id}`)[0].status, 'failed');
  assert.match(sent(calls).at(-1).text, /Updated: 0\/1\nFailed: 1\nVerification: Not applied/);

  mode = 'conflict';
  e.DB.db.prepare("UPDATE ops_findings SET status='approved', attempts=0 WHERE id=?").run(id);
  await executeApproved(e);
  assert.equal(findings(e, `id=${id}`)[0].status, 'stale', 'record changed after approval: not applied, proposed again next run');
});

test('rejected and developer items are not repeated; an approved improvement goes to the Developer pipeline', async () => {
  const e = env({ WEBSITE_REPO: 'booksharekh-website' });
  mockFetch([routes.telegram, website(fixture()).route, routes.dispatchOk, routes.workflowOk]);
  await runInspection(e, { trigger: 'schedule' });
  const author = findings(e, "kind='author_case'")[0];
  await telegram(e, tap(`wo:r:${author.id}:au:0`));
  const dev = findings(e, "kind='dev:genre_management'")[0];
  await telegram(e, tap(`wo:d:${dev.id}:dv:0`));
  assert.equal(findings(e, `id=${dev.id}`)[0].status, 'assigned');
  const task = e.DB.db.prepare("SELECT task_type, request_text FROM tasks WHERE task_type='website_code_change'").get();
  assert.match(task.request_text, /Genre merge and delete/);

  await runInspection(e, { trigger: 'schedule' });
  assert.equal(findings(e, `id=${author.id}`)[0].status, 'rejected', 'still rejected');
  assert.equal(findings(e, "kind='author_case'").length, 1, 'not proposed again');
  assert.equal(findings(e, "kind='dev:genre_management'").length, 1, 'developer item not repeated');
});

test('/admin ops opens the Website Operations menu; sections are one line per finding', async () => {
  const e = env();
  const calls = mockFetch([routes.telegram, website(fixture()).route]);
  await runInspection(e, { trigger: 'schedule' });
  await telegram(e, msg('/admin ops'));
  const menu = sent(calls).at(-1);
  assert.match(menu.text, /^Website Operations\n\nPending corrections:/);
  const labels = menu.reply_markup.inline_keyboard.flat().map(b => b.text);
  for (const l of ['Approvals', 'Books', 'Genres', 'Authors', 'Categories', 'Files', 'Analytics', 'Reviews', 'Audiobooks', 'Book Requests', 'Recommendations', 'Automation', 'AI Usage']) assert.ok(labels.includes(l), l);
  await telegram(e, tap('wo:s:gn:0'));
  const edit = calls.filter(c => c.url.endsWith('/editMessageText')).at(-1).body;
  assert.match(edit.text, /^Website Operations \| Genres\n\d+ open/);
  assert.ok(edit.text.split('\n').slice(3).every(l => l.startsWith('#')), 'one line per finding');
  await telegram(e, msg('/admin ops schedule sat 09:30'));
  assert.equal(sent(calls).at(-1).text, 'Weekly inspection: Saturday 09:30 (Phnom Penh)');
});

test('Khmer bot: Website Operations messages are Khmer, technical words stay English', async () => {
  const e = env({ BOT_LANGUAGE: 'km' });
  const calls = mockFetch([routes.telegram, website(fixture()).route]);
  await runInspection(e, { trigger: 'schedule' });
  const s = sent(calls).at(-1);
  assert.match(s.text, /^Website Operations \| ប្រចាំសប្តាហ៍\n\nសៀវភៅបានពិនិត្យ: 2\n/);
  assert.match(s.text, /ការកែតម្រូវរង់ចាំ: \d+ \(សុវត្ថិភាព \d+\)\nបញ្ហាសម្រាប់ Developer: \d+/);
  assert.equal(s.reply_markup.inline_keyboard[0][0].text, 'ពិនិត្យ');
  const line = findings(e, "kind='title_spacing'")[0].line;
  assert.match(line, /^ដកឃ្លាចំណងជើង · /);
  assert.match(findings(e, "kind='file_missing'")[0].line, /^គ្មាន PDF ឬ EPUB · /, 'PDF/EPUB stay English');
  await telegram(e, msg('/admin ops schedule fri 08:00'));
  assert.equal(sent(calls).at(-1).text, 'ពិនិត្យប្រចាំសប្តាហ៍: ថ្ងៃសុក្រ 08:00 (ម៉ោងភ្នំពេញ)');
});
