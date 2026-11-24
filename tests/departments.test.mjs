// The bot as a company: talk to a department in plain words; /help shows departments with examples;
// a department alone shows its card with tap buttons; the "/" menu has only the departments.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OWNER, lastText, makeEnv, mockFetch, msg, press, sent, telegram, routes, latestTask } from './harness.mjs';
import { DEPARTMENTS, TAP_COMMANDS, routeRequest } from '../src/departments.js';

test('/help shows the five departments with examples and department buttons; "/" menu has only them', async () => {
  const env = makeEnv({ BOT_LANGUAGE: 'km' });
  const calls = mockFetch([routes.telegram]);
  await telegram(env, msg('/help'));
  const help = sent(calls).at(-1);
  for (const d of ['👑 Administrator — /admin', '💻 Developer — /developer', '💰 Finance — /finance', '👥 HR — /hr', '📣 Marketing — /marketing']) assert.ok(help.text.includes(d), d);
  assert.ok(help.text.includes('/marketing poster អំពីសៀវភៅ ៥ ក្បាល សម្រាប់ឪពុកម្តាយ'), 'examples in plain words');
  assert.deepEqual(help.reply_markup.inline_keyboard.flat().map(b => b.callback_data), ['dp:admin', 'dp:developer', 'dp:finance', 'dp:hr', 'dp:marketing']);

  const menu = calls.find(c => c.url.endsWith('/setMyCommands')).body;
  assert.deepEqual(menu.scope, { type: 'chat', chat_id: OWNER }, '"/" menu only in the owner chat');
  assert.deepEqual(menu.commands.map(c => c.command), ['help', 'admin', 'developer', 'finance', 'hr', 'marketing']);
  await telegram(env, msg('/menu'));
  assert.equal(calls.filter(c => c.url.endsWith('/setMyCommands')).length, 1, 'menu registered once');
});

test('department card: AI staff, examples and tap buttons that run the job', async () => {
  const env = makeEnv({ BOT_LANGUAGE: 'km' });
  const calls = mockFetch([routes.telegram]);
  await telegram(env, msg('/admin'));
  const card = sent(calls).at(-1);
  assert.match(card.text, /^👑 Administrator\n[^\n]+\n🤖 AI: BookShareKH Manager, QA Reviewer/);
  assert.ok(card.reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'run:status'));
  await telegram(env, press('dp:finance'));
  assert.match(lastText(calls), /💰 Finance[\s\S]*AI មិនសម្រេចរឿងប្រាក់ទេ[\s\S]*🤖 AI: គ្មាន/);
  await telegram(env, msg('/dev'));
  assert.match(lastText(calls), /^💻 Developer/, 'the old /dev still opens the Developer');
  await telegram(env, press('run:status'));
  assert.equal(lastText(calls), '📭 មិនទាន់មានការងារ។');
  const before = sent(calls).length;
  await telegram(env, press('run:deploy', 999));
  await telegram(env, press('run:task'));
  assert.equal(sent(calls).length, before, 'strangers and jobs that need words cannot be run from buttons');
});

test('plain words are routed to the right job', () => {
  const r = (d, t) => routeRequest(d, t);
  assert.deepEqual(r('marketing', 'designe poster about 5 books of parenting for parents'), { cmd: 'poster', args: '5 books of parenting for parents' });
  assert.deepEqual(r('marketing', 'poster អំពីសៀវភៅ ៥ ក្បាល សម្រាប់ឪពុកម្តាយ'), { cmd: 'poster', args: 'អំពីសៀវភៅ ៥ ក្បាល សម្រាប់ឪពុកម្តាយ' });
  assert.deepEqual(r('marketing', 'make a video about reading before bed'), { cmd: 'promo', args: 'reading before bed' });
  assert.deepEqual(r('marketing', 'poster'), { cmd: 'poster', args: '' });
  assert.deepEqual(r('marketing', 'find Pride and Prejudice'), { cmd: 'research', args: 'Pride and Prejudice' });
  assert.deepEqual(r('marketing', 'requests'), { cmd: 'requests', args: '' });
  assert.deepEqual(r('marketing', 'something for mothers day').ask, ['poster', 'promo', 'research']);
  assert.deepEqual(r('developer', 'update the homepage heading to Welcome'), { cmd: 'develop', args: 'update the homepage heading to Welcome' });
  assert.deepEqual(r('developer', 'check'), { cmd: 'website', args: '' });
  assert.deepEqual(r('developer', 'deploy'), { cmd: 'deploy', args: '' });
  assert.deepEqual(r('admin', 'cancel BSK-1a2b3c'), { cmd: 'cancel', args: 'BSK-1a2b3c' });
  assert.deepEqual(r('admin', 'status'), { cmd: 'status', args: '' });
  assert.deepEqual(r('admin', 'remember audience=parents'), { cmd: 'remember', args: 'audience=parents' });
  assert.deepEqual(r('admin', 'plan a reading challenge'), { cmd: 'task', args: 'plan a reading challenge' });
  assert.deepEqual(r('finance', 'anything'), { cmd: 'topups', args: '' });
});

test('/admin <words> starts a task; unclear marketing words ask with buttons, the tap runs it', async () => {
  const env = makeEnv();
  const calls = mockFetch([routes.telegram]);
  await telegram(env, msg('/admin plan a reading challenge for June'));
  assert.equal(latestTask(env).request_text, 'plan a reading challenge for June');
  await telegram(env, msg('/marketing something for mothers day'));
  const q = sent(calls).at(-1);
  assert.match(q.text, /something for mothers day/);
  const buttons = q.reply_markup.inline_keyboard.flat().map(b => b.callback_data);
  assert.equal(buttons.length, 3);
  assert.match(buttons[0], /^as:poster:[a-f0-9]{12}$/);
  await telegram(env, press(buttons[2])); // research: no website API needed to answer
  await telegram(env, press(buttons[2]));
  assert.match(lastText(calls), /already|handled|រួចហើយ/i, 'a choice is used once');
});

test('every command belongs to exactly one department', () => {
  const all = DEPARTMENTS.flatMap(d => d.commands.map(c => c[0]));
  assert.equal(new Set(all).size, all.length);
  for (const c of TAP_COMMANDS) assert.ok(all.includes(c));
});
