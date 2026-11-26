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

test('/promo: ONE value video (education first) → AI concept + Khmer script with voice-over → approve → video + caption in Telegram', async () => {
  const e = env();
  const calls = mockFetch([tgOk, routes.dispatchOk, promoSite()]);
  await telegram(e, msg('/promo'));
  assert.equal(lastText(calls), '🎬 កំពុងសរសេរ script វីដេអូ…');
  await drain(e);
  const approval = sent(calls).at(-1);
  assert.match(approval.text, /^🎬 BookShareKH \[DEMO\]\n🎓 education\n🧠 Hook with a question[^\n]+\n🎨 minimal · kdamthmor · ocean\n🎙 calm, warm[^\n]+\n📚 Emma · Dracula\n1\. ចង់អានសៀវភៅល្អៗ\?\n   🔊 [^\n]+\n2\. [\s\S]*👉 បង្កើតវីដេអូ\?$/,
    "shows the kind, the AI's own concept, the style, voice style, books, on-screen text and voice-over");
  const task = latestTask(e);
  assert.equal(task.task_type, 'book_promo');

  // The first theme in rotation is education, not the website: no price facts, no member count.
  const step = e.DB.db.prepare("SELECT input FROM agent_tasks WHERE task_id=? AND action='write_promo'").get(task.id);
  const input = JSON.parse(step.input);
  assert.equal(input.kind, 'education');
  assert.equal(input.members, null);
  assert.deepEqual(input.candidates.map(c => c.id), [1, 2, 4, 3], 'books the AI may talk about');
  const { promoAction } = await import('../src/marketing/promo.js');
  const req = await promoAction.buildRequest(e, { agentTask: { input: step.input } });
  assert.doesNotMatch(req.messages[0].content, /\$0\.50|KHQR/, 'no price facts outside website videos');
  assert.match(req.messages[0].content, /<kind>[\s\S]*education/);

  // One at a time: a second /promo while this one is open is refused.
  await telegram(e, msg('/promo'));
  assert.match(lastText(calls), /^⏳ មានវីដេអូមួយកំពុងធ្វើ/);

  await telegram(e, press(approveButton(calls.filter(c => !/⏳/.test(c.body?.text || '')))));
  await drain(e);
  assert.equal(calls.filter(c => c.url.endsWith('/dispatches')).length, 1);

  const old = await job(e, 'GET', `/job/${task.id}`);
  assert.equal(old.status, 409, 'an out-of-date runner on main gets no promo job');
  assert.match((await old.json()).error, /merge the latest code into main/);
  const v5 = await worker.fetch(new Request(`https://w.example/job/${task.id}`, { headers: { Authorization: 'Bearer cb-secret', 'X-Runner-Version': '5' } }), e);
  assert.equal(v5.status, 409, 'a runner without the video styles gets nothing');
  const got = await (await worker.fetch(new Request(`https://w.example/job/${task.id}`, { headers: { Authorization: 'Bearer cb-secret', 'X-Runner-Version': '6' } }), e)).json();
  assert.equal(got.videos.length, 1);
  assert.equal(got.videos[0].voice, 'km-KH-SreymomNeural', 'fallback voice');
  assert.deepEqual([got.videos[0].tts, got.videos[0].kind, got.videos[0].style, got.videos[0].font, got.videos[0].palette], ['gemini', 'education', 'minimal', 'kdamthmor', 'ocean']);
  assert.ok(got.videos[0].scenes.every(s => s.text && s.voice));
  assert.deepEqual(got.videos[0].scenes.map(s => s.book), [-1, 0, 1], 'each scene knows which book it shows');
  assert.deepEqual(got.videos[0].covers, [`${SITE}/covers/1.jpg`, `${SITE}/covers/2.jpg`]);

  assert.equal((await upload(e, task.id, 0, undefined, 'wrong')).status, 401);
  assert.equal((await upload(e, task.id, 1)).status, 400, 'only one video per task');
  assert.equal((await upload(e, task.id, 0)).status, 200);
  const video = calls.filter(c => c.url.endsWith('/sendVideo')).map(c => Object.fromEntries(c.body.entries()));
  assert.equal(video.length, 1);
  assert.equal(video[0].caption, '📣 Marketing · *** វីដេអូផ្សព្វផ្សាយ ***\n🎬 BookShareKH [DEMO]\n👇 Caption នៅសារបន្ទាប់ (copy យកទៅ post)');
  assert.match(lastText(calls), /^\[DEMO\][\s\S]*📖 booksharekh\.com\n\n#BookShareKH/, 'caption alone, ready to copy');
  assert.equal((await (await upload(e, task.id, 0)).json()).duplicate, true, 'a retried upload is not sent twice');

  await job(e, 'POST', '/job-result', { task_id: task.id, status: 'completed', note: 'Promo video sent to Telegram.' });
  assert.equal(lastText(calls), '✅ វីដេអូរួចរាល់ — post លើ TikTok / Facebook');

  // Next video: a different theme and kind, books used this week go last, and the AI sees the last
  // video (kind, style, palette, font, hook) so it does something new.
  await telegram(e, msg('/promo'));
  await drain(e);
  const next = JSON.parse(e.DB.db.prepare("SELECT input FROM agent_tasks WHERE action='write_promo' ORDER BY rowid DESC LIMIT 1").get().input);
  assert.notEqual(next.theme, input.theme);
  assert.equal(next.kind, 'recommend');
  assert.deepEqual(next.candidates.map(c => c.id), [4, 3, 1, 2], 'books used this week go last');
  assert.deepEqual(next.recent_videos[0], { kind: 'education', style: 'minimal', palette: 'ocean', font: 'kdamthmor', hook: 'ចង់អានសៀវភៅល្អៗ?' });
  const { pickVideoDesign } = await import('../src/marketing/promo.js');
  assert.notEqual(pickVideoDesign({ style: 'minimal', font: 'kdamthmor', body_font: 'battambang', palette: 'ocean' }, next.recent_videos[0]).palette, 'ocean',
    'never the same palette twice in a row');
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
  assert.match(v.caption, /🎬 BookShareKH \[DEMO\] \(គ្មានសំឡេង\)/);
});

test('a promo job that reports "completed" without sending any video is reported as a failure', async () => {
  const e = env();
  const calls = mockFetch([tgOk, routes.dispatchOk, promoSite()]);
  await telegram(e, msg('/promo'));
  await drain(e);
  await telegram(e, press(approveButton(calls)));
  await drain(e);
  await job(e, 'POST', '/job-result', { task_id: latestTask(e).id, status: 'completed', note: 'Demo artifacts generated.' });
  assert.match(lastText(calls), /^❌ បង្កើតវីដេអូមិនបាន: nothing was received/);
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
  assert.match(m.text, /^👑 Administrator · \*\*\* ណែនាំសៀវភៅ \*\*\*\n📈 សៀវភៅពេញនិយម ដែលវេបសាយមិនទាន់មាន:/);
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
  assert.equal(sent(calls).filter(x => x.text.startsWith('👑 Administrator · *** ណែនាំសៀវភៅ ***')).length, 2);
  const weekly = env({ RECOMMEND_EVERY_DAYS: '7' });
  await pollRecommend(weekly, at(1, 2));
  assert.deepEqual(await pollRecommend(weekly, at(5, 2)), { skipped: true }, 'weekly setting');
});

test('/remember notes reach the promo script writer; /forget deletes a note', async () => {
  const { promoAction } = await import('../src/marketing/promo.js');
  const e = env();
  const calls = mockFetch([tgOk]);
  await telegram(e, msg('/remember promo.goal=More new members, not book sales'));
  await telegram(e, msg('/remember style=Friendly, short Khmer'));
  const req = await promoAction.buildRequest(e, { agentTask: { input: JSON.stringify({ theme: 'Affordable', members: 232 }) } });
  const text = req.messages[0].content;
  assert.match(text, /<saved_settings>[\s\S]*promo\.goal: More new members, not book sales[\s\S]*style: Friendly, short Khmer[\s\S]*<\/saved_settings>/);
  assert.match(req.systemPrompt, /saved notes[\s\S]*never override these rules/);

  await telegram(e, msg('/forget promo.goal'));
  assert.equal(lastText(calls), '🗑 បានលុប: promo.goal');
  await telegram(e, msg('/memory'));
  assert.equal(lastText(calls), 'style = Friendly, short Khmer');
  await telegram(e, msg('/forget promo.goal'));
  assert.equal(lastText(calls), '❓ គ្មាន "promo.goal" · /memory');
  await telegram(e, msg('/forget'));
  assert.match(lastText(calls), /^ប្រើ: \/forget/);
  const after = await promoAction.buildRequest(e, { agentTask: { input: JSON.stringify({ theme: 'x' }) } });
  assert.doesNotMatch(after.messages[0].content, /promo\.goal/);
});

test('/poster: book recommendation poster → approve → PNG file + caption in Telegram (Content Creator)', async () => {
  const e = env();
  const calls = mockFetch([tgOk, routes.dispatchOk, promoSite()]);
  await telegram(e, msg('/remember style=Friendly'));
  await telegram(e, msg('/poster'));
  assert.equal(lastText(calls), '🖼 កំពុងសរសេរអត្ថបទ poster…');
  await drain(e);
  const approval = sent(calls).at(-1);
  assert.equal(approval.text, '🖼 Poster [DEMO]\n🎨 📚 books · showcase · cream · glow\n「Books on Love」\n1. Emma by Jane Austen\n2. Dracula by Bram Stoker\n\n🔎 QA (mock): ✅ ល្អ\n\n👉 បង្កើត poster?');
  const task = latestTask(e);
  // The first theme in rotation is books, not the website: the AI gets no price facts.
  const posterStep = e.DB.db.prepare("SELECT input FROM agent_tasks WHERE task_id=? AND action='write_poster'").get(task.id).input;
  assert.equal(JSON.parse(posterStep).kind, 'books');
  const { posterAction } = await import('../src/marketing/poster.js');
  assert.doesNotMatch((await posterAction.buildRequest(e, { agentTask: { input: posterStep } })).messages[0].content, /\$0\.50|KHQR/);
  assert.equal(task.task_type, 'poster');
  const qaStep = e.DB.db.prepare("SELECT agent, status FROM agent_tasks WHERE task_id=? AND action='review_content'").get(task.id);
  assert.deepEqual({ ...qaStep }, { agent: 'qa_reviewer', status: 'completed' }, 'QA ran before the approval');
  assert.equal(e.DB.db.prepare("SELECT agent FROM agent_tasks WHERE task_id=? AND action='write_poster'").get(task.id).agent, 'content_creator');

  await telegram(e, msg('/poster'));
  assert.match(lastText(calls), /^⏳ មាន poster មួយកំពុងធ្វើ/, 'one poster at a time');
  await telegram(e, msg('/promo'));
  assert.equal(lastText(calls), '🎬 កំពុងសរសេរ script វីដេអូ…', 'a video can be made at the same time');
  await drain(e);

  const approveData = sent(calls).filter(m => m.reply_markup && /👉 បង្កើត poster\?/.test(m.text)).at(-1).reply_markup.inline_keyboard[0][0].callback_data;
  await telegram(e, press(approveData));
  await drain(e);
  const runner = v => worker.fetch(new Request(`https://w.example/job/${task.id}`, { headers: { Authorization: 'Bearer cb-secret', 'X-Runner-Version': String(v) } }), e);
  assert.equal((await runner(6)).status, 409, 'a runner without the E-Library renderer gets nothing');
  const got = await (await runner(7)).json();
  // Textless image: only the heading and the covers go to the renderer.
  assert.deepEqual(got.posters[0], { layout: 'showcase', palette: 'cream', decor: 'glow',
    heading: 'Books on Love', covers: [`${SITE}/covers/1.jpg`, `${SITE}/covers/2.jpg`], logo_url: null });

  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const up = (path) => worker.fetch(new Request(`https://w.example${path}`, { method: 'POST', headers: { Authorization: 'Bearer cb-secret', 'content-type': 'image/png' }, body: png }), e);
  assert.equal((await up(`/job-video/${task.id}/0`)).status, 409, 'a poster task does not accept videos');
  assert.equal((await up(`/job-image/${task.id}/0`)).status, 200);
  const doc = Object.fromEntries(calls.find(c => c.url.endsWith('/sendDocument')).body.entries());
  assert.equal(doc.caption, '📣 Marketing · *** Poster ផ្សព្វផ្សាយ ***\n🖼 Poster [DEMO]\n👇 Caption នៅសារបន្ទាប់ (copy យកទៅ post)');
  assert.ok(doc.document instanceof Blob && doc.document.type === 'image/png', 'sent as a file: full quality');
  assert.match(lastText(calls), /^\[DEMO\][\s\S]*#BookShareKH/);
  await job(e, 'POST', '/job-result', { task_id: task.id, status: 'completed', note: 'Poster sent to Telegram.' });
  assert.equal(lastText(calls), '✅ Poster រួចរាល់ — post លើ Facebook / Instagram');
});

test('QA by Gemini: issues are shown in the approval; if Gemini is not set up, QA is skipped and the approval still comes', async () => {
  // Real routing: Claude writes, Gemini reviews. No GEMINI_API_KEY → QA skipped, never blocks.
  const claudePoster = { title: 'Poster', kind: 'books', design: { layout: 'showcase', palette: 'blush', decor: 'shelf' }, cover_ids: [2, 3, 1], heading: 'Read More', caption: 'x\n📖 booksharekh.com', hashtags: ['#BookShareKH', '#a', '#b'] };
  const anthropic = [/api\.anthropic\.com\/v1\/messages$/, () => Response.json({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: 'text', text: JSON.stringify(claudePoster) }] })];
  const base = { AI_PAID_ENABLED: 'true', AI_PROVIDER: 'anthropic', AI_MODEL: 'claude-sonnet-5-5', ANTHROPIC_API_KEY: 'sk-ant-x', AI_REVIEW_PROVIDER: 'google', AI_REVIEW_MODEL: 'gemini-3.8-flash' };

  const noKey = env(base);
  const c1 = mockFetch([tgOk, routes.dispatchOk, promoSite(), anthropic]);
  await telegram(noKey, msg('/poster'));
  await drain(noKey);
  const a1 = sent(c1).at(-1);
  assert.match(a1.text, /🔎 QA: មិនបានពិនិត្យ \(not set up\)\n\n👉 បង្កើត poster\?$/);
  assert.ok(a1.reply_markup, 'approval buttons still sent');
  assert.equal(c1.filter(c => /generativelanguage/.test(c.url)).length, 0);

  const withKey = env({ ...base, GEMINI_API_KEY: 'g-key' });
  const review = { agent: 'qa_reviewer', task_id: 'x', result: 'requires_changes', issues: ['ពាក្យ "ចូលមើល" គួរថា "ចូលមើលឥឡូវនេះ"'], human_approval_required: true };
  const c2 = mockFetch([tgOk, routes.dispatchOk, promoSite(), anthropic,
    [/generativelanguage\.googleapis\.com/, () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(review) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 }, modelVersion: 'gemini-3.8-flash' })]]);
  await telegram(withKey, msg('/poster'));
  await drain(withKey);
  const g = c2.find(c => /generativelanguage/.test(c.url));
  assert.ok(g, 'Gemini was asked');
  assert.match(JSON.stringify(g.body), /Read More/, 'Gemini reviewed the poster text');
  assert.match(sent(c2).at(-1).text, /🔎 QA \(Gemini\): ⚠️ គួរកែ:\n• ពាក្យ "ចូលមើល" គួរថា "ចូលមើលឥឡូវនេះ"\n\n👉 បង្កើត poster\?$/);
});

test('hashtags: no "Khmer book" tags in any language; #BookShareKH and #សៀវភៅបរទេសល្បីៗ always included', async () => {
  const { cleanHashtags } = await import('../src/marketing/promo.js');
  assert.deepEqual(cleanHashtags(['#KhmerBooks', 'សៀវភៅខ្មែរ', '#khmer_book', '#Reading', '#BookShareKH', '#សៀវភៅ', 'Book Tok']),
    ['#BookShareKH', '#សៀវភៅបរទេសល្បីៗ', '#Reading', '#សៀវភៅ', '#BookTok']);
  assert.deepEqual(cleanHashtags([]), ['#BookShareKH', '#សៀវភៅបរទេសល្បីៗ']);
});

test('a finished job stays finished even if the "done" message to Telegram fails; Telegram 429 is retried once', async () => {
  const e = env();
  let tgCalls = 0;
  const calls = mockFetch([[/api\.telegram\.org/, () => { tgCalls++; return tgCalls === 1 ? Response.json({ ok: false, parameters: { retry_after: 0 } }, { status: 429 }) : Response.json({ ok: true, result: {} }); }],
    routes.dispatchOk, promoSite()]);
  await telegram(e, msg('/poster'));
  assert.equal(tgCalls, 2, 'the first send hit 429 and was retried');
  await drain(e);
  await telegram(e, press(approveButton(calls)));
  await drain(e);
  const t = latestTask(e);
  await worker.fetch(new Request(`https://w.example/job-image/${t.id}/0`, { method: 'POST', headers: { Authorization: 'Bearer cb-secret', 'content-type': 'image/png' }, body: new Uint8Array([1]) }), e);
  mockFetch([[/api\.telegram\.org/, () => Response.json({ ok: false }, { status: 500 })]]); // Telegram down for the "done" notice
  const r = await job(e, 'POST', '/job-result', { task_id: t.id, status: 'completed', note: 'Poster sent to Telegram.' });
  assert.equal(r.status, 200, 'the runner sees success');
  assert.equal(latestTask(e).status, 'completed');
});

test('website images: the video AI picks a background from /api/ai/media; logo always used; unknown names and payment images never used', async () => {
  const { backgroundOf, logoOf, mediaForPrompt } = await import('../src/marketing/promo.js');
  const e = env();
  const media = [
    { name: 'dist/img/logo/logo.png', url: `${SITE}/dist/img/logo/logo.png`, width: 3500, height: 3500 },
    { name: 'dist/img/library-bg.jpg', url: `${SITE}/dist/img/library-bg.jpg`, width: 1376, height: 768 },
    { name: 'images/banner.png', url: 'https://evil.example/banner.png', width: 10, height: 10 },
  ];
  const calls = mockFetch([tgOk, routes.dispatchOk, promoSite(), [/\/api\/ai\/media$/, () => Response.json({ data: media })]]);
  await telegram(e, msg('/promo'));
  await drain(e);
  const step = JSON.parse(e.DB.db.prepare("SELECT input FROM agent_tasks WHERE action='write_promo' ORDER BY rowid DESC LIMIT 1").get().input);
  assert.deepEqual(step.media.map(m => m.name), ['dist/img/logo/logo.png', 'dist/img/library-bg.jpg'], 'images from another host are dropped');
  assert.match(sent(calls).at(-1).text, /\n🏞 library-bg\.jpg\n/, 'the owner sees which photo will be used');
  await telegram(e, press(approveButton(calls)));
  await drain(e);
  const got = await (await worker.fetch(new Request(`https://w.example/job/${latestTask(e).id}`, { headers: { Authorization: 'Bearer cb-secret', 'X-Runner-Version': '6' } }), e)).json();
  assert.equal(got.videos[0].background_url, `${SITE}/dist/img/library-bg.jpg`);
  assert.equal(got.videos[0].logo_url, `${SITE}/dist/img/logo/logo.png`);

  // Posters use the logo only (a small signature), never a background photo.
  await telegram(e, msg('/poster'));
  await drain(e);
  const pstep = JSON.parse(e.DB.db.prepare("SELECT input FROM agent_tasks WHERE action='write_poster' ORDER BY rowid DESC LIMIT 1").get().input);
  assert.equal(pstep.logo_url, `${SITE}/dist/img/logo/logo.png`);
  assert.equal(pstep.media, undefined, 'no background photo choice for posters');

  assert.equal(backgroundOf(step.media, 'dist/img/logo/logo.png'), null, 'the logo is never a background');
  assert.equal(backgroundOf(step.media, 'https://evil.example/x.png'), null, 'only listed images');
  assert.equal(backgroundOf(step.media, 'none'), null);
  assert.equal(logoOf(step.media), `${SITE}/dist/img/logo/logo.png`);
  assert.doesNotMatch(mediaForPrompt(step.media), /logo|https?:/, 'the AI sees names only, no URLs, no logo');
});

test('before the website has /api/ai/media, the logo and library photo are offered', async () => {
  const { siteMedia } = await import('../src/website/laravel-api.js');
  const e = env();
  mockFetch([[/\/api\/ai\/media$/, () => new Response('nf', { status: 404 })]]);
  assert.deepEqual((await siteMedia(e)).map(m => m.url), [`${SITE}/dist/img/logo/logo.png`, `${SITE}/dist/img/library-bg.jpg`]);
});

test('poster covers: the AI picks real covers only; used covers are remembered so the next poster shows other books', async () => {
  const { chosenCovers, posterCandidates, POSTER_COVERS, POSTER_COVER_DAYS } = await import('../src/marketing/poster.js');
  const { markPromoted } = await import('../src/marketing/promo.js');
  const cands = [1, 2, 3, 4].map(id => ({ id, cover_url: `${SITE}/c/${id}.jpg`, title: `B${id}` }));
  assert.deepEqual(chosenCovers(cands, [3, 99, 3, 1]).map(c => c.id), [3, 1], 'unknown ids and repeats dropped');
  assert.deepEqual(chosenCovers(cands, [3], 2).map(c => c.id), [3, 1], 'filled up to the layout minimum');
  assert.deepEqual(chosenCovers(cands, [4, 3, 2, 1]).map(c => c.id), [4, 3, 2], 'max 3 books');
  const e = env();
  mockFetch([promoSite()]);
  assert.deepEqual((await posterCandidates(e)).map(c => c.id), [1, 2, 4, 3]);
  await markPromoted(e, [1, 2], POSTER_COVERS, POSTER_COVER_DAYS);
  assert.deepEqual((await posterCandidates(e)).map(c => c.id), [4, 3, 1, 2], 'books already on a poster go last');
});

test('the GitHub job gets only this task\'s approved images, through the bot and the site API', async () => {
  const e = env();
  const calls = mockFetch([tgOk, routes.dispatchOk, promoSite(),
    [/\/api\/ai\/media\/file\?path=covers%2F1\.jpg$/, () => new Response(new Uint8Array([255, 216, 255]), { headers: { 'content-type': 'image/jpeg' } })]]);
  await telegram(e, msg('/poster'));
  await drain(e);
  await telegram(e, press(approveButton(calls)));
  await drain(e);
  const t = latestTask(e);
  const get = (url, secret = 'cb-secret') => worker.fetch(new Request(`https://w.example/job-asset/${t.id}?url=${encodeURIComponent(url)}`, { headers: { Authorization: `Bearer ${secret}` } }), e);
  assert.equal((await get(`${SITE}/covers/1.jpg`, 'wrong')).status, 401);
  assert.equal((await get(`${SITE}/.env`)).status, 403, 'not an approved image');
  assert.equal((await get('https://evil.example/x.jpg')).status, 403);
  const ok = await get(`${SITE}/covers/1.jpg`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual([...new Uint8Array(await ok.arrayBuffer())], [255, 216, 255]);
});
