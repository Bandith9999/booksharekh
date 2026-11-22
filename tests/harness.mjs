// Shared test harness: D1 emulated by node:sqlite running the real migrations (foreign keys on),
// Cloudflare Queues emulated with retry + dead-letter semantics, and every outbound fetch mocked.
// No test ever calls a paid model or a real external API.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';

export { worker };
export const OWNER = 111;
const MIGRATIONS = ['0001_init.sql', '0002_multi_agent.sql'].map(f => readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));

export function makeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const m of MIGRATIONS) db.exec(m);
  const d1 = {
    db, failOn: null, // set to a RegExp to simulate D1 errors for matching SQL
    prepare(sql) {
      let args = [];
      const guard = () => { if (d1.failOn?.test(sql)) throw new Error('D1_ERROR: simulated outage'); };
      const stmt = {
        bind(...a) { args = a.map(v => (v === undefined ? null : v)); return stmt; },
        async run() { guard(); const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
        async all() { guard(); return { success: true, results: db.prepare(sql).all(...args) }; },
        async first() { guard(); return db.prepare(sql).get(...args) ?? null; },
      };
      return stmt;
    },
  };
  return d1;
}

export function makeQueue() {
  const q = { main: [], dlq: [], retries: [], sent: [] };
  q.binding = { async send(body) { q.sent.push(body); q.main.push({ body: structuredClone(body), attempts: 1 }); } };
  return q;
}

// Deliver queued messages until both queues are empty (delays are not simulated, only recorded).
export async function drain(env, { maxRetries = 5, dlqMaxRetries = 2, limit = 300 } = {}) {
  const q = env.__queue;
  for (let i = 0; i < limit && (q.main.length || q.dlq.length); i++) {
    const fromDlq = !q.main.length;
    const item = (fromDlq ? q.dlq : q.main).shift();
    let outcome = null, delay = null;
    const message = { id: `m${i}`, body: item.body, attempts: item.attempts, timestamp: new Date(),
      ack() { outcome = 'ack'; }, retry(o) { outcome = 'retry'; delay = o?.delaySeconds ?? null; } };
    await worker.queue({ queue: fromDlq ? 'booksharekh-tasks-dlq' : 'booksharekh-tasks', messages: [message], ackAll() {}, retryAll() {} }, env, {});
    if (outcome !== 'retry') continue;
    q.retries.push({ body: item.body, attempts: item.attempts, delay, fromDlq });
    if (item.attempts > (fromDlq ? dlqMaxRetries : maxRetries)) { if (!fromDlq) q.dlq.push({ body: item.body, attempts: 1 }); }
    else (fromDlq ? q.dlq : q.main).push({ body: item.body, attempts: item.attempts + 1 });
  }
}

// routes: [RegExp, (url, init, call) => Response]
export function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    const call = { url, init, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    for (const [re, fn] of routes) if (re.test(url)) return fn(url, init, call);
    throw new Error(`unexpected fetch ${url}`);
  };
  return calls;
}

export const PLAN = {
  summary: 'Check rights, then render a sample card video.',
  steps: [{ agent: 'book_researcher', objective: 'Confirm the sample book is authorized' }, { agent: 'video_creator', objective: 'Render the sample card' }],
  risks: ['Publishing needs owner approval'],
  needs_rights_verification: true,
};
export const routes = {
  telegram: [/api\.telegram\.org/, () => Response.json({ ok: true, result: {} })],
  dispatchOk: [/\/dispatches$/, () => new Response(null, { status: 204 })],
  workflowOk: [/actions\/workflows\/worker-job\.yml$/, () => Response.json({ id: 1 })],
  anthropicPlan: (plan = PLAN) => [/api\.anthropic\.com\/v1\/messages$/, () => Response.json({
    model: 'claude-sonnet-5-5', stop_reason: 'end_turn', usage: { input_tokens: 120, output_tokens: 80 },
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(plan) }],
  })],
  openaiPlan: (plan = PLAN) => [/api\.openai\.com\/v1\/chat\/completions$/, () => Response.json({
    model: 'gpt-5-mini', usage: { prompt_tokens: 90, completion_tokens: 60 },
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(plan) } }],
  })],
};

export function makeEnv(over = {}) {
  const queue = makeQueue();
  return {
    DB: makeD1(), TASK_QUEUE: queue.binding, __queue: queue,
    OWNER_TELEGRAM_ID: String(OWNER), TELEGRAM_BOT_TOKEN: 'TG-SECRET-VALUE', TELEGRAM_WEBHOOK_SECRET: 'hook-secret',
    GITHUB_TOKEN: 'GH-SECRET-VALUE', GITHUB_OWNER: 'owner', GITHUB_REPO: 'repo', JOB_CALLBACK_SECRET: 'cb-secret',
    AI_PROVIDER: 'mock', ...over,
  };
}
// Paid adapters are tested with paid AI explicitly unlocked, as an owner would have to do.
export const anthropicEnv = (over = {}) => makeEnv({ AI_PAID_ENABLED: 'true', AI_PROVIDER: 'anthropic', AI_MODEL: 'claude-sonnet-5-5', ANTHROPIC_API_KEY: 'sk-ant-SECRET-VALUE\n', ...over });

let updateId = 1000;
export function telegram(env, payload, secret = 'hook-secret') {
  return worker.fetch(new Request('https://w.example/telegram', {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret, 'content-type': 'application/json' },
    body: JSON.stringify({ update_id: ++updateId, ...payload }),
  }), env);
}
export const msg = (text, from = OWNER) => ({ message: { message_id: 1, from: { id: from }, chat: { id: from, type: 'private' }, text } });
export const press = (data, from = OWNER) => ({ callback_query: { id: `q${updateId}`, from: { id: from }, message: { chat: { id: from, type: 'private' } }, data } });
export const job = (env, method, path, body) => worker.fetch(new Request(`https://w.example${path}`, {
  method, headers: { Authorization: 'Bearer cb-secret', 'content-type': 'application/json' }, body: body && JSON.stringify(body),
}), env);

export const sent = calls => calls.filter(c => c.url.endsWith('/sendMessage')).map(c => c.body);
export const lastText = calls => sent(calls).at(-1)?.text ?? '';
export const dispatches = calls => calls.filter(c => c.url.endsWith('/dispatches'));
export const latestTask = env => env.DB.db.prepare('SELECT * FROM tasks ORDER BY rowid DESC LIMIT 1').get();
export const steps = (env, taskId) => env.DB.db.prepare('SELECT * FROM agent_tasks WHERE task_id=? ORDER BY rowid').all(taskId);
export const approvals = (env, taskId) => env.DB.db.prepare('SELECT * FROM task_approvals WHERE task_id=? ORDER BY rowid').all(taskId);
export const auditEvents = (env, taskId) => env.DB.db.prepare('SELECT event FROM audit_log WHERE task_id=? ORDER BY id').all(taskId).map(r => r.event);
// The callback_data of the first button in the most recent message that had buttons.
export const approveButton = calls => sent(calls).filter(m => m.reply_markup).at(-1)?.reply_markup.inline_keyboard[0][0].callback_data;

// /task → plan → approval prompt. Returns the task row and the approve button data.
export async function planTask(env, calls, text = '/task Make a short promotional video for an authorized sample book') {
  await telegram(env, msg(text));
  await drain(env);
  return { task: latestTask(env), approve: approveButton(calls) };
}
