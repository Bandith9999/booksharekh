// $0 configuration: Gemini free tier by default, paid AI locked, quotas pause instead of switching provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AGENTS } from '../src/agents/registry.js';
import { RESEARCH_SCHEMA, PLAN_SCHEMA } from '../src/agents/schemas.js';
import { checkDataPolicy, resolveRoute, validateRoute } from '../src/ai/model-router.js';
import { geminiProvider } from '../src/ai/gemini-provider.js';
import {
  PLAN, auditEvents, drain, lastText, latestTask, makeEnv, mockFetch, msg, planTask, routes, steps, telegram,
} from './harness.mjs';

// wrangler.jsonc as deployed (full-line // comments only; URLs inside strings are kept).
const WRANGLER = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n'));
const LIVE = WRANGLER.vars;
// The documented $0 profile (README section I), applied on top of the live config.
const VARS = {
  ...LIVE, AI_DEFAULT_PROVIDER: 'google', AI_DEFAULT_MODEL: 'gemini-3.8-flash', AI_PAID_ENABLED: 'false', AI_DEFAULT_CHAIN: '', AI_REVIEW_CHAIN: '',
  AI_MAX_REQUESTS_PER_MINUTE: '5', AI_MAX_REQUESTS_PER_DAY: '100', DAILY_TASK_LIMIT: '20', TASK_TOKEN_BUDGET: '30000', DAILY_TOKEN_BUDGET: '300000',
  BOT_LANGUAGE: 'en', // these tests check behaviour and English wording; Khmer is covered in khmer.test.mjs
};

const GEN = /generativelanguage\.googleapis\.com\/v1beta\/models\/[^/]+:generateContent$/;
const geminiPlan = (plan = PLAN) => [GEN, () => Response.json({
  modelVersion: 'gemini-3.8-flash', usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 60 },
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(plan) }] } }],
})];
const geminiError = (status, error, headers = {}) => Response.json({ error }, { status, headers });
const geminiEnv = (over = {}) => makeEnv({ ...VARS, OWNER_TELEGRAM_ID: '111', AI_PROVIDER: undefined, GEMINI_API_KEY: 'AIza-SECRET-VALUE', ...over });
const count = (calls, re) => calls.filter(c => re.test(c.url)).length;
const req = (over = {}) => ({ agent: 'manager', systemPrompt: 'sys', messages: [{ role: 'user', content: 'x' }], model: 'gemini-3.8-flash', maxOutputTokens: 500, ...over });

test('live wrangler.jsonc: Claude planning with a capped budget, no fallback, queues intact', () => {
  assert.equal(LIVE.AI_FALLBACK_ENABLED, 'false', 'no automatic provider switching');
  assert.equal(LIVE.AI_PAID_ENABLED, 'true', 'owner unlocked paid AI for Claude');
  const live = { ...LIVE, ANTHROPIC_API_KEY: 'k', GEMINI_API_KEY: 'g' };
  // Claude does the work; the review tier (QA second opinion, book editor) uses Gemini.
  for (const a of Object.values(AGENTS)) {
    const r = resolveRoute(live, a);
    const want = a.tier === 'review' ? ['google', 'gemini-3.8-flash'] : ['anthropic', 'claude-sonnet-5-5'];
    assert.deepEqual([r.provider, r.model], want, a.name);
    assert.doesNotThrow(() => validateRoute(live, r), a.name);
  }
  // Confidential agents never run on free-tier Gemini (Google may read those prompts).
  assert.throws(() => checkDataPolicy(live, AGENTS.book_editor, resolveRoute(live, AGENTS.book_editor)), /confidential/);
  assert.doesNotThrow(() => checkDataPolicy(live, AGENTS.qa_reviewer, resolveRoute(live, AGENTS.qa_reviewer)));
  // Worst case: every daily token billed at Sonnet 5.5's $10/M output price.
  assert.ok(Number(LIVE.DAILY_TOKEN_BUDGET) * 10 / 1e6 <= 1.0, 'daily cap is at most about $1');
  assert.ok(Number(LIVE.AI_MAX_REQUESTS_PER_DAY) > 0 && Number(LIVE.TASK_TOKEN_BUDGET) <= Number(LIVE.DAILY_TOKEN_BUDGET));
});

test('$0 profile: all seven agents use a free Gemini model, paid AI locked, queues intact', () => {
  assert.equal(VARS.AI_PAID_ENABLED, 'false');
  assert.equal(VARS.AI_FALLBACK_ENABLED, 'false');
  const env = { ...VARS, GEMINI_API_KEY: 'k' };
  for (const a of Object.values(AGENTS)) {
    const r = resolveRoute(env, a);
    assert.deepEqual([r.provider, r.model], ['google', 'gemini-3.8-flash'], a.name);
    assert.doesNotThrow(() => validateRoute(env, r), a.name);
  }
  assert.deepEqual(WRANGLER.queues.producers, [{ binding: 'TASK_QUEUE', queue: 'booksharekh-tasks' }]);
  const main = WRANGLER.queues.consumers.find(c => c.queue === 'booksharekh-tasks');
  assert.equal(main.dead_letter_queue, 'booksharekh-tasks-dlq');
  assert.ok(WRANGLER.queues.consumers.some(c => /-dlq$/.test(c.queue)), 'DLQ consumer present');
  assert.ok(Number(VARS.AI_MAX_REQUESTS_PER_DAY) > 0 && Number(VARS.DAILY_TASK_LIMIT) > 0);
  assert.doesNotMatch(JSON.stringify([VARS.AI_DEFAULT_MODEL, VARS.AI_FREE_MODELS]), /claude-|gpt-/, 'no paid model in the $0 profile');
});

test('paid providers and non-free Gemini models stay locked until the owner unlocks them', async () => {
  const locked = { ...VARS, GEMINI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k' };
  for (const r of [{ provider: 'anthropic', model: 'claude-sonnet-5-5' }, { provider: 'openai', model: 'gpt-5-mini' }, { provider: 'google', model: 'gemini-4-carbon' }]) {
    assert.throws(() => validateRoute(locked, r), /paid AI is locked/, `${r.provider}/${r.model}`);
  }
  assert.doesNotThrow(() => validateRoute(locked, { provider: 'google', model: 'gemini-3.5-flash-lite' }));
  assert.doesNotThrow(() => validateRoute({ ...locked, AI_PAID_ENABLED: 'true' }, { provider: 'anthropic', model: 'claude-sonnet-5-5' }));

  const env = geminiEnv({ ANTHROPIC_API_KEY: 'sk-ant-x' });
  const calls = mockFetch([routes.telegram]);
  await telegram(env, msg('/agent manager set provider=anthropic model=claude-sonnet-5-5'));
  assert.match(lastText(calls), /Not saved: anthropic\/claude-sonnet-5-5 is not a free-tier model and paid AI is locked/);
  await telegram(env, msg('/agent book_researcher set provider=google model=gemini-3.5-flash-lite'));
  assert.match(lastText(calls), /Saved\. book_researcher now uses google\/gemini-3\.5-flash-lite/);
});

test('Gemini plans a task end-to-end with schema-constrained, locally validated JSON', async () => {
  const env = geminiEnv();
  const calls = mockFetch([routes.telegram, geminiPlan()]);
  const { task, approve } = await planTask(env, calls, '/task write a report');
  assert.equal(task.status, 'awaiting_approval');
  assert.match(approve, /^ap:APR-/);
  const call = calls.find(c => GEN.test(c.url));
  assert.match(call.url, /models\/gemini-3\.8-flash:generateContent$/);
  assert.equal(call.init.headers['x-goog-api-key'], 'AIza-SECRET-VALUE');
  assert.equal(call.body.generationConfig.responseMimeType, 'application/json');
  assert.ok(call.body.generationConfig.responseJsonSchema.properties.steps);
  assert.match(lastText(calls), /📋 Plan · google\/gemini-3\.8-flash/);
  const log = env.DB.db.prepare('SELECT provider,model,input_tokens,output_tokens FROM agent_execution_logs WHERE task_id=?').get(task.id);
  assert.deepEqual({ ...log }, { provider: 'google', model: 'gemini-3.8-flash', input_tokens: 100, output_tokens: 60 });

  // Output that breaks the schema is never accepted, whatever Gemini returns.
  const env2 = geminiEnv();
  mockFetch([routes.telegram, geminiPlan({ ...PLAN, steps: [{ agent: 'shell', objective: 'x' }] })]);
  await telegram(env2, msg('/task write a report'));
  await drain(env2);
  assert.equal(latestTask(env2).status, 'plan_failed');
});

test('GEMINI_SCHEMA_MODE fallbacks: openapi responseSchema and prompt-only', async () => {
  const calls = mockFetch([geminiPlan(RESEARCH_SCHEMA_SAMPLE())]);
  await geminiProvider.generate({ GEMINI_API_KEY: 'k', GEMINI_SCHEMA_MODE: 'openapi' }, req({ responseSchema: RESEARCH_SCHEMA }));
  const gc = calls[0].body.generationConfig;
  assert.equal(gc.responseJsonSchema, undefined);
  assert.equal(gc.responseSchema.type, 'OBJECT');
  assert.deepEqual([gc.responseSchema.properties.isbn.type, gc.responseSchema.properties.isbn.nullable], ['STRING', true]);

  const calls2 = mockFetch([geminiPlan()]);
  const res = await geminiProvider.generate({ GEMINI_API_KEY: 'k', GEMINI_SCHEMA_MODE: 'prompt' }, req({ responseSchema: PLAN_SCHEMA }));
  const b = calls2[0].body;
  assert.equal(b.generationConfig.responseJsonSchema ?? b.generationConfig.responseSchema, undefined);
  assert.match(b.systemInstruction.parts[0].text, /matches this JSON Schema/);
  assert.deepEqual(res.structuredOutput, PLAN);
});

function RESEARCH_SCHEMA_SAMPLE() {
  return { agent: 'book_researcher', title: 'Pride and Prejudice', author: 'Jane Austen', first_publication_year: 1813, language: 'English', isbn: null,
    metadata_source: 'Open Library', sources: ['https://openlibrary.org/works/OL66554W'], rights_status: 'requires_verification', confidence: null,
    ai_interpretation: 'Public-domain status depends on the edition.', status: 'awaiting_review' };
}

test('free-tier daily quota pauses the task, tells the owner, never switches to paid AI; /resume continues', async () => {
  // Even with a paid fallback configured and its key present, a locked install must not use it.
  const env = geminiEnv({ AI_FALLBACK_ENABLED: 'true', AI_FALLBACK_PROVIDER: 'anthropic', AI_FALLBACK_MODEL: 'claude-sonnet-5-5', ANTHROPIC_API_KEY: 'sk-ant-x' });
  let exhausted = true;
  const ok = geminiPlan()[1];
  const calls = mockFetch([routes.telegram, routes.anthropicPlan(), [GEN, (...a) => exhausted
    ? geminiError(429, { code: 'quota_exceeded', message: 'Daily quota exceeded for this model.' })
    : ok(...a)]]);
  await telegram(env, msg('/task write a report'));
  await drain(env);
  const task = latestTask(env);
  assert.equal(task.status, 'paused');
  assert.equal(steps(env, task.id)[0].status, 'paused');
  assert.equal(count(calls, GEN), 1, 'quota errors are not retried in a loop');
  assert.equal(count(calls, /anthropic/), 0, 'no paid provider');
  assert.match(lastText(calls), /Paused[\s\S]*\/resume BSK-/);
  assert.ok(auditEvents(env, task.id).includes('PAUSED'));

  exhausted = false;
  await telegram(env, msg(`/resume ${task.id.slice(0, 17)}…`));
  assert.match(lastText(calls), /Resumed/);
  await drain(env);
  assert.equal(latestTask(env).status, 'awaiting_approval');
  assert.ok(auditEvents(env, task.id).includes('RESUMED'));
});

test('a Gemini outage never falls back to a paid provider while paid AI is locked', async () => {
  // Outages are the one error class that may use a fallback, so this is where the lock matters.
  const env = geminiEnv({ AI_FALLBACK_ENABLED: 'true', AI_FALLBACK_PROVIDER: 'anthropic', AI_FALLBACK_MODEL: 'claude-sonnet-5-5', ANTHROPIC_API_KEY: 'sk-ant-x' });
  const calls = mockFetch([routes.telegram, routes.anthropicPlan(), [GEN, () => geminiError(503, { code: 503, status: 'UNAVAILABLE', message: 'overloaded' })]]);
  await telegram(env, msg('/task write a report'));
  await drain(env);
  assert.equal(count(calls, /anthropic/), 0, 'paid fallback refused');
  assert.equal(count(calls, GEN), AGENTS.manager.maxAttempts, 'retried on Gemini only');
  assert.equal(latestTask(env).status, 'plan_failed');
  assert.match(latestTask(env).result_note, /gemini API HTTP 503/, 'reports the real Gemini error');
  assert.ok(auditEvents(env, latestTask(env).id).includes('FALLBACK_BLOCKED'));
});

test('legacy RESOURCE_EXHAUSTED: PerDay is a quota, PerMinute retries after RetryInfo delay', async () => {
  const legacy = (quotaId, retryDelay) => ({ code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Resource has been exhausted', details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay } ] });
  mockFetch([[GEN, () => geminiError(429, legacy('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '3600s'))]]);
  await assert.rejects(geminiProvider.generate({ GEMINI_API_KEY: 'k' }, req()), e => e.kind === 'quota' && !e.retryable);

  const env = geminiEnv();
  let n = 0;
  const ok = geminiPlan()[1];
  const calls = mockFetch([routes.telegram, [GEN, (...a) => (++n === 1 ? geminiError(429, legacy('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '37s')) : ok(...a))]]);
  await telegram(env, msg('/task write a report'));
  await drain(env);
  assert.equal(latestTask(env).status, 'awaiting_approval');
  assert.equal(count(calls, GEN), 2);
  assert.equal(env.__queue.retries[0].delay, 37);

  mockFetch([[GEN, () => geminiError(429, { code: 'rate_limit_exceeded', message: 'Too many requests per minute.' }, { 'retry-after': '12' })]]);
  await assert.rejects(geminiProvider.generate({ GEMINI_API_KEY: 'k' }, req()), e => e.kind === 'rate_limit' && e.retryAfter === 12);
});

test('local limits: daily request cap pauses before calling Gemini; per-minute cap delays', async () => {
  const env = geminiEnv({ AI_MAX_REQUESTS_PER_DAY: '1' });
  const calls = mockFetch([routes.telegram, geminiPlan()]);
  env.DB.db.prepare("INSERT INTO agent_execution_logs (agent,outcome) VALUES ('manager','success')").run();
  await telegram(env, msg('/task write a report'));
  await drain(env);
  assert.equal(count(calls, GEN), 0);
  assert.equal(latestTask(env).status, 'paused');
  assert.match(latestTask(env).result_note, /Daily AI request limit reached \(1\/1\)/);

  const env2 = geminiEnv({ AI_MAX_REQUESTS_PER_MINUTE: '1' });
  const calls2 = mockFetch([routes.telegram, geminiPlan()]);
  env2.DB.db.prepare("INSERT INTO agent_execution_logs (agent,outcome) VALUES ('manager','success')").run();
  await telegram(env2, msg('/task write a report'));
  await drain(env2);
  assert.equal(env2.__queue.retries[0].delay, 60, 'waits a minute instead of calling');
  assert.equal(count(calls2, GEN), 0);
});

test('daily task limit stops new tasks', async () => {
  const env = geminiEnv({ DAILY_TASK_LIMIT: '1' });
  const calls = mockFetch([routes.telegram, geminiPlan()]);
  await telegram(env, msg('/task one'));
  await telegram(env, msg('/task two'));
  assert.match(lastText(calls), /Limit: 1 tasks per day \(UTC\)/);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) n FROM tasks').get().n, 1);
});

test('Gemini free-tier verification error fails clearly without retrying', async () => {
  const env = geminiEnv();
  const calls = mockFetch([routes.telegram, [GEN, () => geminiError(403, { code: 403, status: 'PERMISSION_DENIED', message: 'FREE_TIER_VERIFICATION_REQUIRED' })]]);
  await telegram(env, msg('/task write a report'));
  await drain(env);
  assert.equal(latestTask(env).status, 'plan_failed');
  assert.equal(count(calls, GEN), 1);
  assert.match(lastText(calls), /free-tier verification/);
});

test('confidential agents may not use free-tier Gemini unless the owner opts in', () => {
  const route = { provider: 'google', model: 'gemini-3.8-flash' };
  for (const name of ['book_editor', 'laravel_developer']) assert.throws(() => checkDataPolicy(VARS, AGENTS[name], route), /confidential/, name);
  assert.doesNotThrow(() => checkDataPolicy(VARS, AGENTS.manager, route));
  assert.doesNotThrow(() => checkDataPolicy({ ...VARS, GEMINI_PAID_TIER: 'true' }, AGENTS.book_editor, route));
  assert.doesNotThrow(() => checkDataPolicy({ ...VARS, AI_ALLOW_CONFIDENTIAL_ON_FREE_TIER: 'true' }, AGENTS.laravel_developer, route));
});

test('/remember refuses credentials and warns that settings reach the AI provider', async () => {
  const env = geminiEnv();
  const calls = mockFetch([routes.telegram]);
  for (const t of ['/remember db.password=hunter2', '/remember website.cpanel=admin', '/remember gemini.key=AIzaSyA1234567890abcdefghijklmnop']) {
    await telegram(env, msg(t));
    assert.match(lastText(calls), /Not saved: this looks like a password/, t);
  }
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) n FROM memories').get().n, 0);
  await telegram(env, msg('/remember video.language=Khmer'));
  assert.match(lastText(calls), /Saved: video\.language = Khmer[\s\S]*free Gemini tier/);
});

test('/diag on the free tier: model check, lock status, data notice, no secrets', async () => {
  const env = geminiEnv();
  const calls = mockFetch([routes.telegram, routes.workflowOk,
    [/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.8-flash$/, () => Response.json({ name: 'models/gemini-3.8-flash' })]]);
  await telegram(env, msg('/diag'));
  const t = lastText(calls);
  assert.match(t, /✅ google\/gemini-3\.8-flash: key accepted, model available/);
  assert.match(t, /🔒 Paid AI locked · free models: gemini-3\.8-flash, gemini-3\.6-flash, gemini-3\.5-flash-lite/);
  assert.match(t, /Google may use prompts to improve its products/);
  assert.match(t, /Limits: 5 AI calls\/min, 100 AI calls\/day, 30000 tokens\/task, 300000 tokens\/day, 20 tasks\/day/);
  assert.doesNotMatch(t, /SECRET-VALUE/);
  assert.equal(count(calls, GEN), 0, '/diag never spends generation quota');
});

test('a paused task can be cancelled', async () => {
  const env = geminiEnv();
  const calls = mockFetch([routes.telegram, [GEN, () => geminiError(429, { code: 'quota_exceeded', message: 'daily' })]]);
  await telegram(env, msg('/task write a report'));
  await drain(env);
  const task = latestTask(env);
  await telegram(env, msg(`/cancel ${task.id}`));
  assert.match(lastText(calls), /Cancelled/);
  assert.deepEqual(steps(env, task.id).map(s => s.status), ['cancelled', 'cancelled']);
  await telegram(env, msg(`/resume ${task.id}`));
  assert.match(lastText(calls), /Cannot resume \(cancelled\)/);
});
