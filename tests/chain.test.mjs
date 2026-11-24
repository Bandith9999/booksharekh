// AI team: Claude → Codex → Gemini for writing, Gemini → Codex → Claude for QA. An AI at its limit
// rests and the next one takes the work; when all rest, the task resumes itself after the reset.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PLAN, drain, lastText, latestTask, makeEnv, mockFetch, msg, routes, sent, telegram } from './harness.mjs';
import { AGENTS } from '../src/agents/registry.js';
import { cooldownOf, nextMidnight, resolveChain } from '../src/ai/model-router.js';
import { pickOpenAIModel } from '../src/ai/openai-provider.js';
import { autoResume } from '../src/orchestration/engine.js';

const LIVE = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')).vars;
// These tests are about takeover at a limit; teamwork (review + final) is tested in teamwork.test.mjs.
const env = (more = {}) => makeEnv({ ...LIVE, OWNER_TELEGRAM_ID: '111', AI_PROVIDER: undefined, BOT_LANGUAGE: 'en', ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_API_KEY: 'sk-oa-x', GEMINI_API_KEY: 'g-x', AI_TEAMWORK: 'false', ...more });

const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers });
const claude = (fn) => [/api\.anthropic\.com\/v1\/messages$/, fn];
const claudeOk = claude(() => json({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: 'text', text: JSON.stringify(PLAN) }] }));
const models = [/api\.openai\.com\/v1\/models$/, () => json({ data: ['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-6.2-sol-mini', 'gpt-5.5'].map(id => ({ id })) })];
const codex = (fn) => [/api\.openai\.com\/v1\/chat\/completions$/, fn];
const codexOk = codex((url, init) => json({ model: JSON.parse(init.body).model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(PLAN) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
const gemini = (fn) => [/generativelanguage\.googleapis\.com\/v1beta\/models\/[^/]+:generateContent$/, fn];
const geminiOk = gemini(() => json({ modelVersion: 'gemini-3.8-flash', usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 }, candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(PLAN) }] } }] }));
const geminiQuota = gemini(() => json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded: GenerateRequestsPerDayPerProjectPerModel-FreeTier' } }, 429));
const calls429 = (calls, re) => calls.filter(c => re.test(c.url)).length;
const providersUsed = e => e.DB.db.prepare("SELECT provider, outcome, error_kind FROM agent_execution_logs ORDER BY id").all().map(r => `${r.provider}:${r.outcome}${r.error_kind ? `:${r.error_kind}` : ''}`);

test('live config: writing Claude → Codex → Gemini; QA Gemini → Codex → Claude', () => {
  const label = a => resolveChain(LIVE, AGENTS[a]).map(r => `${r.provider}/${r.model}`);
  for (const a of ['manager', 'video_creator', 'content_creator']) assert.deepEqual(label(a), ['anthropic/claude-sonnet-5-5', 'openai/auto', 'google/gemini-3.8-flash'], a);
  assert.deepEqual(label('qa_reviewer'), ['google/gemini-3.8-flash', 'openai/auto', 'anthropic/claude-sonnet-5-5']);
  assert.equal(pickOpenAIModel(['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-6.2-sol-mini', 'gpt-5.5', 'gpt-6.3-audio']), 'gpt-6.2-sol', 'newest Sol, not mini/audio');
  assert.equal(pickOpenAIModel(['gpt-5.5', 'gpt-6.2']), 'gpt-6.2');
});

test('Claude rate-limited → Codex does the work; Claude rests, the next task goes straight to Codex', async () => {
  const e = env();
  const calls = mockFetch([routes.telegram, models, claude(() => json({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 429, { 'retry-after': '120' })), codexOk]);
  await telegram(e, msg('/task write a report'));
  await drain(e);
  assert.equal(latestTask(e).status, 'awaiting_approval');
  assert.deepEqual(providersUsed(e), ['anthropic:error:rate_limit', 'openai:success']);
  const body = JSON.parse(calls.find(c => /chat\/completions/.test(c.url)).init.body);
  assert.equal(body.model, 'gpt-6.2-sol', 'openai:auto picked the newest Sol model');
  const rest = await cooldownOf(e, 'anthropic');
  assert.equal(rest.kind, 'rate_limit');
  assert.ok(rest.until - Date.now() > 100000 && rest.until - Date.now() <= 121000, 'rests as long as Claude asked');
  assert.ok(!sent(calls).some(m => /🔄/.test(m.text)), 'a short rest is not announced');

  await telegram(e, msg('/task another report'));
  await drain(e);
  assert.equal(calls429(calls, /anthropic/), 1, 'Claude is not called while resting');
  assert.equal(calls.filter(c => /api\.openai\.com\/v1\/models$/.test(c.url)).length, 1, 'model list fetched once, then cached');
});

test('Claude out of credit and Codex quota → Gemini does it; the owner gets one quiet notice per AI', async () => {
  const e = env();
  const calls = mockFetch([routes.telegram, models,
    claude(() => json({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }, 400)),
    codex(() => json({ error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } }, 429)), geminiOk]);
  await telegram(e, msg('/task write a report'));
  await drain(e);
  assert.equal(latestTask(e).status, 'awaiting_approval');
  assert.deepEqual(providersUsed(e), ['anthropic:error:quota', 'openai:error:quota', 'google:success']);
  const notices = sent(calls).filter(m => /^🔄/.test(m.text));
  assert.deepEqual(notices.map(m => m.text.split(':')[0]), ['🔄 Claude', '🔄 Codex']);
  assert.ok(notices.every(m => m.disable_notification === true), 'silent');
});

test('all three at their limits → task pauses and resumes by itself after the reset', async () => {
  const e = env();
  let open = false;
  const calls = mockFetch([routes.telegram, models,
    claude(() => (open ? json({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: JSON.stringify(PLAN) }] }) : json({ type: 'error', error: { type: 'rate_limit_error', message: 'x' } }, 429, { 'retry-after': '3600' }))),
    codex(() => json({ error: { code: 'insufficient_quota', message: 'quota' } }, 429)), geminiQuota]);
  await telegram(e, msg('/task write a report'));
  await drain(e);
  const task = latestTask(e);
  assert.equal(task.status, 'paused');
  const resumeAt = Number(e.DB.db.prepare('SELECT value FROM settings WHERE key=?').get(`auto_resume:${task.id}`).value);
  // Whichever rest ends first: Claude's 1 h, or Gemini's quota reset at midnight Pacific (can be sooner late at night).
  const expected = Math.min(Date.now() + 3600000, nextMidnight('America/Los_Angeles'));
  assert.ok(Math.abs(resumeAt - expected) < 5000, 'resumes when the first AI is free again');
  assert.match(sent(calls).at(-1).text, /^⏸ All AIs at their limits\n▶️ Continues at \d\d\/\d\d \d\d:\d\d/);

  assert.deepEqual(await autoResume(e, Date.now()), { resumed: 0 }, 'not before the time');
  // The hour passes: Claude's rest is over.
  e.DB.db.prepare("UPDATE settings SET value=json_set(value,'$.until',0) WHERE key='ai_cooldown:anthropic'").run();
  open = true;
  assert.deepEqual(await autoResume(e, resumeAt + 1), { resumed: 1 });
  await drain(e);
  assert.equal(latestTask(e).status, 'awaiting_approval', 'continued without /resume');
});

test('Gemini daily quota rests until midnight Pacific time', async () => {
  const e = env({ AI_REVIEW_CHAIN: 'google:gemini-3.8-flash' , AI_DEFAULT_CHAIN: 'google:gemini-3.8-flash,anthropic:claude-sonnet-5-5' });
  mockFetch([routes.telegram, geminiQuota, claudeOk]);
  await telegram(e, msg('/task write a report'));
  await drain(e);
  assert.equal(latestTask(e).status, 'awaiting_approval', 'Claude took over');
  const rest = await cooldownOf(e, 'google');
  assert.equal(rest.kind, 'quota');
  assert.ok(rest.until > Date.now() && rest.until - Date.now() <= 25 * 3600000);
  const pacificHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23' }).format(rest.until));
  assert.equal(pacificHour, 0);
});

test('bad keys everywhere → the task fails clearly (nothing to wait for)', async () => {
  const e = env();
  mockFetch([routes.telegram, [/api\.openai\.com\/v1\/models$/, () => json({ error: { message: 'bad key' } }, 401)],
    claude(() => json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401)),
    gemini(() => json({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid' } }, 400))]);
  await telegram(e, msg('/task write a report'));
  await drain(e);
  assert.equal(latestTask(e).status, 'plan_failed');
});

test('QA reviews with a different AI than the writer', async () => {
  const { qaContentAction } = await import('../src/agents/qa.js');
  const e = env();
  e.DB.db.prepare("INSERT INTO tasks (id,telegram_user_id,request_text,task_type,proposal,status) VALUES ('BSK-11111111-1111-4111-8111-111111111111','111','x','poster','p','running')").run();
  e.DB.db.prepare("INSERT INTO agent_execution_logs (task_id,agent,provider,model,attempt,outcome) VALUES ('BSK-11111111-1111-4111-8111-111111111111','content_creator','google','gemini-3.8-flash',1,'success')").run();
  assert.deepEqual(await qaContentAction.avoidProviders(e, { task: { id: 'BSK-11111111-1111-4111-8111-111111111111' } }), ['google'], 'Gemini wrote it → QA starts with Codex');
});
