// Book pipeline: request alerts -> public-domain search -> private draft -> hash-bound publish approval.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { downloadFile } from '../src/books/gutenberg.js';
import { approveButton, auditEvents, drain, lastText, latestTask, makeEnv, mockFetch, msg, press, routes, sent, steps, telegram } from './harness.mjs';

const BOOKS = {
  2701: { id: 2701, title: 'Moby Dick; Or, The Whale', authors: [{ name: 'Melville, Herman' }], subjects: ['Whaling -- Fiction', 'Sea stories'], languages: ['en'],
    copyright: false, summaries: ['A whaling voyage.'], formats: { 'application/epub+zip': 'http://www.gutenberg.org/ebooks/2701.epub3.images', 'image/jpeg': 'http://www.gutenberg.org/cache/epub/2701/pg2701.cover.medium.jpg' } },
  12: { id: 12, title: 'Moby Dick (French)', authors: [{ name: 'Melville, Herman' }], languages: ['fr'], copyright: false, formats: { 'application/epub+zip': 'https://www.gutenberg.org/ebooks/12.epub' } },
  9: { id: 9, title: 'Still In Copyright', authors: [{ name: 'Someone' }], languages: ['en'], copyright: true, formats: { 'application/epub+zip': 'https://www.gutenberg.org/ebooks/9.epub' } },
  10: { id: 10, title: 'Text Only', authors: [], languages: ['en'], copyright: false, formats: { 'text/plain': 'https://www.gutenberg.org/ebooks/10.txt' } },
};
const EPUB = new TextEncoder().encode('PK\x03\x04mimetypeapplication/epub+zip...book');
const COVER = new TextEncoder().encode('\xFF\xD8\xFFjpeg-cover');
const sha = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');

function site(state) {
  return [/^https:\/\/booksharekh\.com\/api\/ai\//, async (url, init) => {
    const u = new URL(url); const p = u.pathname; const method = init.method || 'GET';
    if (p === '/api/ai/drafts' && method === 'POST') { state.draftBody = JSON.parse(init.body); return Response.json({ draft: { id: 11 }, possible_duplicates: [] }, { status: 201 }); }
    if (p === '/api/ai/drafts/11/files') {
      const type = init.body.get('type'); const bytes = new Uint8Array(await init.body.get('file').arrayBuffer());
      state.files[type] = await sha(bytes);
      return Response.json({ type, size: bytes.byteLength, sha256: state.files[type] }, { status: 201 });
    }
    if (p === '/api/ai/drafts/11/publish') {
      const b = JSON.parse(init.body); state.publish = b;
      const want = Object.fromEntries(Object.entries(state.files).sort());
      if (JSON.stringify(b.approved_files) !== JSON.stringify(want)) return Response.json({ error: 'The files changed after approval.' }, { status: 409 });
      return Response.json({ book: { id: 77, slug: 'moby-dick-or-the-whale' } }, { status: 201 });
    }
    if (p === '/api/ai/requests') { const after = Number(u.searchParams.get('after_id')); return Response.json({ data: state.requests.filter(r => r.id > after) }); }
    const rm = p.match(/^\/api\/ai\/requests\/(\d+)$/);
    if (rm && method === 'GET') return Response.json({ request: state.requests.find(r => r.id === Number(rm[1])) });
    if (rm && method === 'PATCH') { const r = state.requests.find(x => x.id === Number(rm[1])); Object.assign(r, JSON.parse(init.body)); return Response.json({ request: r }); }
    return new Response('nf', { status: 404 });
  }];
}
const gutendex = [/^https:\/\/gutendex\.com\/books/, url => {
  const u = new URL(url);
  const id = u.pathname.match(/\/books\/(\d+)$/)?.[1];
  if (id) return BOOKS[id] ? Response.json(BOOKS[id]) : new Response('nf', { status: 404 });
  return Response.json({ results: Object.values(BOOKS) });
}];
const gutenbergFiles = [/^https:\/\/www\.gutenberg\.org\/(ebooks|cache)\//, url => new Response(url.endsWith('.jpg') ? COVER : EPUB)];

const apiEnv = (over = {}) => makeEnv({ LARAVEL_API_URL: 'https://booksharekh.com', LARAVEL_API_TOKEN: 'bsk_ai_SECRET', ...over });
const setup = (state = { files: {}, requests: [] }) => ({ state, calls: mockFetch([routes.telegram, gutendex, gutenbergFiles, site(state)]) });

test('/research offers only public-domain titles that have an EPUB', async () => {
  const env = apiEnv(); const { calls } = setup();
  await telegram(env, msg('/research moby dick'));
  const out = sent(calls).at(-1);
  assert.match(out.text, /1\. Moby Dick; Or, The Whale — Herman Melville \(en\)\n   https:\/\/www\.gutenberg\.org\/ebooks\/2701/);
  assert.doesNotMatch(out.text, /Still In Copyright|Text Only|French/);
  assert.equal(new URL(calls.find(c => c.url.includes('gutendex')).url).searchParams.get('languages'), 'en', 'asks for English editions');
  assert.deepEqual(out.reply_markup.inline_keyboard.flat().map(b => b.callback_data), ['bi:2701:0']);
});

test('Prepare draft → private draft with EPUB and cover → Publish approval bound to file hashes → published', async () => {
  const env = apiEnv(); const { state, calls } = setup();
  await telegram(env, press('bi:2701:0'));
  assert.match(lastText(calls), /Preparing a private draft of "Moby Dick; Or, The Whale"/);
  const task = latestTask(env);
  assert.equal(task.task_type, 'book_import');
  await drain(env);

  const downloads = calls.filter(c => c.url.includes('gutenberg.org/')).map(c => c.url);
  assert.ok(downloads.every(u => u.startsWith('https://www.gutenberg.org/')), 'http upgraded to https, gutenberg.org only');
  assert.equal(state.draftBody.idempotency_key, task.id);
  assert.equal(state.draftBody.rights_status, 'public_domain_verified');
  assert.equal(state.draftBody.author, 'Herman Melville');
  assert.deepEqual(state.draftBody.genres, ['Whaling', 'Sea stories']);
  assert.deepEqual(Object.keys(state.files).sort(), ['cover', 'epub']);
  assert.equal(latestTask(env).status, 'awaiting_approval');
  const preview = sent(calls).at(-1).text;
  assert.match(preview, /Draft ready on booksharekh\.com \(private[\s\S]*Rights: public domain \(Project Gutenberg #2701\)[\s\S]*Proposed action: Publish this book on booksharekh\.com/);
  assert.equal(state.publish, undefined, 'nothing published before approval');

  await telegram(env, press(approveButton(calls)));
  await drain(env);
  assert.deepEqual(state.publish.approved_files, { cover: state.files.cover, epub: state.files.epub });
  assert.match(state.publish.approval_id, /^APR-/);
  assert.equal(latestTask(env).status, 'completed');
  assert.match(sent(calls).map(m => m.text).join('\n'), /✅ Published "Moby Dick; Or, The Whale" by Herman Melville on booksharekh\.com \(book #77/);
  assert.deepEqual(steps(env, task.id).map(s => `${s.action}:${s.status}`), ['prepare_draft:completed', 'publish_book:completed']);
  assert.ok(auditEvents(env, task.id).includes('APPROVE'));
});

test('a changed draft invalidates the publish approval', async () => {
  const env = apiEnv(); const { state, calls } = setup();
  await telegram(env, press('bi:2701:0'));
  await drain(env);
  const task = latestTask(env);
  const prep = steps(env, task.id)[0];
  const out = JSON.parse(prep.output); out.files.epub = 'f'.repeat(64);
  env.DB.db.prepare('UPDATE agent_tasks SET output=? WHERE id=?').run(JSON.stringify(out), prep.id);
  await telegram(env, press(approveButton(calls)));
  await drain(env);
  assert.equal(state.publish, undefined, 'publish never called');
  assert.equal(latestTask(env).status, 'failed');
  assert.match(lastText(calls), /changed after it was approved/);
});

test('only gutenberg.org downloads, only public-domain titles, no double import', async () => {
  await assert.rejects(downloadFile('https://oceanofpdf.com/book.epub'), /non-Gutenberg/);
  await assert.rejects(downloadFile('https://gutenberg.org.evil.example/x.epub'), /non-Gutenberg/);
  const env = apiEnv(); const { calls } = setup();
  await telegram(env, press('bi:9:0'));
  assert.match(lastText(calls), /not marked public domain/);
  await telegram(env, press('bi:10:0'));
  assert.match(lastText(calls), /not marked public domain with an EPUB/);
  assert.equal(latestTask(env), undefined);
  await telegram(env, press('bi:2701:0'));
  await telegram(env, press('bi:2701:0'));
  assert.match(lastText(calls), /already being imported/);
});

test('imports need the website API', async () => {
  const env = makeEnv(); const { calls } = setup();
  await telegram(env, press('bi:2701:0'));
  assert.match(lastText(calls), /website API is not connected yet/);
  assert.equal(latestTask(env), undefined);
});

test('book requests: silent first poll, then alerts; Find → legal search → import marks the request done', async () => {
  const env = apiEnv();
  const { state, calls } = setup({ files: {}, requests: [{ id: 4, book_title: 'Old request', status: 'pending' }] });
  await worker.scheduled({}, env, {});
  assert.match(lastText(calls), /Watching booksharekh\.com book requests from #4/);
  assert.doesNotMatch(sent(calls).map(m => m.text).join('\n'), /Old request/, 'no flood of old requests');

  state.requests.push({ id: 5, book_title: 'Moby Dick', author: 'Herman Melville', language: 'English', status: 'pending' });
  await worker.scheduled({}, env, {});
  const alert = sent(calls).at(-1);
  assert.match(alert.text, /📚 New book request #5\nMoby Dick — Herman Melville \(English\)/);
  assert.deepEqual(alert.reply_markup.inline_keyboard[0].map(b => b.callback_data), ['rq:5', 'rr:5']);
  await worker.scheduled({}, env, {});
  assert.equal(sent(calls).filter(m => /request #5/.test(m.text)).length, 1, 'each request announced once');

  await telegram(env, press('rq:5'));
  assert.equal(state.requests[1].status, 'approved');
  assert.deepEqual(sent(calls).at(-1).reply_markup.inline_keyboard.flat().map(b => b.callback_data), ['bi:2701:5']);
  await telegram(env, press('bi:2701:5'));
  await drain(env);
  await telegram(env, press(approveButton(calls)));
  await drain(env);
  assert.equal(state.requests[1].status, 'done');
  assert.match(state.requests[1].note, /book #77/);
  assert.match(sent(calls).map(m => m.text).join('\n'), /Book request #5 marked done/);
});

test('/requests lists pending requests made before the watcher started, with buttons', async () => {
  const env = apiEnv();
  const { calls } = setup({ files: {}, requests: [{ id: 3, book_title: 'Done one', status: 'done' }, { id: 4, book_title: 'testing', author: 'Testing', status: 'pending' }] });
  await worker.scheduled({}, env, {});
  await telegram(env, msg('/requests'));
  const out = sent(calls).at(-1);
  assert.match(out.text, /📚 New book request #4\ntesting — Testing/);
  assert.deepEqual(out.reply_markup.inline_keyboard[0].map(b => b.callback_data), ['rq:4', 'rr:4']);
  assert.equal(sent(calls).filter(m => /Done one/.test(m.text)).length, 0, 'only pending');
});

test('a request with no legal copy says so; reject marks it rejected', async () => {
  const env = apiEnv();
  const state = { files: {}, requests: [{ id: 6, book_title: 'A 2024 Bestseller', status: 'pending' }] };
  const c2 = mockFetch([routes.telegram, [/gutendex/, () => Response.json({ results: [] })], site(state)]);
  await telegram(env, press('rq:6'));
  assert.match(lastText(c2), /No public-domain copy of "A 2024 Bestseller"[\s\S]*licensed copy/);
  await telegram(env, press('rr:6'));
  assert.equal(state.requests[0].status, 'rejected');
  assert.match(lastText(c2), /Book request #6 rejected/);
  assert.equal(latestTask(env), undefined, 'nothing imported');
});

test('non-owners cannot import books or act on requests', async () => {
  const env = apiEnv(); const { state, calls } = setup({ files: {}, requests: [{ id: 7, book_title: 'X', status: 'pending' }] });
  for (const d of ['bi:2701:0', 'rq:7', 'rr:7']) await telegram(env, press(d, 999));
  assert.equal(latestTask(env), undefined);
  assert.equal(state.requests[0].status, 'pending');
  assert.equal(calls.filter(c => c.url.includes('booksharekh.com') || c.url.includes('gutendex')).length, 0);
});

test('a book-source outage gives a short notice instead of a raw timeout error', async () => {
  const env = apiEnv({ BOT_LANGUAGE: 'km' });
  const calls = mockFetch([routes.telegram, [/gutendex/, () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }]]);
  await telegram(env, msg('/research pride and prejudice'));
  assert.equal(lastText(calls), '🔧 ប្រភពសៀវភៅ (Project Gutenberg) មិនដំណើរការបណ្ដោះអាសន្ន។ សូមសាកម្តងទៀតពេលក្រោយ។');
  const c2 = mockFetch([routes.telegram, [/gutendex/, () => new Response('Temporarily Down for Maintenance', { status: 503 })]]);
  await telegram(env, press('bi:2701:0'));
  assert.match(lastText(c2), /🔧 ប្រភពសៀវភៅ/);
  assert.doesNotMatch(sent(c2).map(m => m.text).join('\n'), /aborted|មិនអាចដំណើរការសារ/, 'no raw error');
});
