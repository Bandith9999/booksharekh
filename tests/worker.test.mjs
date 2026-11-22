// End-to-end tests of the Worker: Telegram → planning → approval → dispatch → callback → Telegram.
// D1 is emulated with node:sqlite running the real migration; all outbound fetches are mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';

const MIGRATION = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8');
const OWNER = 111;

function makeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(MIGRATION);
  return {
    db,
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...a) { args = a.map(v => (v === undefined ? null : v)); return stmt; },
        async run() { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
        async all() { return { success: true, results: db.prepare(sql).all(...args) }; },
        async first() { return db.prepare(sql).get(...args) ?? null; },
      };
      return stmt;
    },
  };
}

// routes: [regex, (url, init) => Response]
function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    const call = { url, init, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    for (const [re, fn] of routes) if (re.test(url)) return fn(url, init);
    throw new Error(`unexpected fetch ${url}`);
  };
  return calls;
}
const telegramOk = [/api\.telegram\.org/, () => Response.json({ ok: true, result: {} })];
const sent = calls => calls.filter(c => c.url.endsWith('/sendMessage')).map(c => c.body);
const dispatches = calls => calls.filter(c => c.url.endsWith('/dispatches'));

function makeEnv(over = {}) {
  return {
    DB: makeD1(), OWNER_TELEGRAM_ID: String(OWNER),
    TELEGRAM_BOT_TOKEN: 'TG-SECRET-VALUE', TELEGRAM_WEBHOOK_SECRET: 'hook-secret',
    GITHUB_TOKEN: 'GH-SECRET-VALUE', GITHUB_OWNER: 'owner', GITHUB_REPO: 'repo',
    JOB_CALLBACK_SECRET: 'cb-secret', AI_PROVIDER: 'mock', ...over,
  };
}
let updateId = 1000;
function telegram(env, payload, secret = 'hook-secret') {
  return worker.fetch(new Request('https://w.example/telegram', {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret, 'content-type': 'application/json' },
    body: JSON.stringify({ update_id: ++updateId, ...payload }),
  }), env);
}
const msg = (text, from = OWNER) => ({ message: { message_id: 1, from: { id: from }, chat: { id: from, type: 'private' }, text } });
const press = (data, from = OWNER) => ({ callback_query: { id: `q${updateId}`, from: { id: from }, message: { chat: { id: from, type: 'private' } }, data } });
const taskRow = env => env.DB.db.prepare('SELECT * FROM tasks ORDER BY rowid DESC LIMIT 1').get();
const job = (env, method, path, body) => worker.fetch(new Request(`https://w.example${path}`, {
  method, headers: { Authorization: 'Bearer cb-secret', 'content-type': 'application/json' }, body: body && JSON.stringify(body),
}), env);

test('webhook rejects a wrong secret', async () => {
  const env = makeEnv(); mockFetch([telegramOk]);
  assert.equal((await telegram(env, msg('/help'), 'wrong')).status, 403);
});

test('full flow: task → approve once → GitHub job → callback → Telegram report', async () => {
  const env = makeEnv();
  const calls = mockFetch([telegramOk, [/\/dispatches$/, () => new Response(null, { status: 204 })]]);

  await telegram(env, msg('/task Make a short promotional video for an authorized sample book'));
  let task = taskRow(env);
  assert.equal(task.status, 'pending');
  assert.equal(task.task_type, 'video_demo');
  assert.ok(sent(calls).at(-1).reply_markup, 'approval buttons shown');

  await telegram(env, press(`approve:${task.id}`));
  assert.equal(taskRow(env).status, 'queued');
  assert.equal(dispatches(calls).length, 1);
  assert.deepEqual(dispatches(calls)[0].body, { ref: 'main', inputs: { task_id: task.id } });

  await telegram(env, press(`approve:${task.id}`)); // second press
  assert.equal(dispatches(calls).length, 1, 'no duplicate dispatch');
  assert.match(sent(calls).at(-1).text, /already been handled/);

  const got = await job(env, 'GET', `/job/${task.id}`);
  assert.equal(got.status, 200);
  assert.equal((await got.json()).task_type, 'video_demo');

  const done = await job(env, 'POST', '/job-result', { task_id: task.id, status: 'completed', run_url: 'https://github.com/owner/repo/actions/runs/42', note: 'ok' });
  assert.equal(done.status, 200);
  task = taskRow(env);
  assert.equal(task.status, 'completed');
  assert.match(sent(calls).at(-1).text, /completed[\s\S]*actions\/runs\/42/);

  const again = await job(env, 'POST', '/job-result', { task_id: task.id, status: 'failed', note: 'late' });
  assert.equal(again.status, 409, 'finished task cannot be changed');
});

test('non-owner messages and button presses are ignored', async () => {
  const env = makeEnv();
  const calls = mockFetch([telegramOk, [/\/dispatches$/, () => new Response(null, { status: 204 })]]);
  await telegram(env, msg('/task do something', 999));
  assert.equal(taskRow(env), undefined);
  await telegram(env, msg('/task do something'));
  await telegram(env, press(`approve:${taskRow(env).id}`, 999));
  assert.equal(taskRow(env).status, 'pending');
  assert.equal(dispatches(calls).length, 0);
});

test('duplicate Telegram update is processed once', async () => {
  const env = makeEnv(); const calls = mockFetch([telegramOk]);
  const body = JSON.stringify({ update_id: 5, ...msg('/help') });
  const send = () => worker.fetch(new Request('https://w.example/telegram', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'hook-secret' }, body }), env);
  await send(); const res = await send();
  assert.equal((await res.json()).duplicate, true);
  assert.equal(sent(calls).length, 1);
});

test('/task without text shows usage; /rememberX is not treated as /remember', async () => {
  const env = makeEnv(); const calls = mockFetch([telegramOk]);
  await telegram(env, msg('/task'));
  assert.match(sent(calls).at(-1).text, /^Use: \/task/);
  assert.equal(taskRow(env), undefined);
  await telegram(env, msg('/rememberfoo=bar'));
  assert.match(sent(calls).at(-1).text, /Unknown command/);
});

const anthropicEnv = () => makeEnv({ AI_PROVIDER: 'anthropic', AI_MODEL: 'claude-sonnet-5-5', ANTHROPIC_API_KEY: 'sk-ant-SECRET-VALUE\n' });

test('Claude 401 → plan_failed, no buttons, cannot be approved', async () => {
  const env = anthropicEnv();
  const calls = mockFetch([telegramOk,
    [/api\.anthropic\.com/, () => Response.json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, { status: 401 })],
    [/\/dispatches$/, () => new Response(null, { status: 204 })]]);
  await telegram(env, msg('/task write a report'));
  const task = taskRow(env);
  assert.equal(task.status, 'plan_failed');
  const out = sent(calls).at(-1);
  assert.equal(out.reply_markup, undefined);
  assert.match(out.text, /HTTP 401[\s\S]*Claude Console/);
  assert.doesNotMatch(out.text, /SECRET-VALUE/);
  await telegram(env, press(`approve:${task.id}`));
  assert.equal(taskRow(env).status, 'plan_failed');
  assert.equal(dispatches(calls).length, 0);
});

test('Claude request shape and text extraction', async () => {
  const env = anthropicEnv();
  const calls = mockFetch([telegramOk, [/api\.anthropic\.com\/v1\/messages/, () => Response.json({
    stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Plan: Researcher checks rights.' }],
  })]]);
  await telegram(env, msg('/task write a report'));
  const req = calls.find(c => c.url.endsWith('/v1/messages'));
  assert.equal(req.init.headers['x-api-key'], 'sk-ant-SECRET-VALUE', 'key is trimmed');
  assert.equal(req.body.model, 'claude-sonnet-5-5');
  assert.ok(req.body.max_tokens >= 1000, 'room for thinking + answer');
  assert.deepEqual(req.body.output_config, { effort: 'low' });
  assert.equal(req.body.fallbacks, 'default');
  assert.equal(taskRow(env).status, 'pending');
  assert.match(sent(calls).at(-1).text, /Plan: Researcher checks rights\./);
});

test('Claude refusal or truncation → plan_failed', async () => {
  for (const stop_reason of ['refusal', 'max_tokens']) {
    const env = anthropicEnv();
    mockFetch([telegramOk, [/api\.anthropic\.com/, () => Response.json({ stop_reason, content: [{ type: 'text', text: 'partial' }] })]]);
    await telegram(env, msg('/task write a report'));
    assert.equal(taskRow(env).status, 'plan_failed', stop_reason);
  }
});

test('GitHub 403 → dispatch_failed with permission hint', async () => {
  const env = makeEnv();
  const calls = mockFetch([telegramOk, [/\/dispatches$/, () => Response.json({ message: 'Resource not accessible by personal access token' }, { status: 403 })]]);
  await telegram(env, msg('/task write a report'));
  await telegram(env, press(`approve:${taskRow(env).id}`));
  const task = taskRow(env);
  assert.equal(task.status, 'dispatch_failed');
  assert.match(task.result_note, /HTTP 403.*Actions: Read and write/);
  assert.match(sent(calls).at(-1).text, /Actions: Read and write/);
});

test('/diag reports problems without leaking secret values', async () => {
  const env = anthropicEnv();
  const calls = mockFetch([telegramOk,
    [/api\.anthropic\.com\/v1\/models\//, () => Response.json({ error: { type: 'authentication_error', message: 'invalid x-api-key' } }, { status: 401 })],
    [/actions\/workflows\/worker-job\.yml$/, () => Response.json({ id: 1 })]]);
  await telegram(env, msg('/diag'));
  const text = sent(calls).at(-1).text;
  assert.match(text, /Claude API HTTP 401/);
  assert.match(text, /GitHub token can read worker-job\.yml/);
  assert.match(text, /D1 database reachable/);
  assert.doesNotMatch(text, /SECRET-VALUE/);
});

test('processing error notifies owner and returns 200 so Telegram stops retrying', async () => {
  const env = makeEnv();
  let n = 0;
  const calls = mockFetch([[/api\.telegram\.org/, () => (++n === 1 ? new Response('down', { status: 502 }) : Response.json({ ok: true }))]]);
  const res = await telegram(env, msg('/help'));
  assert.equal(res.status, 200);
  assert.match(sent(calls).at(-1).text, /could not be processed/);
});

test('job endpoints require the callback secret', async () => {
  const env = makeEnv(); mockFetch([telegramOk]);
  const res = await worker.fetch(new Request('https://w.example/job-result', { method: 'POST', body: '{}' }), env);
  assert.equal(res.status, 401);
});
