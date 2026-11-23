// Marketing promo videos (/promo) and Admin book recommendations (/recommend + every 3 days).
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { approveButton, drain, job, lastText, latestTask, makeEnv, mockFetch, msg, press, routes, sent, telegram } from './harness.mjs';
import { pollRecommend } from '../src/marketing/recommend.js';

const SITE = 'https://booksharekh.com';
const env = (more = {}) => makeEnv({ BOT_LANGUAGE: 'km', LARAVEL_API_URL: SITE, LARAVEL_API_TOKEN: 'bsk_ai_x', ...more });
const book = (id, title, author, views = 0) => ({ id, title, author, views, url: `${SITE}/book/b${id}`, cover_url: `${SITE}/covers/${id}.jpg`, description: 'A classic.' });
const tgOk = [/api\.telegram\.org/, () => Response.json({ ok: true, result: {} })];

function promoSite() {
  return [/\/api\/ai\/(books\?|users\/activity)/, url => {
    if (url.includes('/users/activity')) return Response.json({ now: '2026-11-23 10:00:00', total_users: 232, registered: [], logins: [] });
    const p = new URL(url).searchParams;
    assert.equal(p.get('promo'), '1');
    return Response.json({ data: p.has('popular') ? [book(1, 'Emma', 'Jane Austen', 50), book(2, 'Dracula', 'Bram Stoker', 9), book(4, 'Ulysses', 'James Joyce', 5)] : [book(3, 'New Book', 'Sok Dara'), book(1, 'Emma', 'Jane Austen')] });
  }];
}
const upload = (e, taskId, i, bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), secret = 'cb-secret', query = '?voiced=1') =>
  worker.fetch(new Request(`https://w.example/job-video/${taskId}/${i}${query}`, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'content-type': 'video/mp4' }, body: bytes }), e);

test('/promo: ONE website video → Khmer script with voice-over → approve → video + caption in Telegram', async () => {
  const e = env();
  const calls = mockFetch([tgOk, routes.dispatchOk, promoSite()]);
  await telegram(e, msg('/promo'));
  assert.equal(lastText(calls), '🎬 កំពុងសរសេរ script វីដេអូ…');
  await drain(e);
  const approval = sent(calls).at(-1);
  assert.match(approval.text, /^🎬 BookShareKH \[DEMO\]\n1\. ចង់អានសៀវភៅល្អៗ\?\n   🔊 [^\n]+\n2\. [\s\S]*👉 បង្កើតវីដេអូ\?$/, 'shows on-screen text and voice-over');
  assert.doesNotMatch(approval.text, /Emma|Jane Austen/, 'promotes the website, not a book');
  const task = latestTask(e);
  assert.equal(task.task_type, 'book_promo');

  // The AI got only code-defined site facts, a theme and the real member count; no book titles.
  const step = e.DB.db.prepare("SELECT input FROM agent_tasks WHERE task_id=? AND action='write_promo'").get(task.id);
  const input = JSON.parse(step.input);
  assert.equal(input.members, 232);
  assert.match(input.theme, /BookShareKH/);
  assert.deepEqual(input.covers.map(c => c.id), [1, 2, 3], '2 most viewed + 1 newest cover, visuals only');

  // One at a time: a second /promo while this one is open is refused.
  await telegram(e, msg('/promo'));
  assert.match(lastText(calls), /^⏳ មានវីដេអូមួយកំពុងធ្វើ/);

  await telegram(e, press(approveButton(calls.filter(c => !/⏳/.test(c.body?.text || '')))));
  await drain(e);
  assert.equal(calls.filter(c => c.url.endsWith('/dispatches')).length, 1);

  const got = await (await job(e, 'GET', `/job/${task.id}`)).json();
  assert.equal(got.videos.length, 1);
  assert.equal(got.videos[0].voice, 'km-KH-SreymomNeural');
  assert.ok(got.videos[0].scenes.every(s => s.text && s.voice));
  assert.deepEqual(got.videos[0].covers, [`${SITE}/covers/1.jpg`, `${SITE}/covers/2.jpg`, `${SITE}/covers/3.jpg`]);

  assert.equal((await upload(e, task.id, 0, undefined, 'wrong')).status, 401);
  assert.equal((await upload(e, task.id, 1)).status, 400, 'only one video per task');
  assert.equal((await upload(e, task.id, 0)).status, 200);
  const video = calls.filter(c => c.url.endsWith('/sendVideo')).map(c => Object.fromEntries(c.body.entries()));
  assert.equal(video.length, 1);
  assert.equal(video[0].caption, '*** វីដេអូផ្សព្វផ្សាយ ***\n🎬 BookShareKH [DEMO]\n👇 Caption នៅសារបន្ទាប់ (copy យកទៅ post)');
  assert.match(lastText(calls), /^\[DEMO\][\s\S]*📖 booksharekh\.com\n\n#BookShareKH/, 'caption alone, ready to copy');
  assert.equal((await (await upload(e, task.id, 0)).json()).duplicate, true, 'a retried upload is not sent twice');

  await job(e, 'POST', '/job-result', { task_id: task.id, status: 'completed', note: 'Promo video sent to Telegram.' });
  assert.equal(lastText(calls), '✅ វីដេអូរួចរាល់ — post លើ TikTok / Facebook');

  // Next video: a different theme, and covers used this week are skipped when possible.
  await telegram(e, msg('/promo'));
  await drain(e);
  const next = JSON.parse(e.DB.db.prepare("SELECT input FROM agent_tasks WHERE action='write_promo' ORDER BY rowid DESC LIMIT 1").get().input);
  assert.notEqual(next.theme, input.theme);
  assert.equal(next.covers[0].id, 4, 'an unused popular cover comes first');
});

test('the video says when it has no voice-over', async () => {
  const e = env();
  const calls = mockFetch([tgOk, routes.dispatchOk, promoSite()]);
  await telegram(e, msg('/promo'));
  await drain(e);
  await telegram(e, press(approveButton(calls)));
  await drain(e);
  await upload(e, latestTask(e).id, 0, undefined, 'cb-secret', '?voiced=0');
  const v = Object.fromEntries(calls.find(c => c.url.endsWith('/sendVideo')).body.entries());
  assert.match(v.caption, /🎬 BookShareKH \[DEMO\] \(គ្មានសំឡេងលើកនេះ\)/);
});

test('a promo job that reports "completed" without sending any video is reported as a failure', async () => {
  const e = env();
  const calls = mockFetch([tgOk, routes.dispatchOk, promoSite()]);
  await telegram(e, msg('/promo'));
  await drain(e);
  await telegram(e, press(approveButton(calls)));
  await drain(e);
  await job(e, 'POST', '/job-result', { task_id: latestTask(e).id, status: 'completed', note: 'Demo artifacts generated.' });
  assert.match(lastText(calls), /^❌ បង្កើតវីដេអូមិនបាន: no video was received/);
});

test('video uploads are refused unless the promo task is running', async () => {
  const e = env();
  mockFetch([tgOk, routes.dispatchOk, promoSite()]);
  await telegram(e, msg('/promo'));
  await drain(e); // waiting for approval, not running
  assert.equal((await upload(e, latestTask(e).id, 0)).status, 409);
});

// ---------- recommendations ----------
function recommendSources({ onSite = ['Atomic Habits'] } = {}) {
  const searched = [];
  return { searched, routes: [
    tgOk,
    [/openlibrary\.org\/trending\/weekly\.json/, () => Response.json({ works: [
      { title: 'Atomic Habits', author_name: ['James Clear'], first_publish_year: 2016, language: ['eng'] },
      ...Array.from({ length: 10 }, (_, i) => ({ title: `Trending ${i}`, author_name: [`Author ${i}`], first_publish_year: 2020 + (i % 5), language: ['eng'] })),
    ] })],
    [/gutendex\.com\/books\/\?languages=en&copyright=false/, () => Response.json({ results: Array.from({ length: 6 }, (_, i) => ({
      id: 100 + i, title: `Classic ${i}`, authors: [{ name: `Writer, Old${i}` }], languages: ['en'], copyright: false, formats: { 'application/epub+zip': `https://www.gutenberg.org/ebooks/${100 + i}.epub3.images` },
    })) })],
    [/\/api\/ai\/books\/search/, url => {
      const q = new URL(url).searchParams.get('q');
      searched.push(q);
      return Response.json({ data: onSite.filter(t => t.toLowerCase().includes(q)).map((t, i) => ({ id: i + 1, title: t, author: 'x' })) });
    }],
  ] };
}

test('/recommend: at least 10 popular books the site lacks, as a plain title — author list', async () => {
  const e = env();
  const s = recommendSources();
  const calls = mockFetch(s.routes);
  await telegram(e, msg('/recommend'));
  const m = sent(calls).at(-1);
  const lines = m.text.split('\n').filter(l => /^\d+\. /.test(l));
  assert.match(m.text, /^\*\*\* ណែនាំសៀវភៅ \*\*\*\n📈 សៀវភៅពេញនិយម ដែលវេបសាយមិនទាន់មាន:/);
  assert.ok(lines.length >= 10 && lines.length <= 12, `got ${lines.length}`);
  assert.ok(!m.text.includes('Atomic Habits'), 'books already on the site are skipped');
  assert.match(m.text, /\n\d+\. Trending 0 — Author 0\n/);
  assert.match(m.text, /\n\d+\. Classic 0 — Old0 Writer(\n|$)/);
  for (const l of lines) assert.match(l, /^\d+\. [^—]+ — [^—]+$/, 'title — author only');
  assert.doesNotMatch(m.text, /🟢|🔒|📥|copyright|license|public domain|\(20\d\d\)/i, 'no marks, years or rights notes');
  assert.equal(m.reply_markup, undefined, 'no buttons');

  await telegram(e, msg('/recommend'));
  assert.equal(sent(calls).filter(x => /Trending 0 —/.test(x.text)).length, 1, 'not recommended again within 21 days');
});

test('automatic recommendations: every 3 days at 09:00 Phnom Penh, once per window', async () => {
  const e = env();
  const calls = mockFetch(recommendSources().routes);
  const at = (d, h, min = 0) => new Date(Date.UTC(2026, 10, d, h, min));
  assert.deepEqual(await pollRecommend(e, at(22, 5)), { skipped: true }, 'not at 02:00 UTC');
  assert.deepEqual(await pollRecommend(e, at(22, 2)), { sent: true });
  assert.deepEqual(await pollRecommend(e, at(22, 2, 2)), { skipped: true }, 'not twice in the same window');
  assert.deepEqual(await pollRecommend(e, at(24, 2)), { skipped: true }, '2 days later: too early');
  assert.deepEqual(await pollRecommend(e, at(25, 2)), { sent: true }, '3 days later');
  assert.equal(sent(calls).filter(x => x.text.startsWith('*** ណែនាំសៀវភៅ ***')).length, 2);
  const weekly = env({ RECOMMEND_EVERY_DAYS: '7' });
  await pollRecommend(weekly, at(1, 2));
  assert.deepEqual(await pollRecommend(weekly, at(5, 2)), { skipped: true }, 'weekly setting');
});
