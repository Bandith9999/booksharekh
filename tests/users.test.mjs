// User sign-ups / sign-ins -> one short Telegram message with the total; /users summary.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { lastText, makeEnv, mockFetch, msg, sent, telegram } from './harness.mjs';

const env = (lang = 'km') => makeEnv({ BOT_LANGUAGE: lang, LARAVEL_API_URL: 'https://booksharekh.com', LARAVEL_API_TOKEN: 'bsk_ai_x' });

function site() {
  const state = { activity: { registered: [], logins: [] }, total: 1200, asked: [] };
  let tick = 0;
  const routes = [
    [/api\.telegram\.org/, () => Response.json({ ok: true, result: {} })],
    [/\/api\/ai\/users\/activity/, url => {
      const p = new URL(url).searchParams;
      state.asked.push(Object.fromEntries(p));
      const out = { now: `2026-11-22 10:00:${String(++tick).padStart(2, '0')}`, total_users: state.total, ...state.activity };
      state.activity = { registered: [], logins: [] }; // each event is returned once
      return Response.json(out);
    }],
    [/\/api\/ai\/(topups|requests)/, () => Response.json({ data: [], latest_id: 0 })],
  ];
  return { state, routes };
}

test('first check is silent; then one short message with new members and the total (no logins)', async () => {
  const e = env();
  const s = site();
  const calls = mockFetch(s.routes);
  s.state.activity = { registered: [{ user: 'old-activity' }], logins: [] };
  await worker.scheduled({}, e, {});
  assert.ok(!sent(calls).some(m => /🆕|🔑|👥/.test(m.text)), 'no flood on the first run');
  assert.equal(s.state.asked[0].since, '2000-01-01 00:00:00');

  s.state.activity = {
    registered: [{ user: 'dara', email: 'dara@example.com', country: 'Cambodia', via: 'google' }, { user: 'nita' }],
    logins: [{ user: 'sok' }, { user: 'vanna' }],
  };
  s.state.total = 1234;
  await worker.scheduled({}, e, {});
  assert.equal(s.state.asked[1].since, '2026-11-22 10:00:01', 'continues from the site time it returned');
  assert.equal(lastText(calls), '*** សមាជិកថ្មី ***\n🆕 dara@example.com · dara\n🆕 nita\n\n👥 សរុប 1,234 នាក់');

  const before = sent(calls).length;
  await worker.scheduled({}, e, {});
  assert.equal(sent(calls).length, before, 'nothing new -> no message');
});

test('logins alone send no alert; many new members are capped to 10 lines', async () => {
  const e = env('en');
  const s = site();
  const calls = mockFetch(s.routes);
  await worker.scheduled({}, e, {});
  const before = sent(calls).length;
  s.state.activity = { registered: [], logins: [{ user: 'niza' }] };
  await worker.scheduled({}, e, {});
  assert.equal(sent(calls).length, before, 'login only -> no message');
  assert.ok(!sent(calls).some(m => /Login|🔑/.test(m.text)));
  s.state.activity = { registered: Array.from({ length: 13 }, (_, i) => ({ user: `u${i}` })), logins: [{ user: 'niza' }] };
  await worker.scheduled({}, e, {});
  assert.equal(lastText(calls), `*** NEW MEMBER ***\n${Array.from({ length: 10 }, (_, i) => `🆕 u${i}`).join('\n')}\n+3\n\n👥 Total users: 1,200`);
});

test('/users shows the total and the last 24 hours', async () => {
  const e = env();
  const s = site();
  const calls = mockFetch(s.routes);
  s.state.activity = { registered: [{ user: 'a' }], logins: [{ user: 'b' }, { user: 'c' }] };
  await telegram(e, msg('/users'));
  assert.equal(s.state.asked[0].hours, '24');
  assert.equal(lastText(calls), '👥 សរុប 1,200 នាក់\n🆕 ថ្មី (24h): 1\n🔑 Login (24h): 2');
});

test('/preview sends a sample of every alert with inert buttons, owner only', async () => {
  const e = env();
  const calls = mockFetch([[/api\.telegram\.org/, () => Response.json({ ok: true, result: {} })]]);
  await telegram(e, msg('/preview'));
  const msgs = sent(calls);
  assert.equal(msgs.length, 13, 'intro + 12 samples');
  assert.match(msgs[0].text, /^🧪 Preview: 12 sample alerts/);
  assert.match(msgs[1].text, /^\*\*\* បញ្ចូលប្រាក់ \*\*\*/);
  assert.match(msgs[5].text, /^\*\*\* សមាជិកថ្មី \*\*\*\n🆕 lyly@example\.com · Lyly\.Hong/);
  const buttons = msgs.flatMap(m => m.reply_markup?.inline_keyboard.flat() ?? []);
  assert.ok(buttons.length >= 7 && buttons.every(b => b.callback_data === 'noop'), 'sample buttons do nothing');
  assert.equal(calls.filter(c => !/api\.telegram\.org/.test(c.url)).length, 0, 'no website or GitHub calls');
  const before = sent(calls).length;
  await telegram(e, msg('/preview', 999));
  assert.equal(sent(calls).length, before, 'other users get nothing');
});

test('book purchases: silent alert with buyer email, user name and book title; first run starts quietly', async () => {
  const e = env();
  const rows = [{ id: 7, email: 'old@example.com', user: 'old', book_title: 'Old Book' }];
  const calls = mockFetch([[/api\.telegram\.org/, () => Response.json({ ok: true, result: {} })],
    [/\/api\/ai\/purchases/, url => {
      const after = Number(new URL(url).searchParams.get('after_id'));
      return Response.json({ data: rows.filter(r => r.id > after), latest_id: Math.max(...rows.map(r => r.id)) });
    }],
    [/\/api\/ai\/(users|topups|requests)/, () => Response.json({ data: [], latest_id: 0, now: '2026-11-23 10:00:00', total_users: 1, registered: [], logins: [] })]]);
  await worker.scheduled({}, e, {});
  assert.ok(!sent(calls).some(m => /ទិញសៀវភៅ|Old Book/.test(m.text)), 'old purchases are not alerted');
  rows.push({ id: 8, email: 'reader1@example.com', user: 'reader1', book_title: 'Emma' }, { id: 9, email: null, user: 'reader2', book_title: 'Dracula' });
  await worker.scheduled({}, e, {});
  const m = sent(calls).at(-1);
  assert.equal(m.text, '*** ទិញសៀវភៅ ***\n🛒 reader1@example.com · reader1\n📖 Emma\n\n🛒 reader2\n📖 Dracula');
  assert.equal(m.disable_notification, true, 'silent');
  const before = sent(calls).length;
  await worker.scheduled({}, e, {});
  assert.equal(sent(calls).length, before, 'each purchase alerted once');
});
