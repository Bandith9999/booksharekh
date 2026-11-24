// Orchestration: state machine, scheduling, approvals, queue retries, dead letters, cancellation,
// budgets, fallback, audit, permissions and Phase 1 compatibility.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_TASK, TASK, canTransition, isTerminal, transition } from '../src/orchestration/state-machine.js';
import { approveStep, schedule } from '../src/orchestration/engine.js';
import { TOOLS, AGENTS, validateRegistry } from '../src/agents/registry.js';
import {
  OWNER, anthropicEnv, approvals, auditEvents, dispatches, drain, lastText, latestTask, makeEnv, mockFetch, msg,
  planTask, press, routes, sent, steps, telegram,
} from './harness.mjs';

const anthropicStatus = (status, headers = {}) => [/api\.anthropic\.com\/v1\/messages$/, () => Response.json({ error: { type: 'x', message: 'busy' } }, { status, headers })];
const anthropicCalls = calls => calls.filter(c => c.url.includes('api.anthropic.com')).length;

test('state machine allows only declared transitions', async () => {
  assert.ok(canTransition(TASK, 'planning', 'awaiting_approval'));
  assert.ok(canTransition(TASK, 'awaiting_approval', 'queued'));
  assert.ok(canTransition(TASK, 'pending', 'queued'), 'Phase 1 pending rows can still be approved');
  assert.ok(!canTransition(TASK, 'planning', 'running'), 'nothing runs before approval');
  assert.ok(!canTransition(TASK, 'awaiting_approval', 'running'));
  assert.ok(!canTransition(TASK, 'running', 'cancelled'), 'GitHub runs cannot be cancelled from here');
  for (const s of ['completed', 'failed', 'cancelled', 'rejected', 'plan_failed', 'dispatch_failed']) assert.ok(isTerminal(TASK, s), s);
  assert.ok(canTransition(AGENT_TASK, 'running', 'queued'), 'retry');
  assert.ok(!canTransition(AGENT_TASK, 'completed', 'queued'));

  const env = makeEnv();
  env.DB.db.prepare("INSERT INTO tasks (id,telegram_user_id,request_text,task_type,proposal,status) VALUES ('BSK-t','111','x','report','p','awaiting_approval')").run();
  assert.equal(await transition(env.DB, 'tasks', 'BSK-t', 'queued'), true);
  assert.equal(await transition(env.DB, 'tasks', 'BSK-t', 'queued'), false, 'second identical transition is a no-op');
  assert.equal(await transition(env.DB, 'tasks', 'BSK-t', 'awaiting_approval'), false, 'cannot go backwards');
  await assert.rejects(transition(env.DB, 'tasks', 'BSK-t', 'nonsense'), /Invalid transition/);
});

test('scheduler runs independent steps in parallel and respects dependencies', () => {
  const s = (id, status) => ({ id, status });
  const deps = [{ agent_task_id: 'B', depends_on_id: 'A' }, { agent_task_id: 'C', depends_on_id: 'A' }, { agent_task_id: 'D', depends_on_id: 'B' }, { agent_task_id: 'D', depends_on_id: 'C' }];
  let r = schedule([s('A', 'completed'), s('B', 'pending'), s('C', 'pending'), s('D', 'pending')], deps);
  assert.deepEqual(r.runnable.map(x => x.id), ['B', 'C'], 'B and C run in parallel');
  r = schedule([s('A', 'completed'), s('B', 'completed'), s('C', 'running'), s('D', 'pending')], deps);
  assert.deepEqual(r.runnable.map(x => x.id), [], 'D waits for both B and C');
  r = schedule([s('A', 'failed'), s('B', 'pending'), s('C', 'pending'), s('D', 'pending')], deps);
  assert.deepEqual(r.blocked.map(x => x.id), ['B', 'C'], 'dependents of a failed step are blocked');
  assert.deepEqual(schedule([s('X', 'pending')], []).runnable.map(x => x.id), ['X']);
});

test('registry: every agent has a prompt, known tools, and approval-gated external actions', () => {
  assert.deepEqual(validateRegistry(), []);
  assert.equal(Object.keys(AGENTS).length, 8, '7 specialists + Website Operations');
  for (const a of Object.values(AGENTS)) {
    assert.ok(a.prompt.system.includes('owner approval'), `${a.name} prompt states approval rules`);
    for (const t of a.allowedTools) assert.ok(TOOLS[t], `${a.name}: ${t}`);
    for (const act of Object.values(a.actions)) if (act.kind !== 'ai') assert.equal(act.requiresApproval, true);
  }
});

test('queue retries transient AI errors with backoff, then succeeds', async () => {
  const env = anthropicEnv();
  let n = 0;
  const ok = routes.anthropicPlan()[1];
  const calls = mockFetch([routes.telegram, [/api\.anthropic\.com\/v1\/messages$/, (...a) => (++n === 1
    ? Response.json({ error: { type: 'rate_limit_error', message: 'slow down' } }, { status: 429, headers: { 'retry-after': '7' } })
    : ok(...a))]]);
  const { task } = await planTask(env, calls, '/task write a report');
  assert.equal(task.status, 'awaiting_approval');
  assert.equal(anthropicCalls(calls), 2);
  assert.ok(env.__queue.retries[0].delay >= 7, 'Retry-After honoured');
  assert.equal(steps(env, task.id)[0].attempts, 2);
  const logs = env.DB.db.prepare('SELECT outcome,error_kind,input_tokens FROM agent_execution_logs WHERE task_id=? ORDER BY id').all(task.id);
  assert.deepEqual(logs.map(l => [l.outcome, l.error_kind]), [['error', 'rate_limit'], ['success', null]]);
  assert.ok(auditEvents(env, task.id).includes('STEP_RETRY'));
});

test('retries stop at max_attempts and the task fails', async () => {
  const env = anthropicEnv();
  const calls = mockFetch([routes.telegram, anthropicStatus(503)]);
  await telegram(env, msg('/task write a report'));
  await drain(env);
  const task = latestTask(env);
  assert.equal(task.status, 'plan_failed');
  assert.equal(anthropicCalls(calls), AGENTS.manager.maxAttempts);
  assert.deepEqual(env.__queue.retries.map(r => r.delay), [10, 20], 'bounded exponential backoff');
  assert.match(lastText(calls), /Planning failed/);
});

test('dead-letter queue marks the task failed and tells the owner', async () => {
  const env = makeEnv();
  const calls = mockFetch([routes.telegram]);
  await telegram(env, msg('/task write a report'));
  env.DB.failOn = /attempts=attempts\+1/; // every claim fails, as if D1 were down for this statement
  await drain(env);
  const task = latestTask(env);
  assert.equal(env.__queue.retries.filter(r => !r.fromDlq).length, 6, '1 delivery + 5 retries, then DLQ');
  assert.equal(task.status, 'failed');
  assert.match(task.result_note, /dead-letter/);
  assert.equal(steps(env, task.id)[0].status, 'failed');
  assert.ok(auditEvents(env, task.id).includes('DEAD_LETTER'));
  assert.match(lastText(calls), /dead-letter/);
});

test('invalid queue messages are discarded', async () => {
  const env = makeEnv(); mockFetch([routes.telegram]);
  env.__queue.main.push({ body: { v: 1, type: 'run_shell', cmd: 'rm -rf /' }, attempts: 1 });
  await drain(env);
  assert.equal(env.__queue.retries.length, 0);
});

test('cancellation revokes the approval and nothing runs afterwards', async () => {
  const env = makeEnv();
  const calls = mockFetch([routes.telegram, routes.dispatchOk]);
  const { task, approve } = await planTask(env, calls);
  await telegram(env, msg(`/cancel ${task.id.slice(0, 17)}…`));
  assert.match(lastText(calls), /Cancelled/);
  assert.equal(latestTask(env).status, 'cancelled');
  assert.equal(approvals(env, task.id)[0].status, 'revoked');
  await telegram(env, press(approve));
  await drain(env);
  assert.match(lastText(calls), /Already handled/);
  assert.equal(dispatches(calls).length, 0);

  // Cancel while the plan is still queued: the model is never called.
  const env2 = anthropicEnv();
  const calls2 = mockFetch([routes.telegram, routes.anthropicPlan()]);
  await telegram(env2, msg('/task write a report'));
  await telegram(env2, msg(`/cancel ${latestTask(env2).id}`));
  await drain(env2);
  assert.equal(anthropicCalls(calls2), 0);
  assert.deepEqual(steps(env2, latestTask(env2).id).map(s => s.status), ['cancelled', 'cancelled']);
});

test('a task already running on GitHub cannot be cancelled', async () => {
  const env = makeEnv();
  const calls = mockFetch([routes.telegram, routes.dispatchOk]);
  const { task, approve } = await planTask(env, calls);
  await telegram(env, press(approve));
  await drain(env);
  await telegram(env, msg(`/cancel ${task.id}`));
  assert.match(lastText(calls), /is running on GitHub/);
  assert.equal(latestTask(env).status, 'running');
});

test('budgets cap output tokens and stop AI calls when exhausted', async () => {
  const env = anthropicEnv({ TASK_TOKEN_BUDGET: '1500' });
  const calls = mockFetch([routes.telegram, routes.anthropicPlan()]);
  await planTask(env, calls, '/task write a report');
  assert.equal(calls.find(c => c.url.endsWith('/v1/messages')).body.max_tokens, 1500, 'max_tokens limited to remaining budget');

  const env2 = anthropicEnv({ DAILY_TOKEN_BUDGET: '1000' });
  const calls2 = mockFetch([routes.telegram, routes.anthropicPlan()]);
  env2.DB.db.prepare("INSERT INTO agent_execution_logs (agent,outcome,input_tokens,output_tokens) VALUES ('manager','success',600,300)").run();
  await telegram(env2, msg('/task write a report'));
  await drain(env2);
  assert.equal(anthropicCalls(calls2), 0);
  assert.equal(latestTask(env2).status, 'paused', 'daily limits pause instead of failing');
  assert.match(latestTask(env2).result_note, /Daily token budget reached \(900\/1000\)/);
});

test('audit log and execution log record the task lifecycle', async () => {
  const env = makeEnv();
  const calls = mockFetch([routes.telegram, routes.dispatchOk]);
  const { task, approve } = await planTask(env, calls);
  await telegram(env, press(approve));
  await drain(env);
  await (await import('./harness.mjs')).job(env, 'POST', '/job-result', { task_id: task.id, status: 'completed', run_url: 'https://github.com/owner/repo/actions/runs/7', note: 'ok' });
  assert.deepEqual(auditEvents(env, task.id), ['TASK_CREATED', 'STEP_COMPLETED', 'APPROVAL_REQUESTED', 'APPROVE', 'DISPATCHED', 'JOB_COMPLETED']);
  const log = env.DB.db.prepare('SELECT agent,provider,model,outcome,prompt_version FROM agent_execution_logs WHERE task_id=?').get(task.id);
  assert.deepEqual({ ...log }, { agent: 'manager', provider: 'mock', model: 'mock', outcome: 'success', prompt_version: AGENTS.manager.prompt.version });
});

test('an approval is bound to the exact action: a changed task is not dispatched', async () => {
  const env = makeEnv();
  const calls = mockFetch([routes.telegram, routes.dispatchOk]);
  const { task, approve } = await planTask(env, calls);
  const ap = approvals(env, task.id)[0];
  assert.equal(ap.owner_id, String(OWNER));
  assert.equal(JSON.parse(ap.payload).inputs.task_id, task.id);
  await telegram(env, press(approve));
  env.DB.db.prepare('UPDATE tasks SET request_text=? WHERE id=?').run('Publish every book to TikTok', task.id);
  await drain(env);
  assert.equal(dispatches(calls).length, 0);
  assert.equal(latestTask(env).status, 'failed');
  assert.match(lastText(calls), /changed after it was approved/);
  assert.equal(approvals(env, task.id)[0].status, 'revoked');
});

test('an expired approval cannot be used', async () => {
  const env = makeEnv();
  const calls = mockFetch([routes.telegram, routes.dispatchOk]);
  const { task, approve } = await planTask(env, calls);
  env.DB.db.prepare("UPDATE task_approvals SET expires_at=datetime('now','-1 minute') WHERE task_id=?").run(task.id);
  await telegram(env, press(approve));
  await drain(env);
  assert.match(lastText(calls), /expired/);
  assert.equal(approvals(env, task.id)[0].status, 'expired');
  assert.equal(dispatches(calls).length, 0);
});

test('only the owner can approve, cancel or change agents', async () => {
  const env = makeEnv();
  const calls = mockFetch([routes.telegram, routes.dispatchOk]);
  const { task } = await planTask(env, calls);
  const before = sent(calls).length;
  for (const text of [`/approve ${task.id}`, `/cancel ${task.id}`, '/agent manager set enabled=off', '/diag']) await telegram(env, msg(text, 999));
  assert.equal(sent(calls).length, before, 'non-owner gets no reply');
  const r = await approveStep(env, approvals(env, task.id)[0].id, 999);
  assert.deepEqual([r.ok, r.reason], [false, 'not_found'], 'approval is bound to the owner id');
  assert.equal(latestTask(env).status, 'awaiting_approval');
  assert.equal(env.DB.db.prepare("SELECT enabled FROM agents WHERE name='manager'").get().enabled, 1);
});

test('one way to decide (buttons) and one task list (/status, waiting first)', async () => {
  const env = makeEnv();
  const calls = mockFetch([routes.telegram, routes.dispatchOk]);
  const { task } = await planTask(env, calls);
  for (const cmd of [`/approve ${task.id}`, `/reject ${task.id}`, '/pending', `/report ${task.id}`]) {
    await telegram(env, msg(cmd));
    assert.equal(lastText(calls), '❓ Unknown command · /help', cmd);
  }
  await telegram(env, press(`approve:${task.id}`)); // old Phase 1 button
  assert.equal(latestTask(env).status, 'awaiting_approval', 'old buttons do nothing');
  env.DB.db.prepare("INSERT INTO tasks (id,telegram_user_id,request_text,task_type,proposal,status,created_at) VALUES ('BSK-99999999-9999-4999-8999-999999999999','111','x','report','p','completed',datetime('now','+1 hour'))").run();
  await telegram(env, msg('/status'));
  assert.match(lastText(calls), /^⏳ BSK-[^\n]*awaiting_approval[^\n]*\nBSK-99999999/, 'waiting task listed first');
});

test('provider fallback: off by default, availability errors only when enabled', async () => {
  const off = anthropicEnv({ OPENAI_API_KEY: 'sk-x', AI_FALLBACK_PROVIDER: 'openai', AI_FALLBACK_MODEL: 'gpt-5-mini' });
  const c1 = mockFetch([routes.telegram, anthropicStatus(529), routes.openaiPlan()]);
  await telegram(off, msg('/task write a report'));
  await drain(off);
  assert.equal(c1.filter(c => c.url.includes('openai')).length, 0, 'no silent provider switch');
  assert.equal(latestTask(off).status, 'plan_failed');

  const on = anthropicEnv({ OPENAI_API_KEY: 'sk-x', AI_FALLBACK_ENABLED: 'true', AI_FALLBACK_PROVIDER: 'openai', AI_FALLBACK_MODEL: 'gpt-5-mini' });
  const c2 = mockFetch([routes.telegram, anthropicStatus(529), routes.openaiPlan()]);
  const { task } = await planTask(on, c2, '/task write a report');
  assert.equal(task.status, 'awaiting_approval');
  assert.match(sent(c2).at(-1).text, /📋 Plan · openai\/gpt-5-mini/);
  assert.ok(auditEvents(on, task.id).includes('PROVIDER_FALLBACK'));

  const refusal = anthropicEnv({ OPENAI_API_KEY: 'sk-x', AI_FALLBACK_ENABLED: 'true', AI_FALLBACK_PROVIDER: 'openai', AI_FALLBACK_MODEL: 'gpt-5-mini' });
  const c3 = mockFetch([routes.telegram, [/api\.anthropic\.com/, () => Response.json({ stop_reason: 'refusal', content: [] })], routes.openaiPlan()]);
  await telegram(refusal, msg('/task write a report'));
  await drain(refusal);
  assert.equal(c3.filter(c => c.url.includes('openai')).length, 0, 'refusals never fall back');
  assert.equal(latestTask(refusal).status, 'plan_failed');
});

test('/agents and /agent settings are validated, stored and audited', async () => {
  const env = anthropicEnv();
  const calls = mockFetch([routes.telegram]);
  await telegram(env, msg('/agents'));
  assert.match(lastText(calls), /👑 Administrator[\s\S]*QA Reviewer \(qa_reviewer\) ✅ active\n   anthropic\/claude-sonnet-5-5 \(tier review\)[\s\S]*💰 Finance — \/finance\n   \(no AI — you decide\)[\s\S]*📣 Marketing[\s\S]*Book Researcher/);
  await telegram(env, msg('/agent book_researcher set provider=google model=gemini-2.5-flash'));
  assert.match(lastText(calls), /Not saved: GEMINI_API_KEY is not set/);
  await telegram(env, msg('/agent book_researcher set provider=anthropic model=gpt-4o'));
  assert.match(lastText(calls), /Not saved: "gpt-4o" is not a valid anthropic model id/);
  await telegram(env, msg('/agent book_researcher set provider=anthropic model=claude-haiku-5-5 max_attempts=2'));
  assert.match(lastText(calls), /Saved\. book_researcher now uses anthropic\/claude-haiku-5-5/);
  assert.deepEqual({ ...env.DB.db.prepare("SELECT provider,model,max_attempts FROM agents WHERE name='book_researcher'").get() }, { provider: 'anthropic', model: 'claude-haiku-5-5', max_attempts: 2 });
  assert.ok(env.DB.db.prepare("SELECT 1 FROM audit_log WHERE event='AGENT_CONFIG_CHANGED'").get());

  await telegram(env, msg('/agent manager set enabled=off'));
  const c2 = mockFetch([routes.telegram, routes.anthropicPlan()]);
  await telegram(env, msg('/task write a report'));
  await drain(env);
  assert.equal(anthropicCalls(c2), 0);
  assert.match(latestTask(env).result_note, /disabled/);
});

test('task creation is rate limited per owner', async () => {
  const env = makeEnv({ TASK_RATE_LIMIT_PER_HOUR: '2' });
  const calls = mockFetch([routes.telegram]);
  for (let i = 0; i < 3; i++) await telegram(env, msg(`/task report ${i}`));
  assert.match(lastText(calls), /Limit: 2 tasks per hour/);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) n FROM tasks').get().n, 2);
});

test('/taskstatus shows steps, approvals and tokens', async () => {
  const env = makeEnv();
  const calls = mockFetch([routes.telegram]);
  const { task } = await planTask(env, calls);
  await telegram(env, msg(`/taskstatus ${task.id.slice(0, 17)}…`));
  const t = lastText(calls);
  assert.match(t, /Status: awaiting_approval/);
  assert.match(t, /manager\.plan — completed \(attempt 1\/3\)/);
  assert.match(t, /video_creator\.demo_video_job — awaiting_approval/);
  assert.match(t, /dispatch_github_job: requested until/);
  assert.match(t, /Tokens: 0 \/ 60000/);
});
