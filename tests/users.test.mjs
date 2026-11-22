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

test('first check is silent; then one short message with new users, logins and the total', async () => {
  const e = env();
  const s = site();
  const calls = mockFetch(s.routes);
  s.state.activity = { registered: [{ user: 'old-activity' }], logins: [] };
  await worker.scheduled({}, e, {});
  assert.ok(!sent(calls).some(m => /🆕|🔑|👥/.test(m.text)), 'no flood on the first run');
  assert.equal(s.state.asked[0].since, '2000-01-01 00:00:00');

  s.state.activity = {
    registered: [{ user: 'dara', country: 'Cambodia', via: 'google' }],
    logins: [{ user: 'sok' }, { user: 'vanna' }],
  };
  s.state.total = 1234;
  await worker.scheduled({}, e, {});
  assert.equal(s.state.asked[1].since, '2026-11-22 10:00:01', 'continues from the site time it returned');
  assert.equal(lastText(calls), '🆕 ចុះឈ្មោះថ្មី: dara (Cambodia · Google)\n🔑 Login: sok, vanna\n👥 សរុប 1,234 នាក់');

  const before = sent(calls).length;
  await worker.scheduled({}, e, {});
  assert.equal(sent(calls).length, before, 'nothing new -> no message');
});

test('many logins are capped to 10 names', async () => {
  const e = env('en');
  const s = site();
  const calls = mockFetch(s.routes);
  await worker.scheduled({}, e, {});
  s.state.activity = { registered: [], logins: Array.from({ length: 13 }, (_, i) => ({ user: `u${i}` })) };
  await worker.scheduled({}, e, {});
  assert.equal(lastText(calls), '🔑 Login: u0, u1, u2, u3, u4, u5, u6, u7, u8, u9, +3\n👥 Total users: 1,200');
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
