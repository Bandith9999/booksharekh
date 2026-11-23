// Top-ups: receipt photo + buttons in Telegram; the owner's tap approves or rejects on booksharekh.com.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { OWNER, lastText, makeEnv, mockFetch, msg, press, sent, telegram } from './harness.mjs';

const API = /^https:\/\/booksharekh\.com\/api\/ai\/topups/;
const env = (more = {}) => makeEnv({ BOT_LANGUAGE: 'km', LARAVEL_API_URL: 'https://booksharekh.com', LARAVEL_API_TOKEN: 'bsk_ai_x', ...more });

// A fake site: topups list, receipt image, approve/reject with the same checks as Laravel.
function site(rows) {
  const decisions = [];
  const route = [API, async (url, init) => {
    const u = new URL(url);
    let m;
    if (u.pathname === '/api/ai/topups') {
      const after = Number(u.searchParams.get('after_id'));
      const pending = u.searchParams.get('status') === 'pending';
      return Response.json({ data: rows.filter(r => r.id > after && (!pending || r.status === 'pending')), latest_id: Math.max(0, ...rows.map(r => r.id)) });
    }
    if ((m = /\/topups\/(\d+)\/image$/.exec(u.pathname))) return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
    if ((m = /\/topups\/(\d+)\/(approve|reject)$/.exec(u.pathname))) {
      const body = JSON.parse(init.body);
      decisions.push({ id: Number(m[1]), action: m[2], body });
      const row = rows.find(r => r.id === Number(m[1]));
      if (row.status !== 'pending') return Response.json({ error: `This top-up has already been ${row.status}.` }, { status: 409 });
      if (body.amount !== row.amount || body.transaction_id !== row.transaction_id) return Response.json({ error: 'The top-up changed after it was shown to you; check it again.' }, { status: 409 });
      row.status = m[2] === 'approve' ? 'approved' : 'rejected';
      return Response.json({ topup: row, balance: '15.00' });
    }
    return new Response('nf', { status: 404 });
  }];
  return { route, decisions, requests: [/\/api\/ai\/requests/, () => Response.json({ data: [] })] };
}
const photos = calls => calls.filter(c => c.url.endsWith('/sendPhoto')).map(c => Object.fromEntries(c.body.entries()));
const topup = (id, more = {}) => ({ id, user: 'dara', amount: '10.00', currency: 'USD', method: 'khqr', transaction_id: `TX${id}`, notes: 'ABA', status: 'pending', has_image: true, auto_verified: false, ...more });

test('new manual top-up -> receipt photo with amount, transaction and Approve/Reject', async () => {
  const e = env();
  const rows = [topup(1, { status: 'approved' })];
  const s = site(rows);
  const calls = mockFetch([[/api\.telegram\.org/, () => Response.json({ ok: true, result: {} })], s.route, s.requests]);
  await worker.scheduled({}, e, {}); // first run: nothing pending, only remembers the latest id
  assert.equal(photos(calls).length, 0);
  rows.push(topup(2), topup(3, { auto_verified: true }), topup(4, { has_image: false, transaction_id: null }));
  await worker.scheduled({}, e, {});
  const [p] = photos(calls);
  assert.equal(p.chat_id, String(OWNER));
  assert.equal(p.caption, '💰 Finance · *** បញ្ចូលប្រាក់ ***\n💰 Top-up #2\n👤 dara\n💵 10.00 USD · KHQR\n🧾 TX2\n📝 ABA\n\n👉 បញ្ចូលលុយ?');
  assert.ok(p.photo instanceof Blob);
  assert.deepEqual(JSON.parse(p.reply_markup).inline_keyboard[0].map(b => b.callback_data), ['ta:2', 'tr:2']);
  assert.equal(photos(calls).length, 1, 'Bakong auto-verified QR top-up is not sent to the owner');
  assert.match(lastText(calls), /Top-up #4[\s\S]*គ្មានរូប/, 'no image -> text alert');
  await worker.scheduled({}, e, {});
  assert.equal(photos(calls).length, 1, 'never alerted twice');
});

test('Approve credits once with the exact amount shown; a second tap does not', async () => {
  const e = env();
  const rows = [topup(5)];
  const s = site(rows);
  const calls = mockFetch([[/api\.telegram\.org/, () => Response.json({ ok: true, result: {} })], s.route, s.requests]);
  await worker.scheduled({}, e, {}); // first run alerts on top-ups already waiting
  assert.equal(photos(calls).length, 1);
  await telegram(e, press('ta:5'));
  assert.equal(s.decisions.length, 1);
  assert.deepEqual({ ...s.decisions[0].body, approval_id: undefined }, { amount: '10.00', transaction_id: 'TX5', approval_id: undefined });
  assert.match(s.decisions[0].body.approval_id, /^TG-\d+-\d+$/);
  assert.equal(lastText(calls), '✅ Top-up #5 +10.00 USD · dara (សមតុល្យ 15.00 USD)');
  await telegram(e, press('ta:5'));
  assert.equal(s.decisions.length, 1, 'no second call to the site');
  assert.equal(lastText(calls), 'រកមិនឃើញ។ សូមវាយ /topups');
  const audit = e.DB.db.prepare("SELECT event FROM audit_log WHERE event LIKE 'TOPUP%'").all().map(r => r.event);
  assert.deepEqual(audit, ['TOPUP_APPROVED']);
});

test('Reject, already-decided and changed top-ups are reported, never credited', async () => {
  const e = env();
  const rows = [topup(6), topup(7), topup(8)];
  const s = site(rows);
  const calls = mockFetch([[/api\.telegram\.org/, () => Response.json({ ok: true, result: {} })], s.route, s.requests]);
  await worker.scheduled({}, e, {});
  await telegram(e, press('tr:6'));
  assert.equal(lastText(calls), '❌ Top-up #6 បានបដិសេធ');
  rows[1].status = 'approved'; // approved in the admin panel meanwhile
  await telegram(e, press('ta:7'));
  assert.equal(lastText(calls), '⚠️ Top-up #7: This top-up has already been approved.');
  rows[2].amount = '100.00'; // record changed after the alert
  await telegram(e, press('ta:8'));
  assert.match(lastText(calls), /^⚠️ Top-up #8: The top-up changed/);
  assert.equal(rows[2].status, 'pending');
});

test('only the owner can decide; /topups re-sends pending alerts', async () => {
  const e = env();
  const rows = [topup(9)];
  const s = site(rows);
  const calls = mockFetch([[/api\.telegram\.org/, () => Response.json({ ok: true, result: {} })], s.route, s.requests]);
  await worker.scheduled({}, e, {});
  await telegram(e, press('ta:9', 12345));
  assert.equal(s.decisions.length, 0);
  assert.equal(rows[0].status, 'pending');
  await telegram(e, msg('/topups'));
  assert.equal(photos(calls).length, 2);
  rows[0].status = 'rejected';
  await telegram(e, msg('/topups'));
  assert.equal(lastText(calls), 'គ្មាន topup រង់ចាំ');
  assert.ok(sent(calls).length >= 1);
});

test('only top-up alerts make a sound; every other message is silent', async () => {
  const e = env();
  const rows = [topup(20), topup(21, { has_image: false })];
  const s = site(rows);
  const calls = mockFetch([[/api\.telegram\.org/, () => Response.json({ ok: true, result: {} })], s.route, s.requests]);
  await worker.scheduled({}, e, {});
  await telegram(e, press('ta:20'));
  await telegram(e, msg('/help'));
  const photo = calls.find(c => c.url.endsWith('/sendPhoto')).body;
  assert.equal(photo.get('disable_notification'), 'false', 'receipt photo alert rings');
  const msgs = calls.filter(c => c.url.endsWith('/sendMessage')).map(c => c.body);
  const alert = msgs.find(m => /Top-up #21/.test(m.text) && m.reply_markup);
  assert.equal(alert.disable_notification, false, 'text-only top-up alert rings');
  const others = msgs.filter(m => m !== alert);
  assert.ok(others.length >= 2);
  for (const m of others) assert.equal(m.disable_notification, true, m.text.slice(0, 40));
});
