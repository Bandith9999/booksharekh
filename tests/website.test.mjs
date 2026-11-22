// Website management: live health check, Laravel API client, /develop → Laravel Developer → PR, export helper.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareExport } from '../website-kit/prepare-export.mjs';
import {
  approvals, approveButton, drain, job, lastText, latestTask, makeEnv, mockFetch, msg, planTask, press, routes, steps, telegram,
} from './harness.mjs';

const SITE = /^https:\/\/booksharekh\.com/;
const site = ({ debug = false, envPublic = false } = {}) => [SITE, url => {
  const path = new URL(url).pathname;
  if (path === '/') return new Response('<html>home</html>', { status: 200, headers: { 'x-powered-by': 'PHP/8.4.28' } });
  if (path === '/_ignition/health-check') return debug ? new Response('{"can_execute_commands":true}') : new Response('nf', { status: 404 });
  if (path === '/.env') return envPublic ? new Response('DB_PASSWORD=supersecret') : new Response('forbidden', { status: 403 });
  return new Response('nf', { status: 404 });
}];
const API = /^https:\/\/booksharekh\.com\/api\/ai\//;

test('/website reports live health and flags debug mode without printing sensitive content', async () => {
  const env = makeEnv();
  const calls = mockFetch([routes.telegram, site({ debug: true, envPublic: true })]);
  await telegram(env, msg('/website'));
  const t = lastText(calls);
  assert.match(t, /✅ Homepage HTTP 200 in \d+ ms \(PHP\/8\.4\.28\)/);
  assert.match(t, /🚨 Debug mode is ON in production/);
  assert.match(t, /🚨 \/\.env is publicly readable/);
  assert.doesNotMatch(t, /supersecret/, 'never echoes the body of a sensitive path');
  assert.match(t, /Laravel API not connected yet/);

  const env2 = makeEnv();
  const c2 = mockFetch([routes.telegram, site()]);
  await telegram(env2, msg('/website status'));
  assert.match(lastText(c2), /✅ Debug endpoint not exposed[\s\S]*✅ \/\.env, \/\.git\/HEAD/);
});

test('/books reads through the restricted Laravel API, and explains when it is not connected', async () => {
  const off = makeEnv();
  const c0 = mockFetch([routes.telegram]);
  await telegram(off, msg('/books'));
  assert.match(lastText(c0), /Laravel API is not connected yet/);

  const env = makeEnv({ LARAVEL_API_URL: 'https://booksharekh.com', LARAVEL_API_TOKEN: 'LARAVEL-SECRET' });
  const calls = mockFetch([routes.telegram, [API, url => {
    const u = new URL(url);
    if (u.pathname === '/api/ai/books') return Response.json({ data: [{ id: 7, title: 'Pride and Prejudice', author: 'Jane Austen', status: 'published' }] });
    if (u.pathname === '/api/ai/books/search') return Response.json({ data: [] });
    return new Response('nf', { status: 404 });
  }]]);
  await telegram(env, msg('/books latest 3'));
  assert.match(lastText(calls), /Latest 3 books:\n• #7 Pride and Prejudice — Jane Austen \[published\]/);
  const req = calls.find(c => c.url.includes('/api/ai/books?'));
  assert.equal(new URL(req.url).searchParams.get('latest'), '3');
  assert.equal(req.init.headers.Authorization, 'Bearer LARAVEL-SECRET');
  await telegram(env, msg('/books search Dune'));
  assert.match(lastText(calls), /Books matching "Dune":\n\(no books found\)/);

  const bad = makeEnv({ LARAVEL_API_URL: 'https://booksharekh.com', LARAVEL_API_TOKEN: 'x' });
  const c3 = mockFetch([routes.telegram, [API, () => new Response('no', { status: 401 })]]);
  await telegram(bad, msg('/books'));
  assert.match(lastText(c3), /refused the token \(HTTP 401\)[\s\S]*LARAVEL_API_TOKEN/);
  assert.doesNotMatch(lastText(c3), /x"|Bearer/);

  const http = makeEnv({ LARAVEL_API_URL: 'http://booksharekh.com', LARAVEL_API_TOKEN: 'x' });
  const c4 = mockFetch([routes.telegram]);
  await telegram(http, msg('/books'));
  assert.match(lastText(c4), /must use https/);
});

test('/develop is refused until the website repository is connected', async () => {
  const env = makeEnv();
  const calls = mockFetch([routes.telegram]);
  await telegram(env, msg('/develop Change the homepage heading'));
  assert.match(lastText(calls), /website repository is not connected yet/);
  assert.equal(latestTask(env), undefined);
});

test('/develop: plan → approval bound to the website repo → Laravel Developer job → PR link, nothing deployed', async () => {
  const env = makeEnv({ WEBSITE_REPO: 'booksharekh-website' });
  const calls = mockFetch([routes.telegram, [/\/repos\/owner\/booksharekh-website\/actions\/workflows\/laravel-developer\.yml\/dispatches$/, () => new Response(null, { status: 204 })]]);
  await telegram(env, msg('/develop Change the homepage heading to "Welcome to BookShareKH"'));
  assert.match(lastText(calls), /Website task BSK-.* received/);
  await drain(env);
  const task = latestTask(env);
  assert.equal(task.task_type, 'website_code_change');
  assert.equal(task.status, 'awaiting_approval');
  assert.deepEqual(steps(env, task.id).map(s => `${s.agent}.${s.action}`), ['manager.plan', 'laravel_developer.code_change_job']);
  const ap = approvals(env, task.id)[0];
  assert.equal(ap.action_type, 'dispatch_code_change');
  assert.deepEqual([JSON.parse(ap.payload).repo, JSON.parse(ap.payload).workflow], ['owner/booksharekh-website', 'laravel-developer.yml']);
  assert.match(lastText(calls), /Proposed action: Run the Laravel Developer[\s\S]*Nothing is deployed/);

  await telegram(env, press(approveButton(calls)));
  await drain(env);
  const dispatch = calls.filter(c => c.url.endsWith('/dispatches'));
  assert.equal(dispatch.length, 1);
  assert.deepEqual(dispatch[0].body, { ref: 'main', inputs: { task_id: task.id } });
  assert.equal(latestTask(env).status, 'running');
  assert.match(lastText(calls), /Laravel Developer job started/);

  const got = await (await job(env, 'GET', `/job/${task.id}`)).json();
  assert.equal(got.task_type, 'website_code_change');
  assert.equal(got.request_text, 'Change the homepage heading to "Welcome to BookShareKH"');

  assert.equal((await job(env, 'POST', '/job-result', { task_id: task.id, status: 'completed', pr_url: 'https://evil.example/pull/1' })).status, 400);
  assert.equal((await job(env, 'POST', '/job-result', { task_id: task.id, status: 'completed', head_sha: 'not-a-sha' })).status, 400);
  const sha = 'a'.repeat(40);
  const done = await job(env, 'POST', '/job-result', { task_id: task.id, status: 'completed', note: 'Pull request opened. PHP lint: pass, tests: pass.',
    run_url: 'https://github.com/owner/booksharekh-website/actions/runs/9', pr_url: 'https://github.com/owner/booksharekh-website/pull/3', head_sha: sha });
  assert.equal(done.status, 200);
  assert.equal(latestTask(env).status, 'completed');
  assert.match(lastText(calls), /Pull request for review: https:\/\/github\.com\/owner\/booksharekh-website\/pull\/3\nCommit aaaaaaaaaaaa\nNothing has been deployed/);
  const pr = env.DB.db.prepare("SELECT uri, content FROM task_artifacts WHERE task_id=? AND kind='pull_request'").get(task.id);
  assert.deepEqual(JSON.parse(pr.content), { pr_url: 'https://github.com/owner/booksharekh-website/pull/3', head_sha: sha });
});

test('only the owner can start website work', async () => {
  const env = makeEnv({ WEBSITE_REPO: 'booksharekh-website' });
  const calls = mockFetch([routes.telegram]);
  for (const t of ['/develop delete everything', '/website', '/books']) await telegram(env, msg(t, 999));
  assert.equal(calls.length, 0, 'no reply, no website or API call');
  assert.equal(latestTask(env), undefined);
});

test('export helper keeps source, drops secrets and runtime data, and flags hard-coded credentials', () => {
  const src = mkdtempSync(join(tmpdir(), 'bsk-src-'));
  const w = (p, s) => { mkdirSync(join(src, p, '..'), { recursive: true }); writeFileSync(join(src, p), s); };
  w('artisan', '#!/usr/bin/env php'); w('composer.json', '{}'); w('composer.lock', '{}');
  w('.env', 'APP_KEY=base64:abcdefghijklmnopqrstuvwxyz0123456789ABCD=\nDB_PASSWORD=hunter2hunter2\nAPP_DEBUG=true\n');
  w('app/Http/Controllers/BookController.php', '<?php // fine');
  w('config/services.php', "<?php return ['google' => ['client_secret' => env('GOOGLE_CLIENT_SECRET')]];");
  w('config/legacy.php', "<?php return ['api_key' => 'AIzaSyA1234567890abcdefghijklmnopqrstu'];");
  w('vendor/autoload.php', '<?php'); w('storage/logs/laravel.log', 'DB_PASSWORD=leak'); w('storage/framework/sessions/x', 's');
  w('public/storage/cover.jpg', 'img'); w('backup.sql', 'dump'); w('resources/views/home.blade.php', '<h1>Home</h1>');
  const dest = join(mkdtempSync(join(tmpdir(), 'bsk-out-')), 'clean');
  const r = prepareExport(src, dest);
  for (const kept of ['artisan', 'composer.json', 'composer.lock', 'app/Http/Controllers/BookController.php', 'resources/views/home.blade.php']) assert.ok(existsSync(join(dest, kept)), kept);
  for (const dropped of ['.env', 'vendor', 'storage/logs/laravel.log', 'storage/framework/sessions/x', 'public/storage', 'backup.sql']) assert.ok(!existsSync(join(dest, dropped)), dropped);
  // Laravel's runtime folders are recreated empty (it needs them), with only a .gitignore inside.
  for (const d of ['storage/logs', 'storage/framework/views', 'storage/framework/sessions']) assert.equal(readFileSync(join(dest, d, '.gitignore'), 'utf8'), '*\n!.gitignore\n', d);
  assert.equal(readFileSync(join(dest, '.env.example'), 'utf8'), 'APP_KEY=\nDB_PASSWORD=\nAPP_DEBUG=false\n', 'names only, safe defaults');
  assert.deepEqual(r.findings.map(f => f.file), ['config/legacy.php'], 'env() references are fine; hard-coded keys are flagged');
  assert.throws(() => prepareExport(join(src, 'app'), join(dest, '..', 'x')), /does not look like a Laravel root/);
});
