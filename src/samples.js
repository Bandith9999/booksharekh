// /preview: sends one sample of every Telegram alert, built with the same text functions as the real
// alerts, using made-up data. Sample buttons do nothing (callback "noop"). Nothing is read or changed.
import { reply } from './telegram.js';
import { T, KM_ACTION, isKhmer } from './i18n.js';
import { members } from './website/users.js';
import { purchaseLines } from './website/purchases.js';
import { renderPlan } from './agents/manager.js';

const inert = (...labels) => ({ inline_keyboard: [labels.map(text => ({ text, callback_data: 'noop' }))] });

export function sampleAlerts(env) {
  const km = isKhmer(env);
  const t = { id: 123, user: 'Lyly.Hong', amount: '10.00', currency: 'USD', method: 'khqr', transaction_id: 'TX20261122001', notes: 'ABA', has_image: true };
  const tb = T.topupButtons(env), rb = T.requestButtons(env), ab = T.buttons(env);
  const reg = [{ user: 'Lyly.Hong', email: 'lyly@example.com' }, { user: 'Sok.Dara', email: 'sokdara@example.com' }];
  const task = { id: 'BSK-00000000-0000-4000-8000-000000000000', task_type: 'website_code_change' };
  const plan = renderPlan({ summary: km ? 'ប្តូរអក្សរ "New Releases" ទៅជា "សៀវភៅថ្មីៗ"' : 'Rename "New Releases" to Khmer', steps: [{ agent: 'laravel_developer', objective: km ? 'កែ Blade template' : 'Edit the Blade template' }], risks: [], needs_rights_verification: false }, { provider: 'anthropic', model: 'claude-sonnet-5-5' }, env);
  return [
    ['Top-up (real one comes as the receipt photo with this caption)', T.topupAlert(env, t), inert(tb.approve, tb.reject)],
    ['Top-up approved', T.topupApproved(env, t, '25.00 USD')],
    ['Top-up rejected', T.topupRejected(env, t)],
    ['Top-up already decided', T.topupProblem(env, t.id, 'This top-up has already been approved.')],
    ['New member', T.userActivity(env, members(reg), '230')],
    ['Book purchase', T.purchaseAlert(env, purchaseLines([{ email: 'lyly@example.com', user: 'Lyly.Hong', book_title: 'Pride and Prejudice' }]))],
    ['/users', T.usersSummary(env, '230', '2', '5')],
    ['Book request', T.requestAlert(env, { id: 45, book_title: 'Pride and Prejudice', author: 'Jane Austen', language: 'English' }), inert(rb.find, rb.reject)],
    ['/develop plan approval', T.approval(env, task, plan, km ? KM_ACTION.dispatch_code_change : 'Run the Laravel Developer (opens a pull request)', 24), inert(ab.approve, ab.reject, ab.cancel)],
    ['Merged', T.merged(env, 8, 'abc1234')],
    ['Deploy done', T.deployDone(env, true, '', '')],
    ['Deploy failed', T.deployDone(env, false, 'Health check failed (HTTP 500); rolled back.', '')],
  ];
}

export async function sendSamples(env, chat) {
  const list = sampleAlerts(env);
  await reply(env, chat, T.previewHead(env, list.length, list.map(([name], i) => `${i + 1}. ${name}`).join('\n')));
  for (const [, text, keyboard] of list) await reply(env, chat, text, keyboard ? { reply_markup: keyboard } : {});
}
