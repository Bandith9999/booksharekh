// Telegram commands and button handlers. Every entry point checks the owner first.
import { clamp, isOwner, parseCommand, parseMemory, parseTaskRef, githubHint } from './helpers.js';
import { audit, findTask, getAgentOverride, listAgentTasks } from './db.js';
import { reply, tg } from './telegram.js';
import { AGENTS, TOOLS, isImplemented, validateRegistry } from './agents/registry.js';
import { fallbackRoute, freeModels, paidEnabled, resolveRoute, validateRoute } from './ai/model-router.js';
import { PROVIDER_NAMES, getProvider, normalizeProvider } from './ai/provider-factory.js';
import { approveStep, cancelTask, createBookImport, createDeployTask, createPromoTask, createTask, rejectStep, resumeTask } from './orchestration/engine.js';
import { SourceDownError, getCandidate, searchPublicDomain } from './books/gutenberg.js';
import { T, tr } from './i18n.js';
import { candidatesMessage, findForRequest, recentPendingRequests, rejectRequest, requestKeyboard } from './books/requests.js';
import { budgets, tokensUsed } from './orchestration/budget.js';
import { WORKFLOWS, WORKFLOW_FILE, deployPreviewText, githubHeaders, workflowUrl } from './orchestration/github.js';
import { checkWebsite, formatHealth } from './website/health.js';
import { WebsiteApiError, apiConfigured, apiHealth, formatBooks, latestBooks, searchBooks } from './website/laravel-api.js';
import { decideTopup, pendingTopups, sendTopupAlert } from './website/topups.js';
import { usersSummary } from './website/users.js';
import { sendSamples } from './samples.js';
import { nextPromoInput } from './marketing/promo.js';
import { sendRecommendations } from './marketing/recommend.js';
import { DEPARTMENTS, DEPT_BY_KEY, TAP_COMMANDS, registerMenu, sendDepartment, sendHelp } from './departments.js';

const short = id => `${id.slice(0, 17)}…`;

// ---------- formatting ----------
function routeLabel(env, def, override) {
  try {
    const r = resolveRoute(env, def, override);
    validateRoute(env, r);
    return `${r.provider}/${r.model} (${r.source})`;
  } catch (e) { return `⚠️ ${e.message}`; }
}

// AI staff grouped by department (Finance and HR have no AI: you decide).
async function agentsText(env) {
  const lines = ['🏢 BookShareKH AI staff'];
  for (const d of DEPARTMENTS) {
    lines.push(`\n${d.icon} ${d.name} — /${d.key}`);
    if (!d.agents.length) { lines.push('   (no AI — you decide)'); continue; }
    for (const name of d.agents) {
      const a = AGENTS[name], ov = await getAgentOverride(env, a.name);
      const state = ov?.enabled === 0 ? '⏸ disabled' : isImplemented(a.name) ? '✅ active' : `🕓 planned (Phase ${a.phase})`;
      lines.push(`• ${a.title} (${a.name}) ${state}\n   ${routeLabel(env, a, ov)}`);
    }
  }
  return lines.join('\n');
}
const agentTitles = () => Object.fromEntries(Object.values(AGENTS).map(a => [a.name, a.title]));

async function agentText(env, a) {
  const ov = await getAgentOverride(env, a.name);
  return [
    `${a.title} (${a.name})`, a.description, '',
    `Model: ${routeLabel(env, a, ov)}`,
    `Enabled: ${ov?.enabled === 0 ? 'no' : 'yes'} · max attempts ${ov?.max_attempts ?? a.maxAttempts} · fallback ${a.allowFallback ? 'allowed if enabled' : 'never'}`,
    `Tools: ${a.allowedTools.map(t => `${t}${TOOLS[t].implemented ? '' : ` (Phase ${TOOLS[t].phase})`}`).join(', ') || 'none'}`,
    `Actions: ${Object.entries(a.actions).map(([n, x]) => `${n}${x.requiresApproval ? ' [approval]' : ''}`).join(', ') || `none yet (Phase ${a.phase})`}`,
    `Prompt: ${a.prompt.version}`,
    `Limits: ${a.limitations.join(' ')}`,
    '', `Change: /agent ${a.name} set provider=<${PROVIDER_NAMES.join('|')}> model=<id> | enabled=on|off | max_attempts=1-5 | reset`,
  ].join('\n');
}

async function agentSet(env, userId, a, args) {
  const cur = (await getAgentOverride(env, a.name)) || { enabled: 1, provider: null, model: null, max_attempts: null };
  let next = { enabled: cur.enabled, provider: cur.provider, model: cur.model, max_attempts: cur.max_attempts };
  if (args[0] === 'reset') next = { enabled: 1, provider: null, model: null, max_attempts: null };
  else for (const pair of args) {
    const m = /^(provider|model|enabled|max_attempts)=(\S{1,80})$/.exec(pair);
    if (!m) return `Not saved: "${clamp(pair, 40)}" is not a setting. Use provider=, model=, enabled=on|off, max_attempts=1-5, or reset.`;
    const [, k, v] = m;
    if (k === 'provider') {
      next.provider = v === 'default' ? null : normalizeProvider(v);
      if (next.provider && !PROVIDER_NAMES.includes(next.provider)) return `Not saved: provider must be one of ${PROVIDER_NAMES.join(', ')}.`;
    }
    if (k === 'model') next.model = v === 'default' ? null : v;
    if (k === 'enabled') {
      if (!['on', 'off'].includes(v)) return 'Not saved: enabled must be on or off.';
      next.enabled = v === 'on' ? 1 : 0;
    }
    if (k === 'max_attempts') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 5) return 'Not saved: max_attempts must be 1-5.';
      next.max_attempts = n;
    }
  }
  if (next.provider && next.provider !== 'mock' && !next.model) return 'Not saved: give model=<id> together with provider=.';
  try { validateRoute(env, resolveRoute(env, a, next)); }
  catch (e) { return `Not saved: ${e.message}`; }
  await env.DB.prepare(`INSERT INTO agents (name,enabled,provider,model,max_attempts,updated_at,updated_by) VALUES (?,?,?,?,?,CURRENT_TIMESTAMP,?)
      ON CONFLICT(name) DO UPDATE SET enabled=excluded.enabled, provider=excluded.provider, model=excluded.model,
      max_attempts=excluded.max_attempts, updated_at=CURRENT_TIMESTAMP, updated_by=excluded.updated_by`)
    .bind(a.name, next.enabled, next.provider, next.model, next.max_attempts, String(userId)).run();
  await audit(env, null, 'AGENT_CONFIG_CHANGED', userId, `${a.name} ${JSON.stringify(next)}`);
  return `Saved. ${a.name} now uses ${routeLabel(env, a, next)}${next.enabled ? '' : ' (disabled)'}. Run /diag to confirm the model is available.`;
}

async function taskStatusText(env, task) {
  const steps = await listAgentTasks(env, task.id);
  const approvals = (await env.DB.prepare('SELECT id,action_type,status,expires_at FROM task_approvals WHERE task_id=? ORDER BY requested_at').bind(task.id).all()).results || [];
  const run = await env.DB.prepare('SELECT status,run_url FROM workflow_runs WHERE task_id=? ORDER BY created_at DESC LIMIT 1').bind(task.id).first();
  const used = await tokensUsed(env, task.id);
  const lines = [`Task ${task.id}`, `Status: ${task.status} · type ${task.task_type} · created ${task.created_at}`];
  if (steps.length) {
    lines.push('', 'Steps:');
    for (const s of steps) lines.push(`• ${s.agent}.${s.action} — ${s.status}${s.attempts ? ` (attempt ${s.attempts}/${s.max_attempts})` : ''}${s.error && s.status !== 'completed' ? `\n   ${clamp(s.error, 160)}` : ''}`);
  } else lines.push('', 'Steps: (created before Phase 2)');
  for (const a of approvals) lines.push(`Approval ${a.id.slice(0, 12)}… ${a.action_type}: ${a.status}${a.status === 'requested' ? ` until ${a.expires_at} UTC` : ''}`);
  lines.push(`Tokens: ${used.task} / ${budgets(env).task}`);
  if (run || task.result_url) lines.push(`GitHub: ${run?.status ?? ''} ${task.result_url || run?.run_url || ''}`.trim());
  if (task.result_note && ['failed', 'plan_failed', 'dispatch_failed', 'completed'].includes(task.status)) lines.push(`Note: ${clamp(task.result_note, 300)}`);
  return lines.join('\n');
}

const SECRET_HINT = /(pass(word|wd)?|secret|api[_-]?key|token|credential|cpanel|sk-ant-|sk-[a-z0-9]{16,}|AIza[0-9A-Za-z_-]{20,}|ghp_|github_pat_)/i;
const looksSecret = (key, value) => SECRET_HINT.test(key) || SECRET_HINT.test(value);

export async function diagnostics(env) {
  const lines = ['BookShareKH diagnostics (secret values are never shown)'];
  for (const name of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'JOB_CALLBACK_SECRET', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'])
    lines.push(`${env[name] ? '✅' : '▫️'} ${name} ${env[name] ? 'set' : 'not set'}`);
  lines.push(`${env.TASK_QUEUE ? '✅ Task queue bound' : '❌ TASK_QUEUE not bound: create the queues and deploy (README)'}`);
  const regErrors = validateRegistry();
  lines.push(regErrors.length ? `❌ Registry: ${regErrors.join('; ')}` : '✅ Agent registry valid');
  try { await env.DB.prepare('SELECT 1 FROM agents LIMIT 1').first(); lines.push('✅ D1 reachable, Phase 2 tables present'); }
  catch (e) { lines.push(`❌ D1: ${clamp(e.message, 120)} (apply migrations)`); }

  const routes = new Map();
  for (const a of Object.values(AGENTS)) {
    if (!Object.values(a.actions).some(x => x.kind === 'ai')) continue; // only agents that call a model today
    const ov = await getAgentOverride(env, a.name).catch(() => null);
    if (ov?.enabled === 0) continue;
    try { const r = resolveRoute(env, a, ov); validateRoute(env, r); routes.set(`${r.provider}/${r.model}`, r); }
    catch (e) { lines.push(`❌ ${a.name}: ${e.message}`); }
  }
  const fb = fallbackRoute(env, { allowFallback: true });
  if (fb) routes.set(`${fb.provider}/${fb.model} (fallback)`, fb);
  for (const [label, r] of routes) {
    try {
      validateRoute(env, r);
      const c = await getProvider(r.provider).checkModel(env, r.model);
      lines.push(c.ok ? `✅ ${label}: key accepted, model available` : `❌ ${label}: HTTP ${c.status} ${c.detail}${c.hint ? `\n   → ${c.hint}` : ''}`);
    } catch (e) { lines.push(`❌ ${label}: ${e.message}`); }
  }
  const b = budgets(env);
  lines.push(paidEnabled(env) ? '⚠️ Paid AI UNLOCKED (AI_PAID_ENABLED=true)' : `🔒 Paid AI locked · free models: ${freeModels(env).join(', ')}`);
  if (env.GEMINI_API_KEY && env.GEMINI_PAID_TIER !== 'true') lines.push('ℹ️ Gemini free tier: Google may use prompts to improve its products and reviewers may read them. Do not send confidential data.');
  lines.push(`Limits: ${b.perMinute} AI calls/min, ${b.perDay} AI calls/day, ${b.task} tokens/task, ${b.daily} tokens/day, ${Number(env.DAILY_TASK_LIMIT) || 50} tasks/day · fallback ${env.AI_FALLBACK_ENABLED === 'true' ? 'enabled' : 'off'}`);

  if (env.GITHUB_TOKEN && env.GITHUB_OWNER && env.GITHUB_REPO) {
    try {
      const r = await fetch(workflowUrl(env), { headers: githubHeaders(env), signal: AbortSignal.timeout(15000) });
      lines.push(r.ok ? `✅ GitHub token can read ${WORKFLOW_FILE}. Dispatch also needs Actions: Read and write; only an approved task proves it.`
        : `❌ GitHub HTTP ${r.status}\n   → ${githubHint(r.status)}`);
    } catch (e) { lines.push(`❌ GitHub: ${clamp(e.message, 120)}`); }
  } else lines.push('❌ GitHub settings incomplete (GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO)');
  if (env.WEBSITE_REPO && env.GITHUB_TOKEN) {
    try {
      const r = await fetch(workflowUrl(env, WORKFLOWS.website_dev), { headers: githubHeaders(env), signal: AbortSignal.timeout(15000) });
      lines.push(r.ok ? `✅ Website repo ${env.WEBSITE_REPO}: ${WORKFLOWS.website_dev.file} readable` : `❌ Website repo ${env.WEBSITE_REPO}: HTTP ${r.status}\n   → ${githubHint(r.status)}`);
    } catch (e) { lines.push(`❌ Website repo: ${clamp(e.message, 120)}`); }
  } else lines.push('▫️ Website repo not connected (WEBSITE_REPO unset)');
  lines.push(apiConfigured(env) ? '✅ Laravel API configured (check with /website)' : '▫️ Laravel API not configured');
  return lines.join('\n');
}

async function startImport(env, userId, gutenbergId, requestId) {
  if (!apiConfigured(env)) return 'The website API is not connected yet, so drafts cannot be created. Install the AI API on booksharekh.com and set LARAVEL_API_TOKEN.';
  const running = await env.DB.prepare(`SELECT id FROM tasks WHERE task_type='book_import' AND request_text LIKE ?
      AND status NOT IN ('completed','failed','cancelled','rejected','plan_failed') LIMIT 1`).bind(`%Project Gutenberg #${gutenbergId}`).first();
  if (running) return `This book is already being imported (task ${running.id}).`;
  const book = await getCandidate(gutenbergId);
  if (!book?.publicDomain || !book.epubUrl) return 'This title is not marked public domain with an EPUB on Project Gutenberg, so it cannot be imported.';
  const r = await createBookImport(env, { userId, book, requestId });
  if (r.rateLimited) return T.rateLimited(env, r.limit, r.period);
  if (r.failed) return `Could not start the import (${r.reason}).`;
  return T.preparing(env, book.title, r.id);
}

function decisionText(kind, r, env) {
  if (r.ok) return kind === 'approve' ? T.approved(env, r.approval.task_id) : T.rejected(env, r.approval.task_id, r.prClosed);
  if (r.reason === 'expired') return T.expired(env);
  if (r.reason === 'enqueue_failed') return T.enqueueFailed(env);
  return T.alreadyHandled(env);
}
function cancelText(taskId, r, env) {
  if (r.ok) return T.cancelled(env, taskId);
  if (r.reason === 'running') return T.cancelRunning(env, taskId);
  if (r.reason === 'not_found') return T.notFound(env);
  return T.cannotCancel(env, r.reason.replace('status ', ''));
}

async function resolveTask(env, chat, ref, usage) {
  const parsed = parseTaskRef(ref);
  const task = parsed && await findTask(env, parsed);
  if (!task) await reply(env, chat, parsed ? 'Task not found (or the id prefix matches more than one task).' : `Use: ${usage}`);
  return task;
}


// ---------- entry points ----------
export async function handleMessage(env, m) {
  const user = m.from?.id, chat = m.chat?.id;
  if (!user || !chat || m.chat.type !== 'private' || !isOwner(user, env.OWNER_TELEGRAM_ID)) return;
  const text = String(m.text || '').trim();
  const c = parseCommand(text);
  if (!c) return reply(env, chat, T.unknown(env));
  switch (c.cmd) {
    case 'start': case 'help': case 'menu':
      await registerMenu(env).catch(e => console.error('setMyCommands failed', String(e)));
      return sendHelp(env, chat);
    case 'admin': case 'dev': case 'finance': case 'hr': case 'marketing':
      return sendDepartment(env, chat, c.cmd, agentTitles());
    case 'remember': {
      const parsed = parseMemory(text);
      if (!parsed) return reply(env, chat, 'Use: /remember video.language=Khmer');
      if (looksSecret(parsed.key, parsed.value)) return reply(env, chat, 'Not saved: this looks like a password, key or token. Saved settings are sent to the AI provider with every plan, so never store credentials here.');
      await env.DB.prepare(`INSERT INTO memories (key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).bind(parsed.key, parsed.value).run();
      await audit(env, null, 'MEMORY_UPDATED', user, parsed.key);
      return reply(env, chat, `Saved: ${parsed.key} = ${parsed.value}
(Saved settings are included in AI prompts; on the free Gemini tier Google may use them to improve its products.)`);
    }
    case 'memory': {
      const rows = await env.DB.prepare('SELECT key,value FROM memories ORDER BY updated_at DESC LIMIT 30').all();
      return reply(env, chat, rows.results?.length ? rows.results.map(x => `${x.key} = ${x.value}`).join('\n') : 'No memory saved.');
    }
    case 'forget': {
      const key = c.args.trim();
      if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(key)) return reply(env, chat, T.forgetUsage(env));
      const r = await env.DB.prepare('DELETE FROM memories WHERE key=?').bind(key).run();
      if (r.meta?.changes !== 1) return reply(env, chat, T.forgetMissing(env, key));
      await audit(env, null, 'MEMORY_DELETED', user, key);
      return reply(env, chat, T.forgotten(env, key));
    }
    case 'status': { // one list: tasks waiting for you first (⏳), then the most recent
      const rows = await env.DB.prepare(`SELECT id,status,task_type,created_at FROM tasks
        ORDER BY (status='awaiting_approval') DESC, created_at DESC LIMIT 10`).all();
      return reply(env, chat, rows.results?.length ? rows.results.map(x => `${x.status === 'awaiting_approval' ? '⏳ ' : ''}${short(x.id)} | ${x.status} | ${x.task_type} | ${x.created_at}`).join('\n') : 'No tasks yet.');
    }
    case 'task': {
      if (!c.args) return reply(env, chat, 'Use: /task Make a short promotional video for an authorized sample book');
      const r = await createTask(env, { userId: user, description: c.args });
      if (r.rateLimited) return reply(env, chat, T.rateLimited(env, r.limit, r.period));
      if (r.failed) return;
      return reply(env, chat, T.taskReceived(env, r.id, r.type));
    }
    case 'taskstatus': {
      const task = await resolveTask(env, chat, c.args, '/taskstatus <task-id>');
      return task && reply(env, chat, await taskStatusText(env, task));
    }
    case 'cancel': {
      const task = await resolveTask(env, chat, c.args, '/cancel <task-id>');
      return task && reply(env, chat, cancelText(task.id, await cancelTask(env, task.id, user), env));
    }
    case 'resume': {
      const task = await resolveTask(env, chat, c.args, '/resume <task-id>');
      if (!task) return;
      const r = await resumeTask(env, task.id, user);
      return reply(env, chat, r.ok ? `Resumed ${task.id}. If the quota is still used up it will pause again; nothing switches to paid AI.` : r.reason === 'not_found' ? 'Task not found.' : `Cannot resume: task is ${r.reason.replace('status ', '')}.`);
    }
    case 'develop': {
      if (!c.args) return reply(env, chat, 'Use: /develop Change the homepage heading to "Welcome to BookShareKH"');
      if (!env.WEBSITE_REPO) return reply(env, chat, 'The website repository is not connected yet (WEBSITE_REPO is not set). See README section K.');
      const r = await createTask(env, { userId: user, description: c.args, type: 'website_code_change' });
      if (r.rateLimited) return reply(env, chat, T.rateLimited(env, r.limit, r.period));
      if (r.failed) return;
      return reply(env, chat, T.developReceived(env, r.id));
    }
    case 'deploy': {
      if (!env.WEBSITE_REPO) return reply(env, chat, 'The website repository is not connected yet (WEBSITE_REPO is not set).');
      const r = await fetch(`https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.WEBSITE_REPO)}/commits/main`,
        { headers: githubHeaders(env), signal: AbortSignal.timeout(15000) });
      const head = r.ok ? await r.json() : null;
      if (!/^[0-9a-f]{40}$/.test(head?.sha || '')) return reply(env, chat, T.deployNothing(env));
      const preview = await deployPreviewText(env, head.sha, `main: ${clamp(String(head.commit?.message || '').split('\n')[0], 120)}`);
      const t = await createDeployTask(env, { userId: user, sha: head.sha, preview });
      if (t.rateLimited) return reply(env, chat, T.rateLimited(env, t.limit, t.period));
      return; // the approval message with the file list was sent by the engine
    }
    case 'website': {
      await audit(env, null, 'WEBSITE_CHECK', user, c.args || 'status');
      const lines = [formatHealth(await checkWebsite(env), env)];
      const H = T.health(env);
      if (apiConfigured(env)) {
        try { const h = await apiHealth(env); lines.push(H.apiOk(clamp(h.app || 'ok', 40), clamp(h.laravel || '?', 20), clamp(h.php || '?', 20))); }
        catch (e) { lines.push(H.apiErr(e.message)); }
      } else lines.push(H.apiNone);
      return reply(env, chat, lines.join('\n'));
    }
    case 'books': {
      const [sub, ...rest] = c.args.split(/\s+/).filter(Boolean);
      try {
        if (sub === 'search') {
          const q = rest.join(' ');
          if (!q) return reply(env, chat, 'Use: /books search <title>');
          return reply(env, chat, formatBooks(await searchBooks(env, q), T.searchHeading(env, clamp(q, 60)), T.noBooks(env)));
        }
        const n = Number(rest[0] || (sub && sub !== 'latest' ? sub : 5)) || 5;
        return reply(env, chat, formatBooks(await latestBooks(env, n), T.booksHeading(env, n), T.noBooks(env)));
      } catch (e) {
        if (e instanceof WebsiteApiError) return reply(env, chat, e.message);
        throw e;
      }
    }
    case 'preview': return sendSamples(env, chat);
    case 'promo': {
      try {
        // One video at a time, about the website (covers are only visuals).
        const busy = await env.DB.prepare(`SELECT id FROM tasks WHERE task_type='book_promo'
            AND status IN ('planning','queued','awaiting_approval','dispatching','running') AND created_at > datetime('now','-2 hours') LIMIT 1`).first();
        if (busy) return reply(env, chat, T.promoBusy(env));
        const r = await createPromoTask(env, { userId: user, input: await nextPromoInput(env) });
        if (r.rateLimited) return reply(env, chat, T.rateLimited(env, r.limit, r.period));
        if (r.failed) return;
        return reply(env, chat, T.promoStarted(env));
      } catch (e) {
        if (e instanceof WebsiteApiError) return reply(env, chat, e.message);
        throw e;
      }
    }
    case 'recommend': {
      try { return await sendRecommendations(env); } catch (e) {
        if (e instanceof WebsiteApiError) return reply(env, chat, e.message);
        throw e;
      }
    }
    case 'users': {
      try { return reply(env, chat, await usersSummary(env)); } catch (e) {
        if (e instanceof WebsiteApiError) return reply(env, chat, e.message);
        throw e;
      }
    }
    case 'topups': {
      try {
        const pending = await pendingTopups(env);
        if (!pending.length) return reply(env, chat, T.noTopups(env));
        for (const t of pending) await sendTopupAlert(env, t);
        return;
      } catch (e) {
        if (e instanceof WebsiteApiError) return reply(env, chat, e.message);
        throw e;
      }
    }
    case 'requests': {
      try {
        const pending = await recentPendingRequests(env);
        if (!pending.length) return reply(env, chat, T.noPending(env));
        for (const r of pending) await reply(env, chat, T.requestAlert(env, r), { reply_markup: requestKeyboard(r.id, env) });
        return;
      } catch (e) {
        if (e instanceof WebsiteApiError) return reply(env, chat, e.message);
        throw e;
      }
    }
    case 'research': {
      if (!c.args) return reply(env, chat, 'Use: /research Pride and Prejudice');
      let found;
      try { found = await searchPublicDomain(c.args, { languages: env.BOOK_LANGUAGES }); }
      catch (e) { if (e instanceof SourceDownError) return reply(env, chat, T.sourceDown(env)); throw e; }
      const m = candidatesMessage(c.args, found, 0, env);
      return reply(env, chat, m.text, m.reply_markup ? { reply_markup: m.reply_markup } : {});
    }
    case 'agents': return reply(env, chat, await agentsText(env));
    case 'agent': {
      const [name, sub, ...rest] = c.args.split(/\s+/).filter(Boolean);
      const a = AGENTS[name];
      if (!a) return reply(env, chat, `Use: /agent <name>. Agents: ${Object.keys(AGENTS).join(', ')}`);
      if (sub === 'set') return reply(env, chat, await agentSet(env, user, a, rest));
      return reply(env, chat, await agentText(env, a));
    }
    case 'diag': return reply(env, chat, await diagnostics(env));
    default: return reply(env, chat, T.unknown(env));
  }
}

export async function handleCallback(env, q) {
  const user = q.from?.id, chat = q.message?.chat?.id;
  const owner = isOwner(user, env.OWNER_TELEGRAM_ID);
  await tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: owner ? 'Decision received' : 'Unauthorized', show_alert: !owner });
  if (!chat || q.message.chat.type !== 'private' || !owner) return;
  const data = String(q.data || '');
  let m;
  if ((m = /^(ap|rj):(APR-[a-f0-9-]{36})$/.exec(data))) {
    const kind = m[1] === 'ap' ? 'approve' : 'reject';
    return reply(env, chat, decisionText(kind, kind === 'approve' ? await approveStep(env, m[2], user) : await rejectStep(env, m[2], user), env));
  }
  if ((m = /^cx:(BSK-[a-f0-9-]{36})$/.exec(data))) return reply(env, chat, cancelText(m[1], await cancelTask(env, m[1], user), env));
  // Department menu buttons: open a department, or run a command that needs no extra text.
  if ((m = /^dp:([a-z]+)$/.exec(data))) return m[1] === 'all' ? sendHelp(env, chat) : DEPT_BY_KEY[m[1]] && sendDepartment(env, chat, m[1], agentTitles());
  if ((m = /^run:([a-z]+)$/.exec(data)) && TAP_COMMANDS.has(m[1])) {
    return handleMessage(env, { from: q.from, chat: q.message.chat, text: `/${m[1]}` });
  }
  try {
    if ((m = /^bi:(\d{1,7}):(\d{1,10})$/.exec(data))) return reply(env, chat, await startImport(env, user, Number(m[1]), Number(m[2]) || null));
    if ((m = /^rq:(\d{1,10})$/.exec(data))) {
      const msg = await findForRequest(env, Number(m[1]), user);
      return reply(env, chat, msg.text, msg.reply_markup ? { reply_markup: msg.reply_markup } : {});
    }
    if ((m = /^rr:(\d{1,10})$/.exec(data))) { await rejectRequest(env, Number(m[1]), user); return reply(env, chat, T.requestRejected(env, m[1])); }
    if ((m = /^t(a|r):(\d{1,10})$/.exec(data))) return reply(env, chat, await decideTopup(env, Number(m[2]), m[1] === 'a', user, q.message));
  } catch (e) {
    if (e instanceof WebsiteApiError) return reply(env, chat, e.message);
    if (e instanceof SourceDownError) return reply(env, chat, T.sourceDown(env));
    throw e;
  }
}
