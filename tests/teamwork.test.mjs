// Teamwork: for plans (and posters/videos) Claude writes the draft, Codex and Gemini review it in
// parallel, Claude writes the final version with their suggestions. Missing team members are skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PLAN, drain, latestTask, makeEnv, mockFetch, msg, routes, sent, telegram } from './harness.mjs';

const LIVE = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')).vars;
const env = (more = {}) => makeEnv({ ...LIVE, OWNER_TELEGRAM_ID: '111', AI_PROVIDER: undefined, BOT_LANGUAGE: 'en', ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_API_KEY: 'sk-oa-x', GEMINI_API_KEY: 'g-x', ...more });
const json = (body, status = 200) => Response.json(body, { status });
const FINAL = { ...PLAN, summary: 'Final plan, improved by the team.' };
const REVIEW = { verdict: 'improve', suggestions: ['Add a rights check before rendering.'] };
const models = [/api\.openai\.com\/v1\/models$/, () => json({ data: [{ id: 'gpt-6.2-sol' }] })];
const isReview = body => /reviewer on an AI team/.test(JSON.stringify(body));
const isFinal = body => /team_suggestions/.test(JSON.stringify(body));
// Claude: draft first, final when asked with the team's suggestions.
const claude = [/api\.anthropic\.com\/v1\/messages$/, (u, init) => {
  const body = JSON.parse(init.body);
  const out = isFinal(body) ? FINAL : PLAN;
  return json({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: 'text', text: JSON.stringify(out) }] });
}];
const codex = verdict => [/api\.openai\.com\/v1\/chat\/completions$/, () => json({ model: 'gpt-6.2-sol', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(verdict) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } })];
const gemini = verdict => [/generativelanguage\.googleapis\.com\/v1beta\/models\/[^/]+:generateContent$/, () => json({ modelVersion: 'gemini-3.8-flash', usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 }, candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(verdict) }] } }] })];
const audit = e => e.DB.db.prepare("SELECT details FROM audit_log WHERE event='TEAMWORK'").all().map(r => r.details);

test('Claude drafts, Codex and Gemini review together, Claude writes the final plan', async () => {
  const e = env();
  const calls = mockFetch([routes.telegram, models, claude, codex(REVIEW), gemini({ verdict: 'good', suggestions: [] })]);
  await telegram(e, msg('/task plan a reading challenge'));
  await drain(e);
  assert.equal(latestTask(e).status, 'awaiting_approval');
  const ai = calls.filter(c => /anthropic|chat\/completions|generateContent/.test(c.url));
  assert.equal(ai.length, 4, 'draft + 2 reviews + final');
  assert.ok(isReview(JSON.parse(ai[1].init.body)) && isReview(JSON.parse(ai[2].init.body)), 'both others review');
  const final = JSON.parse(ai[3].init.body);
  assert.ok(/anthropic/.test(ai[3].url) && isFinal(final), 'the writer finalises');
  assert.match(JSON.stringify(final), /Codex: Add a rights check/);
  const approval = sent(calls).at(-1).text;
  assert.match(approval, /Final plan, improved by the team\./);
  assert.match(approval, /🤝 Claude \+ Codex \+ Gemini/);
  assert.match(audit(e)[0], /manager: Claude wrote; Codex improve, Gemini good; 1 suggestion\(s\); final rewritten/);
});

test('everyone says "good": no extra rewrite; a reviewer that fails is skipped', async () => {
  const e = env();
  const calls = mockFetch([routes.telegram, models, claude, codex({ verdict: 'good', suggestions: [] }),
    [/generativelanguage/, () => json({ error: { code: 500, message: 'boom' } }, 500)]]);
  await telegram(e, msg('/task plan a reading challenge'));
  await drain(e);
  assert.equal(latestTask(e).status, 'awaiting_approval');
  assert.equal(calls.filter(c => /anthropic/.test(c.url)).length, 1, 'only the draft');
  assert.match(sent(calls).at(-1).text, /🤝 Claude \+ Codex/);
  assert.match(audit(e)[0], /Claude wrote; Codex good/);
});

test('AI_TEAMWORK=false keeps the old way: one AI writes', async () => {
  const e = env({ AI_TEAMWORK: 'false' });
  const calls = mockFetch([routes.telegram, models, claude, codex(REVIEW), gemini(REVIEW)]);
  await telegram(e, msg('/task plan a reading challenge'));
  await drain(e);
  assert.equal(calls.filter(c => /anthropic|chat\/completions|generateContent/.test(c.url)).length, 1);
  assert.doesNotMatch(sent(calls).at(-1).text, /🤝/);
});
