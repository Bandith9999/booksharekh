// Clean chat: a tapped approval disappears, progress messages are removed when the final result
// arrives, and only the result stays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OWNER, job, makeEnv, mockFetch, planTask, routes, telegram } from './harness.mjs';

// Telegram mock that gives every sent message an id, like the real API.
function telegramWithIds() {
  let next = 100;
  return [/api\.telegram\.org/, url => Response.json({ ok: true, result: /\/send[A-Z]/.test(url) ? { message_id: ++next, chat: { id: OWNER } } : true })];
}
const method = (calls, name) => calls.filter(c => c.url.endsWith(`/${name}`));
const tapOn = (data, message_id) => ({ callback_query: { id: 'q1', from: { id: OWNER }, message: { message_id, chat: { id: OWNER, type: 'private' } }, data } });
const trail = env => env.DB.db.prepare("SELECT key FROM settings WHERE key LIKE 'tg_trail:%'").all();

test('approval tap deletes the approval; the final result removes progress and stays', async () => {
  const env = makeEnv();
  const calls = mockFetch([telegramWithIds(), routes.workflowOk, routes.dispatchOk]);
  const { task, approve } = await planTask(env, calls);
  const sends = method(calls, 'sendMessage');
  const approvalMsg = sends.length + 100; // ids are 101, 102, … in send order
  assert.ok(sends.at(-1).body.reply_markup, 'last message is the approval');

  await telegram(env, tapOn(approve, approvalMsg));
  assert.deepEqual(method(calls, 'deleteMessage').map(c => c.body.message_id), [approvalMsg], 'tapped approval deleted');

  const before = method(calls, 'sendMessage').length;
  await job(env, 'POST', '/job-result', { task_id: task.id, status: 'completed', run_url: 'https://github.com/owner/repo/actions/runs/42', note: 'ok' });
  const finalId = method(calls, 'sendMessage').length + 100;
  assert.equal(method(calls, 'sendMessage').length, before + 1, 'one result message');
  const removed = method(calls, 'deleteMessages').flatMap(c => c.body.message_ids);
  assert.ok(removed.length >= 3, 'received, approval and "approved" notes are removed');
  assert.ok(!removed.includes(finalId), 'the result itself stays');
  assert.deepEqual(trail(env), [], 'nothing left to clean');
});

test('rejecting is the final result: the trail is cleared', async () => {
  const env = makeEnv();
  const calls = mockFetch([telegramWithIds()]);
  const { approve } = await planTask(env, calls);
  await telegram(env, tapOn(approve.replace(/^ap:/, 'rj:'), 102));
  assert.equal(method(calls, 'deleteMessage').length, 1);
  assert.ok(method(calls, 'deleteMessages').length >= 1);
  assert.deepEqual(trail(env), []);
});

test('an approval too old to delete loses its buttons instead', async () => {
  const env = makeEnv();
  const calls = mockFetch([[/deleteMessage$/, () => Response.json({ ok: false, description: 'message can\'t be deleted' }, { status: 400 })], telegramWithIds(), routes.workflowOk, routes.dispatchOk]);
  const { approve } = await planTask(env, calls);
  await telegram(env, tapOn(approve, 102));
  const edit = method(calls, 'editMessageReplyMarkup');
  assert.equal(edit.length, 1);
  assert.deepEqual(edit[0].body.reply_markup, { inline_keyboard: [] });
});

test('a step that finished before the "✅ running…" note was sent: the late note is removed at once', async () => {
  const { clearTrail } = await import('../src/telegram.js');
  const env = makeEnv();
  const calls = mockFetch([telegramWithIds(), routes.workflowOk, routes.dispatchOk]);
  const { task, approve } = await planTask(env, calls);
  await clearTrail(env, task.id); // the result was already sent (fast step)
  await telegram(env, tapOn(approve, 102));
  const noteId = method(calls, 'sendMessage').length + 100; // the "running" note is the last message sent
  assert.ok(method(calls, 'deleteMessage').map(c => c.body.message_id).includes(noteId), 'late "running" note deleted');
  assert.deepEqual(trail(env), [], 'nothing left behind');
});

test('a normal approval keeps the "✅ running…" note until the result arrives', async () => {
  const env = makeEnv();
  const calls = mockFetch([telegramWithIds(), routes.workflowOk, routes.dispatchOk]);
  const { approve } = await planTask(env, calls);
  await telegram(env, tapOn(approve, 102));
  assert.deepEqual(method(calls, 'deleteMessage').map(c => c.body.message_id), [102], 'only the tapped approval');
  assert.ok(trail(env).length >= 1, 'the note waits for the result');
});
