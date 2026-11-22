// BOT_LANGUAGE=km: short Khmer messages; commands, IDs and technical words stay English.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { anthropicEnv, approveButton, drain, lastText, latestTask, makeEnv, mockFetch, msg, press, routes, sent, telegram } from './harness.mjs';

const KHMER = /[ក-៿]/;

test('/help and unknown commands are in Khmer, commands stay in English', async () => {
  const env = makeEnv({ BOT_LANGUAGE: 'km' });
  const calls = mockFetch([routes.telegram]);
  await telegram(env, msg('/help'));
  const help = lastText(calls);
  assert.match(help, KHMER);
  for (const cmd of ['/task', '/develop', '/research', '/books', '/website', '/approve', '/diag']) assert.ok(help.includes(cmd), cmd);
  await telegram(env, msg('/nope'));
  assert.equal(lastText(calls), 'មិនស្គាល់ command។ សូមវាយ /help');
});

test('task flow in Khmer: received, approval with Khmer buttons, approved — and shorter than English', async () => {
  const run = async lang => {
    const env = makeEnv({ BOT_LANGUAGE: lang });
    const calls = mockFetch([routes.telegram, routes.dispatchOk]);
    await telegram(env, msg('/task write a report'));
    const received = lastText(calls);
    await drain(env);
    const approval = sent(calls).at(-1);
    await telegram(env, press(approveButton(calls)));
    return { received, approval, approved: lastText(calls), env };
  };
  const km = await run('km');
  const en = await run('en');
  assert.equal(km.received, '📝 កំពុងរៀបចំផែនការ…');
  assert.match(km.approval.text, /^📋 \[DEMO[^\n]*\n1\. [^\n]+\n\n👉 ដំណើរការ\?$/, 'summary, steps, one-line question');
  assert.doesNotMatch(km.approval.text, /BSK-|ម៉ោង|mock\/mock|https?:/, 'no IDs, timers, model names or links');
  assert.deepEqual(km.approval.reply_markup.inline_keyboard.flat().map(b => b.text), ['✅ យល់ព្រម', '❌ បដិសេធ', '🛑 បោះបង់']);
  assert.equal(km.approved, '✅ កំពុងដំណើរការ…');
  assert.equal(latestTask(km.env).status, 'queued', 'same behaviour, only the language differs');
  for (const k of ['received', 'approved']) assert.ok(km[k].length < en[k].length, `${k} is shorter in Khmer`);
  assert.ok(km.approval.text.length < en.approval.text.length, 'approval message is shorter in Khmer');
});

test('the Manager is asked to plan in Khmer, briefly, with technical terms in English', async () => {
  const env = anthropicEnv({ BOT_LANGUAGE: 'km' });
  const calls = mockFetch([routes.telegram, routes.anthropicPlan()]);
  await telegram(env, msg('/task write a report'));
  await drain(env);
  const system = calls.find(c => c.url.endsWith('/v1/messages')).body.system;
  assert.match(system, /Write summary, objectives and risks in Khmer[\s\S]*Keep technical terms in English[\s\S]*under 40 words/);
  const en = anthropicEnv();
  const c2 = mockFetch([routes.telegram, routes.anthropicPlan()]);
  await telegram(en, msg('/task write a report'));
  await drain(en);
  assert.doesNotMatch(c2.find(c => c.url.endsWith('/v1/messages')).body.system, /in Khmer/, 'English mode unchanged');
});

test('/website and book request alerts in Khmer', async () => {
  const env = makeEnv({ BOT_LANGUAGE: 'km', LARAVEL_API_URL: 'https://booksharekh.com', LARAVEL_API_TOKEN: 'bsk_ai_x' });
  const requests = [{ id: 1, book_title: 'Old', status: 'pending' }];
  const calls = mockFetch([routes.telegram,
    [/^https:\/\/booksharekh\.com\/api\/ai\/requests/, url => Response.json({ data: requests.filter(r => r.id > Number(new URL(url).searchParams.get('after_id'))) })],
    [/^https:\/\/booksharekh\.com\/api\/ai\/health/, () => Response.json({ ok: true, app: 'BookShareKH', laravel: '10.49', php: '8.4' })],
    [/^https:\/\/booksharekh\.com/, url => (new URL(url).pathname === '/' ? new Response('ok') : new Response('nf', { status: 404 }))]]);
  await telegram(env, msg('/website'));
  assert.match(lastText(calls), /^🌐 ពិនិត្យ https:\/\/booksharekh\.com\n✅ Homepage HTTP 200[\s\S]*✅ Debug mode បិទ[\s\S]*✅ Laravel API ភ្ជាប់រួច/);

  await worker.scheduled({}, env, {});
  assert.match(lastText(calls), /👀 កំពុងតាមដានសំណើសៀវភៅ/);
  requests.push({ id: 2, book_title: 'Moby Dick', author: 'Herman Melville', status: 'pending' });
  await worker.scheduled({}, env, {});
  const alert = sent(calls).at(-1);
  assert.equal(alert.text, '📚 សំណើសៀវភៅ #2\nMoby Dick — Herman Melville');
  assert.deepEqual(alert.reply_markup.inline_keyboard[0].map(b => [b.text, b.callback_data]), [['🔎 ស្វែងរក', 'rq:2'], ['🚫 បដិសេធ', 'rr:2']]);
});

test('Khmer PR review and deploy preview are minimal: no link, commit or IDs; each change once', async () => {
  const { prReviewText, deployPreviewText } = await import('../src/orchestration/github.js');
  const env = makeEnv({ BOT_LANGUAGE: 'km', WEBSITE_REPO: 'booksharekh-website' });
  const patch = ['@@ -1 +1 @@', '- ✨ New Releases', '+ ✨ សៀវភៅថ្មីៗ', '-<li><a href="{{ route(\'x\') }}"><i class="fas fa-fire"></i> New Releases</a></li>', '+<li><a href="{{ route(\'x\') }}"><i class="fas fa-fire"></i> សៀវភៅថ្មីៗ</a></li>'].join('\n');
  mockFetch([[/\/pulls\/8\/files/, () => Response.json([{ filename: 'resources/views/frontend/newrelease.blade.php', patch }, { filename: 'resources/views/frontend/partials/navbar.blade.php', patch }])],
    [/\/compare\//, () => Response.json({ files: [{ filename: 'resources/views/frontend/newrelease.blade.php' }, { filename: 'tests/Feature/X.php' }] })]]);
  const review = await prReviewText(env, 'https://github.com/owner/booksharekh-website/pull/8', '4'.repeat(40), 'Pull request opened.');
  assert.equal(review, '🔍 PR #8 · 2 ឯកសារ · ✅ tests\n- ✨ New Releases\n+ ✨ សៀវភៅថ្មីៗ\n- New Releases\n+ សៀវភៅថ្មីៗ');
  const deploy = await deployPreviewText(env, 'c'.repeat(40), '✅ Merged PR #8');
  assert.equal(deploy, '✅ Merged PR #8\n🚀 1 ឯកសារ\n• newrelease.blade.php');
});
