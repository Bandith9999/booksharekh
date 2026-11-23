// Bot language. BOT_LANGUAGE=km (wrangler.jsonc) -> short Khmer messages; anything else -> English.
// Commands, IDs and technical words (PR, commit, deploy, EPUB, Laravel...) stay in English on purpose.
// Technical screens (/diag, /agents, /taskstatus) are English only.

export const isKhmer = env => env?.BOT_LANGUAGE === 'km';
const pick = (env, en, km) => (isKhmer(env) ? km : en);

// First line of every alert, so the kind is clear at a glance (owner request).
const NOTES = {
  topup: ['TOP-UP', 'បញ្ចូលប្រាក់'],
  member: ['NEW MEMBER', 'សមាជិកថ្មី'],
  request: ['BOOK REQUEST', 'សំណើសៀវភៅ'],
  promo: ['PROMO VIDEO', 'វីដេអូផ្សព្វផ្សាយ'],
  recommend: ['BOOK IDEAS', 'ណែនាំសៀវភៅ'],
};
export const note = (env, kind) => `*** ${pick(env, ...NOTES[kind])} ***`;
const short = id => `${String(id).slice(0, 17)}…`;

export const T = {
  unknown: env => pick(env, 'Unknown command. Try /help.', 'មិនស្គាល់ command។ សូមវាយ /help'),
  taskReceived: (env, id, type) => pick(env, `📝 Task ${id} received (type ${type}). Planning now; the plan and approval buttons will follow.`, `📝 បានទទួល ${short(id)} — កំពុងរៀបចំផែនការ…`),
  developReceived: (env, id) => pick(env, `📝 Website task ${id} received. Planning now; then you approve running the Laravel Developer, which opens a pull request. Nothing is deployed.`, `📝 បានទទួល ${short(id)} — កំពុងរៀបចំផែនការកែកូដ…`),
  rateLimited: (env, limit, period) => pick(env, `Limit reached: at most ${limit} tasks per ${period}. Try again later.`, `⛔ ដល់ដែនកំណត់ ${limit} task ក្នុង${String(period).startsWith('day') ? 'មួយថ្ងៃ' : 'មួយម៉ោង'}។`),

  // Approval request (plan or preview + proposed action + buttons)
  approval: (env, task, proposal, actionText, ttl) => pick(env,
    `Task ${task.id}\nType: ${task.task_type}\n\n${proposal}\n\nProposed action: ${actionText}\nApproval expires in ${ttl} h.`,
    `${proposal}\n\n👉 ${actionText}\n⏳ ${ttl} ម៉ោង · ${short(task.id)}`),
  buttons: env => pick(env, { approve: '✅ Approve', reject: '❌ Reject', cancel: '🛑 Cancel task' }, { approve: '✅ យល់ព្រម', reject: '❌ បដិសេធ', cancel: '🛑 បោះបង់' }),

  approved: (env, taskId) => pick(env, `Approved ${taskId}. Running now; you'll get a message when it finishes.`, '✅ យល់ព្រមហើយ — កំពុងដំណើរការ…'),
  rejected: (env, taskId, prClosed) => pick(env, `Rejected ${taskId}. ${prClosed ? 'The pull request was closed.' : 'Nothing dispatched.'}`, `❌ បានបដិសេធ។${prClosed ? ' PR ត្រូវបានបិទ។' : ''}`),
  expired: env => pick(env, 'This approval expired, so nothing was dispatched. Send the /task again.', '⏳ ការយល់ព្រមនេះផុតកំណត់ហើយ។ សូមផ្ញើម្តងទៀត។'),
  enqueueFailed: env => pick(env, 'Approval recorded, but the job could not be queued; see the error above.', '⚠️ យល់ព្រមហើយ ប៉ុន្តែមិនអាចដាក់ចូល queue បាន។'),
  alreadyHandled: env => pick(env, 'This decision has already been handled, or the task cannot be approved.', 'ការសម្រេចនេះបានធ្វើរួចហើយ។'),

  cancelled: (env, id) => pick(env, `Cancelled ${id}. Open approvals were revoked; nothing will run.`, `🛑 បានបោះបង់ ${short(id)}។`),
  cancelRunning: (env, id) => pick(env, `${id} is already running on GitHub Actions and cannot be stopped from here. Cancel the run in GitHub if needed.`, `${short(id)} កំពុងដំណើរការលើ GitHub — មិនអាចបោះបង់ពីទីនេះបានទេ។`),
  notFound: env => pick(env, 'Task not found.', 'រកមិនឃើញ task។'),
  cannotCancel: (env, status) => pick(env, `Cannot cancel: task is ${status}.`, `មិនអាចបោះបង់បាន (status: ${status})។`),

  // Execution reports
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
  requestAlert: (env, r) => `${note(env, 'request')}\n` + pick(env, `📚 #${r.id} ${r.book_title}${r.author ? ` — ${r.author}` : ''}${r.language ? ` (${r.language})` : ''}`, `📚 #${r.id} ${r.book_title}${r.author ? ` — ${r.author}` : ''}`),
  requestButtons: env => ({ find: pick(env, '🔎 Find a legal copy', '🔎 ស្វែងរក'), reject: T.buttons(env).reject }),
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
  sourceDown: env => pick(env, '🔧 The book source (Project Gutenberg) is temporarily unavailable. Please try again later.', '🔧 ប្រភពសៀវភៅ (Project Gutenberg) មិនដំណើរការបណ្ដោះអាសន្ន។ សូមសាកម្តងទៀតពេលក្រោយ។'),
  deployHead: (env, sha) => pick(env, `🚀 Ready to deploy commit ${sha} to booksharekh.com.`, `🚀 រួចរាល់ deploy commit ${sha} ទៅ booksharekh.com`),
  deployFiles: (env, n) => pick(env, `Files that will change (${n}):`, `ឯកសារដែលនឹងប្តូរ (${n}):`),
  deployDone: (env, ok, note, url) => pick(env, `${ok ? '✅ Deployed to booksharekh.com.' : '❌ Deploy failed.'}
${note}${url ? `
${url}` : ''}`, `${ok ? '✅ បាន deploy ទៅ booksharekh.com ហើយ។' : '❌ Deploy បរាជ័យ។'}
${note}${url ? `
${url}` : ''}`),
  deployNothing: env => pick(env, 'Nothing new to deploy: main has no commits.', 'មិនមានអ្វីថ្មីសម្រាប់ deploy ទេ។'),
  noPending: env => pick(env, 'No pending book requests.', 'គ្មានសំណើសៀវភៅរង់ចាំ'),
  requestRejected: (env, id) => pick(env, `❌ Book request #${id} rejected.`, `❌ សំណើ #${id} បានបដិសេធ`),

  // Top-ups (money): show exactly what will be credited.
  topupAlert: (env, t) => {
    const lines = [note(env, 'topup'), `💰 Top-up #${t.id}`, `👤 ${t.user || '?'}`, `💵 ${t.amount} ${t.currency} · ${String(t.method || '').toUpperCase()}`,
      t.transaction_id ? `🧾 ${t.transaction_id}` : '', t.notes ? `📝 ${t.notes}` : '', t.has_image ? '' : pick(env, '⚠️ No receipt image', '⚠️ គ្មានរូបវិក្កយបត្រ')];
    return [...lines.filter(Boolean), '', pick(env, '👉 Approve and credit this balance?', '👉 បញ្ចូលលុយ?')].join('\n');
  },
  topupButtons: env => T.buttons(env), // same Approve / Reject buttons as everywhere else
  topupApproved: (env, t, balance) => pick(env, `✅ Top-up #${t.id} approved: +${t.amount} ${t.currency} for ${t.user}. Balance: ${balance}`,
    `✅ Top-up #${t.id} +${t.amount} ${t.currency} · ${t.user} (សមតុល្យ ${balance})`),
  topupRejected: (env, id) => pick(env, `❌ Top-up #${id} rejected. No balance added.`, `❌ Top-up #${id} បានបដិសេធ`),
  topupProblem: (env, id, msg) => pick(env, `⚠️ Top-up #${id}: ${msg}`, `⚠️ Top-up #${id}: ${msg}`),
  topupUnknown: env => pick(env, 'This top-up is no longer in my list. Send /topups to see pending ones.', 'រកមិនឃើញ។ សូមវាយ /topups'),
  // Users: one short message per check, only when something happened.
  userActivity: (env, reg, total) => `${note(env, 'member')}\n${reg}\n\n` + pick(env, `👥 Total users: ${total}`, `👥 សរុប ${total} នាក់`),
  usersSummary: (env, total, reg, logins) => pick(env, `👥 Total users: ${total}\n🆕 New (24h): ${reg}\n🔑 Logged in (24h): ${logins}`,
    `👥 សរុប ${total} នាក់\n🆕 ថ្មី (24h): ${reg}\n🔑 Login (24h): ${logins}`),
  // Marketing promo videos (posting on TikTok / Facebook is done by the owner).
  promoVideo: (env, n, total, b) => `${note(env, 'promo')}\n🎬 ${n}/${total} · ${b.title}${b.author ? ` — ${b.author}` : ''}\n` +
    pick(env, '👇 Caption in the next message (copy it)', '👇 Caption នៅសារបន្ទាប់ (copy យកទៅ post)'),
  promoDone: (env, ok, msg) => (ok ? pick(env, '✅ Promo videos ready. Post them on TikTok / Facebook.', '✅ វីដេអូរួចរាល់ — post លើ TikTok / Facebook')
    : pick(env, `❌ Promo video failed: ${msg}`, `❌ បង្កើតវីដេអូមិនបាន: ${msg}`)),
  recommend: (env, lines) => [note(env, 'recommend'),
    pick(env, '📈 Popular books the website does not have yet:', '📈 សៀវភៅពេញនិយម ដែលវេបសាយមិនទាន់មាន:'), ...lines].join('\n'),
  recommendNone: env => pick(env, 'No new book ideas this time: the sources are down or the site already has them.', 'គ្មានសៀវភៅថ្មីសម្រាប់ណែនាំលើកនេះ'),
  promoNone: env => pick(env, 'No book to promote: all popular and new books were promoted in the last 14 days.', 'គ្មានសៀវភៅថ្មីសម្រាប់ផ្សព្វផ្សាយ (បានធ្វើក្នុង 14 ថ្ងៃមុនរួច)'),
  promoStarted: env => pick(env, '🎬 Writing Khmer captions…', '🎬 កំពុងសរសេរ caption…'),
  noTopups: env => pick(env, 'No pending top-ups.', 'គ្មាន topup រង់ចាំ'),
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

// ---- Minimal Khmer (owner request): only what is needed to decide. No links, IDs, commits or timers. ----
const KM_SHORT = {
  taskReceived: () => '📝 កំពុងរៀបចំផែនការ…',
  developReceived: () => '📝 កំពុងរៀបចំផែនការ…',
  approval: (task, proposal, actionText) => `${proposal}\n\n👉 ${actionText}`,
  approved: () => '✅ កំពុងដំណើរការ…',
  rejected: (taskId, prClosed) => (prClosed ? '❌ បានបដិសេធ · PR បិទ' : '❌ បានបដិសេធ'),
  cancelled: () => '🛑 បានបោះបង់',
  jobDone: (taskId, state, note, url, demo, prUrl) => (state === 'completed' ? `✅ រួចរាល់${note && !demo ? `\n${note}` : ''}` : `❌ បរាជ័យ: ${note}`),
  merged: n => `✅ Merged PR #${n}`,
  planFailed: (task, msg) => `⚠️ រៀបចំផែនការមិនបាន: ${msg}`,
  stepFailed: (task, step, msg) => `❌ ${msg}`,
  preparing: () => '📥 កំពុងរៀបចំ draft…',
  draftPreview: b => [`📖 ${b.title} — ${b.author}`, `EPUB ${b.mb}MB${b.cover ? ' + គម្រប' : ''} · public domain`, b.dups ? `⚠️ មានរួចហើយ (#${b.dups})` : ''].filter(Boolean).join('\n'),
  published: (p, bookId, slug, requestNote) => `✅ បាន publish "${p.title}"${requestNote}`,
  requestDone: () => ' · សំណើរួចរាល់',
  deployDone: (ok, note) => (ok ? '✅ បាន deploy រួច' : `❌ Deploy បរាជ័យ: ${note}`),
};
for (const [key, short] of Object.entries(KM_SHORT)) {
  const full = T[key];
  T[key] = (env, ...args) => (isKhmer(env) ? short(...args) : full(env, ...args));
}

// Short Khmer "👉" questions for each approval, by action type.
export const KM_ACTION = {
  dispatch_github_job: 'ដំណើរការ?',
  dispatch_code_change: 'ឲ្យ AI កែកូដ?',
  merge_pull_request: 'Merge?',
  deploy_website: 'Deploy ទៅវេបសាយ?',
  prepare_book_draft: 'រៀបចំ draft?',
  publish_book: 'Publish លើវេបសាយ?',
  create_promo_video: 'បង្កើតវីដេអូ?',
};
