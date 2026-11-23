// The bot as a company: /help grouped by department, department cards with tap buttons, "/" menu.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OWNER, lastText, makeEnv, mockFetch, msg, press, sent, telegram, routes } from './harness.mjs';
import { DEPARTMENTS, TAP_COMMANDS } from '../src/departments.js';

test('/help lists every command once, grouped by department, with department buttons', async () => {
  const env = makeEnv({ BOT_LANGUAGE: 'km' });
  const calls = mockFetch([routes.telegram]);
  await telegram(env, msg('/help'));
  const help = sent(calls).at(-1);
  for (const d of ['👑 Administrator — /admin', '💻 Developer — /dev', '💰 Finance — /finance', '👥 HR — /hr', '📣 Marketing — /marketing']) assert.ok(help.text.includes(d), d);
  const cmds = help.text.match(/^\/[a-z]+/gm);
  assert.equal(new Set(cmds).size, cmds.length, 'no command listed twice');
  assert.deepEqual(help.reply_markup.inline_keyboard.flat().map(b => b.callback_data), ['dp:admin', 'dp:dev', 'dp:finance', 'dp:hr', 'dp:marketing']);

  const menu = calls.find(c => c.url.endsWith('/setMyCommands')).body;
  assert.deepEqual(menu.scope, { type: 'chat', chat_id: OWNER }, '"/" menu only in the owner chat');
  assert.deepEqual(menu.commands.slice(0, 6).map(c => c.command), ['help', 'admin', 'dev', 'finance', 'hr', 'marketing']);
  await telegram(env, msg('/menu'));
  assert.equal(calls.filter(c => c.url.endsWith('/setMyCommands')).length, 1, 'menu registered once');
});

test('department card: AI staff, commands and tap buttons that run the command', async () => {
  const env = makeEnv({ BOT_LANGUAGE: 'km' });
  const calls = mockFetch([routes.telegram]);
  await telegram(env, msg('/admin'));
  const card = sent(calls).at(-1);
  assert.match(card.text, /^👑 Administrator\n[^\n]+\n🤖 AI: BookShareKH Manager, QA Reviewer/);
  assert.ok(card.reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'run:status'));
  await telegram(env, press('dp:finance'));
  assert.match(lastText(calls), /💰 Finance[\s\S]*AI មិនសម្រេចរឿងប្រាក់ទេ[\s\S]*🤖 AI: គ្មាន/);
  await telegram(env, press('run:status'));
  assert.equal(lastText(calls), 'No tasks yet.');
  const before = sent(calls).length;
  await telegram(env, press('run:deploy', 999));
  await telegram(env, press('run:task'));
  assert.equal(sent(calls).length, before, 'strangers and commands that need text cannot be run from buttons');
});

test('every command belongs to exactly one department', () => {
  const all = DEPARTMENTS.flatMap(d => d.commands.map(c => c[0]));
  assert.equal(new Set(all).size, all.length);
  for (const c of TAP_COMMANDS) assert.ok(all.includes(c));
});
