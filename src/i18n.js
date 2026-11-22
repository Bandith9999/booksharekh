// Bot language. BOT_LANGUAGE=km (wrangler.jsonc) -> short Khmer messages; anything else -> English.
// Commands, IDs and technical words (PR, commit, deploy, EPUB, Laravel...) stay in English on purpose.
// Technical screens (/diag, /agents, /taskstatus) are English only.

export const isKhmer = env => env?.BOT_LANGUAGE === 'km';
const pick = (env, en, km) => (isKhmer(env) ? km : en);
const short = id => `${String(id).slice(0, 17)}…`;

export const T = {
  help: env => pick(env, null, `🤖 BookShareKH Manager
/task <សំណើ> — រៀបចំការងារ
/develop <ការកែ> — កែកូដវេបសាយ (PR)
/research <ចំណងជើង> — រកសៀវភៅ public domain
/books [latest N | search <ចំណងជើង>] — សៀវភៅលើវេបសាយ
/website — ពិនិត្យវេបសាយ
/status · /pending · /taskstatus <id>
/approve · /reject · /cancel · /resume <id>
/agents · /diag · /memory · /remember key=value

រាល់ការផ្លាស់ប្តូរ ត្រូវរង់ចាំការយល់ព្រមពីអ្នក។`),
  unknown: env => pick(env, 'Unknown command. Try /help.', 'មិនស្គាល់ command។ សូមវាយ /help'),
  taskReceived: (env, id, type) => pick(env, `📝 Task ${id} received (type ${type}). Planning now; the plan and approval buttons will follow.`, `📝 បានទទួល ${short(id)} — កំពុងរៀបចំផែនការ…`),
  developReceived: (env, id) => pick(env, `📝 Website task ${id} received. Planning now; then you approve running the Laravel Developer, which opens a pull request. Nothing is deployed.`, `📝 បានទទួល ${short(id)} — កំពុងរៀបចំផែនការកែកូដ…`),
  rateLimited: (env, limit, period) => pick(env, `Limit reached: at most ${limit} tasks per ${period}. Try again later.`, `⛔ ដល់ដែនកំណត់ ${limit} task ក្នុង ${period}។`),

  // Approval request (plan or preview + proposed action + buttons)
  approval: (env, task, proposal, actionText, ttl) => pick(env,
    `Task ${task.id}\nType: ${task.task_type}\n\n${proposal}\n\nProposed action: ${actionText}\nApproval expires in ${ttl} h.`,
    `${proposal}\n\n👉 ${actionText}\n⏳ ${ttl} ម៉ោង · ${short(task.id)}`),
  buttons: env => pick(env, { approve: '✅ Approve', reject: '❌ Reject', cancel: '🛑 Cancel task' }, { approve: '✅ យល់ព្រម', reject: '❌ បដិសេធ', cancel: '🛑 បោះបង់' }),

  approved: (env, taskId) => pick(env, `Approved ${taskId}. Queued; you'll get a message when the GitHub job starts.`, '✅ យល់ព្រមហើយ — កំពុងដំណើរការ…'),
  rejected: (env, taskId, prClosed) => pick(env, `Rejected ${taskId}. ${prClosed ? 'The pull request was closed.' : 'Nothing dispatched.'}`, `❌ បានបដិសេធ។${prClosed ? ' PR ត្រូវបានបិទ។' : ''}`),
  expired: env => pick(env, 'This approval expired, so nothing was dispatched. Send the /task again.', '⏳ ការយល់ព្រមនេះផុតកំណត់ហើយ។ សូមផ្ញើម្តងទៀត។'),
  enqueueFailed: env => pick(env, 'Approval recorded, but the job could not be queued; see the error above.', '⚠️ យល់ព្រមហើយ ប៉ុន្តែមិនអាចដាក់ចូល queue បាន។'),
  alreadyHandled: env => pick(env, 'This decision has already been handled, or the task cannot be approved.', 'ការសម្រេចនេះបានធ្វើរួចហើយ។'),

  cancelled: (env, id) => pick(env, `Cancelled ${id}. Open approvals were revoked; nothing will run.`, `🛑 បានបោះបង់ ${short(id)}។`),
  cancelRunning: (env, id) => pick(env, `${id} is already running on GitHub Actions and cannot be stopped from here. Cancel the run in GitHub if needed.`, `${short(id)} កំពុងដំណើរការលើ GitHub — មិនអាចបោះបង់ពីទីនេះបានទេ។`),
  notFound: env => pick(env, 'Task not found.', 'រកមិនឃើញ task។'),
  cannotCancel: (env, status) => pick(env, `Cannot cancel: task is ${status}.`, `មិនអាចបោះបង់បាន (status: ${status})។`),

  // Execution reports
  jobStarted: (env, taskId, label) => pick(env, `🚀 Task ${taskId}: GitHub Actions ${label} started. You'll get a message when it finishes.`, `🚀 ${label} បានចាប់ផ្តើម · ${short(taskId)}`),
  jobDone: (env, taskId, state, note, url, demo, prUrl = '') => pick(env,
    `Task ${taskId}: ${state}\n${note}\n${url}${demo ? '\n\nDemo job only. No public post or Laravel upload performed.' : prUrl ? `\n\nDraft pull request (not merged): ${prUrl}` : '\n\nNo pull request was created.'}`,
    `${state === 'completed' ? '✅' : '❌'} ${short(taskId)}: ${state}\n${note}${url ? `\n${url}` : ''}${prUrl ? `\nPR (draft): ${prUrl}` : ''}`),
  merged: (env, n, sha) => pick(env, `✅ Merged pull request #${n} into main (commit ${sha}).\nThe live site has not changed yet; deploying is a separate step.`, `✅ បាន merge PR #${n} (commit ${sha})។ វេបសាយផ្ទាល់មិនទាន់ប្តូរទេ។`),
  planFailed: (env, task, msg) => pick(env, `Task ${task.id}\nType: ${task.task_type}\n\n⚠️ AI planning failed: ${msg}\n\nThis task cannot be approved or dispatched. Run /diag, fix the problem, then send the /task again.`, `⚠️ រៀបចំផែនការមិនបាន: ${msg}\nសូមពិនិត្យ /diag ហើយផ្ញើម្តងទៀត។`),
  stepFailed: (env, task, step, msg) => pick(env, `⚠️ Task ${task.id} failed at ${step}:\n${msg}\n\nNo automatic retry.`, `❌ ${short(task.id)} បរាជ័យ: ${msg}`),
  paused: (env, task, msg, ref) => pick(env, `⏸ Task ${task.id} paused: ${msg}\n\nNo paid AI provider was used. Google's free quota resets at midnight Pacific time; local limits reset at 00:00 UTC.\nSend /resume ${ref} to continue, or /cancel ${ref}.`, `⏸ បានផ្អាក: ${msg}\n/resume ${ref} ឬ /cancel ${ref}`),
  processingError: (env, msg) => pick(env, `⚠️ Your last message could not be processed (${msg}). Nothing was retried; please send it again.`, `⚠️ មិនអាចដំណើរការសារចុងក្រោយបាន (${msg})។ សូមផ្ញើម្តងទៀត។`),

  // Pull request review shown before the merge approval
  prReview: env => pick(env,
    { ready: (n, url) => `🔍 Pull request #${n} is ready: ${url}`, files: c => `Changed files (${c}):`, changes: 'Changes:', more: c => `… ${c} more changed lines (see the PR)`, noDiff: 'The diff could not be loaded here; open the link to review it.', checks: 'Checks passed in the Laravel Developer job (PHP lint, tests, secret scan).' },
    { ready: (n, url) => `🔍 PR #${n} រួចរាល់: ${url}`, files: c => `ឯកសារដែលបានកែ (${c}):`, changes: 'ការកែប្រែ:', more: c => `… និង ${c} បន្ទាត់ទៀត (មើលក្នុង PR)`, noDiff: 'មិនអាចបង្ហាញ diff បាន — សូមបើក link។', checks: '✅ PHP lint · tests · secret scan' }),

  // Plan rendering
  plan: env => pick(env,
    { head: who => `Plan by ${who}:`, steps: 'Proposed steps (only the job named under "Proposed action" runs after approval):', risks: 'Risks / approvals:', rights: v => `Rights verification needed: ${v ? 'yes' : 'no'}` },
    { head: who => `📋 ផែនការ (${who}):`, steps: 'ជំហាន:', risks: '⚠️ ហានិភ័យ:', rights: v => (v ? '⚖️ ត្រូវពិនិត្យសិទ្ធិអ្នកនិពន្ធ' : '') }),

  // Books
  requestAlert: (env, r) => pick(env, `📚 New book request #${r.id}\n${r.book_title}${r.author ? ` — ${r.author}` : ''}${r.language ? ` (${r.language})` : ''}`, `📚 សំណើសៀវភៅ #${r.id}\n${r.book_title}${r.author ? ` — ${r.author}` : ''}`),
  requestButtons: env => pick(env, { find: '🔎 Find a legal copy', reject: '🚫 Reject request' }, { find: '🔎 ស្វែងរក', reject: '🚫 បដិសេធ' }),
  watching: (env, cursor) => pick(env, `👀 Watching booksharekh.com book requests from #${cursor} onward. New requests will appear here.`, `👀 កំពុងតាមដានសំណើសៀវភៅ (ចាប់ពី #${cursor})។`),
  candidates: env => pick(env,
    { head: q => `📚 Public-domain matches for "${q}" (Project Gutenberg):`, foot: 'Tap one to prepare a private draft. Nothing is published without your second approval.', button: i => `📥 Prepare draft ${i}`,
      none: q => `No public-domain copy of "${q}" was found on Project Gutenberg. It is probably still under copyright: get a licensed copy from the author or publisher, then add it in the admin panel.` },
    { head: q => `📚 រកឃើញ "${q}" (public domain):`, foot: 'ចុចដើម្បីរៀបចំ draft (មិនទាន់បង្ហាញ)។', button: i => `📥 រៀបចំ draft ${i}`,
      none: q => `រកមិនឃើញ "${q}" ក្នុង public domain ទេ — ប្រហែលនៅមាន copyright។ សូមរកច្បាប់ដែលមាន license។` }),
  preparing: (env, title, id) => pick(env, `📥 Preparing a private draft of "${title}" (task ${id}). You will get a preview with a Publish button.`, `📥 កំពុងរៀបចំ draft "${title}"…`),
  draftPreview: (env, b) => pick(env,
    [`📖 Draft ready on booksharekh.com (private, not visible to visitors)`, `Title: ${b.title}`, `Author: ${b.author}`, `Genres: ${b.genres} · Language: ${b.languages}`,
     `Files: EPUB ${b.mb} MB (sha256 ${b.sha}…)${b.cover ? ', cover image' : ', no cover'}`, `Rights: public domain (Project Gutenberg #${b.id}) ${b.url}`,
     b.dups ? `⚠️ A book with this title already exists on the site (#${b.dups}). Publishing will be refused.` : 'No duplicate title found on the site.'].join('\n'),
    [`📖 Draft រួចរាល់ (មិនទាន់បង្ហាញ)`, `${b.title} — ${b.author}`, `EPUB ${b.mb} MB${b.cover ? ' + គម្រប' : ''} · ${b.languages}`, `⚖️ Public domain (Gutenberg #${b.id})`,
     b.dups ? `⚠️ មានសៀវភៅនេះរួចហើយ (#${b.dups}) — នឹងមិន publish ទេ។` : ''].filter(Boolean).join('\n')),
  published: (env, p, bookId, slug, requestNote) => pick(env, `✅ Published "${p.title}" by ${p.author} on booksharekh.com (book #${bookId}${slug ? `, /${slug}` : ''}).${requestNote}`, `✅ បានផ្សព្វផ្សាយ "${p.title}" (book #${bookId})។${requestNote}`),
  requestDone: (env, id) => pick(env, `\nBook request #${id} marked done.`, ` សំណើ #${id} រួចរាល់។`),
  requestRejected: (env, id) => pick(env, `Book request #${id} rejected.`, `🚫 សំណើ #${id} ត្រូវបានបដិសេធ។`),
  booksHeading: (env, n) => pick(env, `Latest ${n} books:`, `សៀវភៅថ្មីៗ ${n}:`),
  searchHeading: (env, q) => pick(env, `Books matching "${q}":`, `លទ្ធផល "${q}":`),
  noBooks: env => pick(env, '(no books found)', '(រកមិនឃើញ)'),

  // /website health
  health: env => pick(env,
    { head: s => `Website check: ${s}`, home: (st, ms, pw) => `Homepage HTTP ${st} in ${ms} ms${pw ? ` (${pw})` : ''}`, down: d => `Homepage unreachable: ${d}`,
      debugOn: 'Debug mode is ON in production (Ignition can execute commands). Set APP_DEBUG=false and clear the config cache.',
      ignition: 'Ignition debug endpoint is reachable (commands disabled). Remove it from production or set APP_DEBUG=false.', debugOff: 'Debug endpoint not exposed',
      exposed: p => `${p} is publicly readable (HTTP 200)`, safe: list => `${list} not public`,
      apiOk: (app, lv, php) => `✅ Laravel API: ${app} · Laravel ${lv} · PHP ${php}`, apiErr: m => `❌ Laravel API: ${m}`, apiNone: '▫️ Laravel API not connected yet (needs the website repository first).' },
    { head: s => `🌐 ពិនិត្យ ${s}`, home: (st, ms) => `Homepage HTTP ${st} (${ms} ms)`, down: d => `វេបសាយចូលមិនបាន: ${d}`,
      debugOn: 'Debug mode កំពុងបើក! សូមដាក់ APP_DEBUG=false', ignition: 'Ignition debug endpoint អាចចូលបាន — សូមដាក់ APP_DEBUG=false', debugOff: 'Debug mode បិទ',
      exposed: p => `${p} អាចចូលមើលបាន!`, safe: () => 'ឯកសារសំខាន់ៗ (.env, .git) មិនអាចចូលបាន',
      apiOk: () => '✅ Laravel API ភ្ជាប់រួច', apiErr: m => `❌ Laravel API: ${m}`, apiNone: '▫️ Laravel API មិនទាន់ភ្ជាប់' }),
};

// For keys whose English text is null, the caller keeps its existing English text.
export const tr = (value, fallback) => (value == null ? fallback : value);

// Extra instruction for the Manager's AI plan in Khmer.
export const planLanguageRule = env => (isKhmer(env)
  ? '\nWrite summary, objectives and risks in Khmer (Khmer script). Keep technical terms in English (pull request, commit, deploy, Laravel, Blade, EPUB, PDF, GitHub). Be brief: summary under 40 words, at most 3 steps, at most 3 risks.'
  : '');
