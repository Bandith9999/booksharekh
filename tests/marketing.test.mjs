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
  return [/\/api\/ai\/books\?/, url => {
    const p = new URL(url).searchParams;
    assert.equal(p.get('promo'), '1');
    return Response.json({ data: p.has('popular') ? [book(1, 'Emma', 'Jane Austen', 50), book(2, 'Dracula', 'Bram Stoker', 9)] : [book(3, 'New Book', 'Sok Dara'), book(1, 'Emma', 'Jane Austen')] });
  }];
}
const upload = (e, taskId, i, bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), secret = 'cb-secret') =>
  worker.fetch(new Request(`https://w.example/job-video/${taskId}/${i}`, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'content-type': 'video/mp4' }, body: bytes }), e);

test('/promo: 1 popular + 1 new book → Khmer captions → approve → videos and captions in Telegram', async () => {
  const e = env();
  const calls = mockFetch([tgOk, routes.dispatchOk, promoSite()]);
  await telegram(e, msg('/promo'));
  assert.equal(lastText(calls), '🎬 កំពុងសរសេរ caption…');
  await drain(e);
  const approval = sent(calls).at(-1);
  assert.match(approval.text, /^🎬 វីដេអូ 2\n\n1\. 🔥 ពេញនិយម Emma — Jane Austen\n「[^」]+」[\s\S]*2\. 🆕 ថ្មី New Book — Sok Dara[\s\S]*👉 បង្កើតវីដេអូ\?$/);
  const task = latestTask(e);
  assert.equal(task.task_type, 'book_promo');
  assert.equal(calls.filter(c => c.url.endsWith('/dispatches')).length, 0, 'nothing rendered before approval');

  await telegram(e, press(approveButton(calls)));
  await drain(e);
  const d = calls.filter(c => c.url.endsWith('/dispatches'));
  assert.equal(d.length, 1);
  assert.match(d[0].url, /\/repos\/owner\/repo\/actions\/workflows\/worker-job\.yml\/dispatches$/);

  const got = await (await job(e, 'GET', `/job/${task.id}`)).json();
  assert.deepEqual(got.videos.map(v => [v.title, v.cover_url]), [['Emma', `${SITE}/covers/1.jpg`], ['New Book', `${SITE}/covers/3.jpg`]]);
  assert.ok(got.videos[0].hook && got.videos[0].lines.length);

  assert.equal((await upload(e, task.id, 0, undefined, 'wrong')).status, 401);
  assert.equal((await upload(e, task.id, 5)).status, 400);
  assert.equal((await upload(e, task.id, 0)).status, 200);
  const video = calls.filter(c => c.url.endsWith('/sendVideo')).map(c => Object.fromEntries(c.body.entries()));
  assert.equal(video.length, 1);
  assert.match(video[0].caption, /^\*\*\* វីដេអូផ្សព្វផ្សាយ \*\*\*\n🎬 1\/2 · Emma — Jane Austen/);
  assert.ok(video[0].video instanceof Blob);
  assert.match(lastText(calls), /BookShareKH[\s\S]*https:\/\/booksharekh\.com\/book\/b1\n\n#BookShareKH/, 'caption alone, ready to copy');
  assert.equal((await (await upload(e, task.id, 0)).json()).duplicate, true, 'a retried upload is not sent twice');
  assert.equal(calls.filter(c => c.url.endsWith('/sendVideo')).length, 1);
  await upload(e, task.id, 1);

  await job(e, 'POST', '/job-result', { task_id: task.id, status: 'completed', note: '2 promo video(s) sent to Telegram.' });
  assert.equal(lastText(calls), '✅ វីដេអូរួចរាល់ — post លើ TikTok / Facebook');
  assert.equal(latestTask(e).status, 'completed');

  // Promoted books are skipped for 14 days: next /promo picks Dracula (popular), and no new book is left.
  await telegram(e, msg('/promo'));
  await drain(e);
  assert.match(sent(calls).at(-1).text, /^🎬 វីដេអូ 1\n\n1\. 🔥 ពេញនិយម Dracula/);
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

test('/recommend: at least 10 popular books the site lacks, public-domain ones get an import button', async () => {
  const e = env();
  const s = recommendSources();
  const calls = mockFetch(s.routes);
  await telegram(e, msg('/recommend'));
  const m = sent(calls).at(-1);
  const lines = m.text.split('\n').filter(l => /^\d+\. /.test(l));
  assert.match(m.text, /^\*\*\* ណែនាំសៀវភៅ \*\*\*\n📈 សៀវភៅពេញនិយម ដែលវេបសាយមិនទាន់មាន:/);
  assert.ok(lines.length >= 10 && lines.length <= 12, `got ${lines.length}`);
  assert.ok(!m.text.includes('Atomic Habits'), 'books already on the site are skipped');
  assert.match(m.text, /\d+\. Trending 0 — Author 0 \(2020\) 🔒/);
  assert.match(m.text, /\d+\. Classic 0 — Old0 Writer 🟢/);
  const buttons = m.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.length >= 3 && buttons.every(b => /^bi:10\d:0$/.test(b.callback_data)), 'import buttons only for public domain');

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
