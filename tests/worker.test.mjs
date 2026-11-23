// End-to-end: Telegram → queue → planning → approval → queue → GitHub dispatch → callback → Telegram.
// These are the Phase 1 tests, updated for Phase 2's queued execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OWNER, anthropicEnv, approvals, dispatches, drain, job, lastText, latestTask, makeEnv, mockFetch, msg,
  planTask, press, routes, sent, steps, telegram, worker,
} from './harness.mjs';

test('webhook rejects a wrong secret', async () => {
  const env = makeEnv(); mockFetch([routes.telegram]);
  assert.equal((await telegram(env, msg('/help'), 'wrong')).status, 403);
});

test('full flow: task → approve once → GitHub job → callback → Telegram report', async () => {
  const env = makeEnv();
  const calls = mockFetch([routes.telegram, routes.dispatchOk]);

  await telegram(env, msg('/task Make a short promotional video for an authorized sample book'));
  let task = latestTask(env);
  assert.equal(task.status, 'planning', 'webhook only records and enqueues');
  assert.match(lastText(calls), /received/);

  await drain(env);
  task = latestTask(env);
  assert.equal(task.status, 'awaiting_approval');
  assert.equal(task.task_type, 'video_demo');
  const approve = sent(calls).at(-1).reply_markup.inline_keyboard[0][0].callback_data;
  assert.match(approve, /^ap:APR-/);

  await telegram(env, press(approve));
  assert.equal(latestTask(env).status, 'queued');
  assert.equal(dispatches(calls).length, 0, 'dispatch happens in the queue, not the webhook');
  await drain(env);
  assert.equal(latestTask(env).status, 'running');
  assert.equal(dispatches(calls).length, 1);
  assert.deepEqual(dispatches(calls)[0].body, { ref: 'main', inputs: { task_id: task.id } });

  await telegram(env, press(approve)); // second press
  await drain(env);
  assert.equal(dispatches(calls).length, 1, 'no duplicate dispatch');
  assert.match(lastText(calls), /already been handled/);

  const got = await job(env, 'GET', `/job/${task.id}`);
  assert.equal(got.status, 200);
  assert.equal((await got.json()).task_type, 'video_demo');

  const done = await job(env, 'POST', '/job-result', { task_id: task.id, status: 'completed', run_url: 'https://github.com/owner/repo/actions/runs/42', note: 'ok' });
  assert.equal(done.status, 200);
  assert.equal(latestTask(env).status, 'completed');
  assert.deepEqual(steps(env, task.id).map(s => s.status), ['completed', 'completed']);
  assert.equal(env.DB.db.prepare('SELECT status FROM workflow_runs WHERE task_id=?').get(task.id).status, 'completed');
  assert.equal(env.DB.db.prepare("SELECT uri FROM task_artifacts WHERE task_id=? AND kind='github_run'").get(task.id).uri, 'https://github.com/owner/repo/actions/runs/42');
  assert.match(lastText(calls), /completed[\s\S]*actions\/runs\/42/);

  const again = await job(env, 'POST', '/job-result', { task_id: task.id, status: 'failed', note: 'late' });
  assert.equal(again.status, 409, 'finished task cannot be changed');
});

test('non-owner messages and button presses are ignored', async () => {
  const env = makeEnv();
  const calls = mockFetch([routes.telegram, routes.dispatchOk]);
  await telegram(env, msg('/task do something', 999));
  assert.equal(latestTask(env), undefined);
  const { approve } = await planTask(env, calls, '/task do something');
  await telegram(env, press(approve, 999));
  await drain(env);
  assert.equal(latestTask(env).status, 'awaiting_approval');
  assert.equal(dispatches(calls).length, 0);
});

test('duplicate Telegram update is processed once', async () => {
  const env = makeEnv(); const calls = mockFetch([routes.telegram]);
  const body = JSON.stringify({ update_id: 5, ...msg('/help') });
  const send = () => worker.fetch(new Request('https://w.example/telegram', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'hook-secret' }, body }), env);
  await send(); const res = await send();
  assert.equal((await res.json()).duplicate, true);
  assert.equal(sent(calls).length, 1);
});

test('/task without text shows usage; /rememberX is not treated as /remember', async () => {
  const env = makeEnv(); const calls = mockFetch([routes.telegram]);
  await telegram(env, msg('/task'));
  assert.match(lastText(calls), /^Use: \/task/);
  assert.equal(latestTask(env), undefined);
  await telegram(env, msg('/rememberfoo=bar'));
  assert.match(lastText(calls), /Unknown command/);
});

test('Claude 401 → plan_failed, no buttons, cannot be approved', async () => {
  const env = anthropicEnv();
  const calls = mockFetch([routes.telegram, routes.dispatchOk,
    [/api\.anthropic\.com/, () => Response.json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, { status: 401 })]]);
  await telegram(env, msg('/task write a report'));
  await drain(env);
  const task = latestTask(env);
  assert.equal(task.status, 'plan_failed');
  const out = sent(calls).at(-1);
  assert.equal(out.reply_markup, undefined);
  assert.match(out.text, /HTTP 401[\s\S]*Claude Console/);
  assert.doesNotMatch(out.text, /SECRET-VALUE/);
  assert.equal(calls.filter(c => c.url.includes('anthropic')).length, 1, 'auth errors are not retried');
  assert.equal(approvals(env, task.id).length, 0);
  assert.equal(dispatches(calls).length, 0);
});

test('Claude request shape and text extraction', async () => {
  const env = anthropicEnv();
  const calls = mockFetch([routes.telegram, routes.anthropicPlan()]);
  const { task } = await planTask(env, calls, '/task write a report');
  const req = calls.find(c => c.url.endsWith('/v1/messages'));
  assert.equal(req.init.headers['x-api-key'], 'sk-ant-SECRET-VALUE', 'key is trimmed');
  assert.equal(req.body.model, 'claude-sonnet-5-5');
  assert.ok(req.body.max_tokens >= 1000, 'room for thinking + answer');
  assert.equal(req.body.output_config.effort, 'low');
  assert.equal(req.body.output_config.format.type, 'json_schema');
  assert.doesNotMatch(JSON.stringify(req.body.output_config.format.schema), /maxLength|maxItems/, 'unsupported constraints are stripped');
  assert.equal(req.body.fallbacks, undefined, 'refusal fallback is opt-in');
  assert.match(req.body.messages[0].content, /<owner_request>\nwrite a report\n<\/owner_request>/);
  assert.equal(task.status, 'awaiting_approval');
  assert.match(sent(calls).at(-1).text, /Plan by anthropic\/claude-sonnet-5-5[\s\S]*Check rights, then render/);

  const env2 = anthropicEnv({ ANTHROPIC_REFUSAL_FALLBACK: 'true' });
  const calls2 = mockFetch([routes.telegram, routes.anthropicPlan()]);
  await planTask(env2, calls2, '/task write a report');
  const req2 = calls2.find(c => c.url.endsWith('/v1/messages'));
  assert.equal(req2.body.fallbacks, 'default');
  assert.equal(req2.init.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
});

test('Claude refusal or truncation → plan_failed', async () => {
  for (const stop_reason of ['refusal', 'max_tokens']) {
    const env = anthropicEnv();
    const calls = mockFetch([routes.telegram, [/api\.anthropic\.com/, () => Response.json({ stop_reason, content: [{ type: 'text', text: 'partial' }] })]]);
    await telegram(env, msg('/task write a report'));
    await drain(env);
    assert.equal(latestTask(env).status, 'plan_failed', stop_reason);
    assert.equal(calls.filter(c => c.url.includes('anthropic')).length, 1, `${stop_reason} is not retried`);
  }
});

test('GitHub 403 → task failed with permission hint', async () => {
  const env = makeEnv();
  const calls = mockFetch([routes.telegram, [/\/dispatches$/, () => Response.json({ message: 'Resource not accessible by personal access token' }, { status: 403 })]]);
  const { task, approve } = await planTask(env, calls, '/task write a report');
  await telegram(env, press(approve));
  await drain(env);
  const row = latestTask(env);
  assert.equal(row.status, 'failed');
  assert.match(row.result_note, /HTTP 403.*Actions: Read and write/);
  assert.match(lastText(calls), /Actions: Read and write/);
  assert.equal(dispatches(calls).length, 1, '4xx is not retried');
  assert.equal(approvals(env, task.id)[0].status, 'failed');
});

test('/diag reports problems without leaking secret values', async () => {
  const env = anthropicEnv();
  const calls = mockFetch([routes.telegram, routes.workflowOk,
    [/api\.anthropic\.com\/v1\/models\//, () => Response.json({ error: { type: 'authentication_error', message: 'invalid x-api-key' } }, { status: 401 })]]);
  await telegram(env, msg('/diag'));
  const text = lastText(calls);
  assert.match(text, /anthropic\/claude-sonnet-5-5: HTTP 401/);
  assert.match(text, /GitHub token can read worker-job\.yml/);
  assert.match(text, /Task queue bound/);
  assert.match(text, /Agent registry valid/);
  assert.match(text, /Phase 2 tables present/);
  assert.doesNotMatch(text, /SECRET-VALUE/);
});

test('processing error notifies owner and returns 200 so Telegram stops retrying', async () => {
  const env = makeEnv();
  let n = 0;
  const calls = mockFetch([[/api\.telegram\.org/, () => (++n === 1 ? new Response('down', { status: 502 }) : Response.json({ ok: true }))]]);
  const res = await telegram(env, msg('/status'));
  assert.equal(res.status, 200);
  assert.match(lastText(calls), /could not be processed/);
});

test('job endpoints require the callback secret', async () => {
  const env = makeEnv(); mockFetch([routes.telegram]);
  const res = await worker.fetch(new Request('https://w.example/job-result', { method: 'POST', body: '{}' }), env);
  assert.equal(res.status, 401);
  assert.equal(OWNER, 111);
});
