// Bot language. BOT_LANGUAGE=km (wrangler.jsonc) -> short Khmer messages; anything else -> English.
// Commands, IDs and technical words (PR, commit, deploy, EPUB, Laravel...) stay in English on purpose.
// Technical screens (/diag, /agents, /taskstatus) are English only.

export const isKhmer = env => env?.BOT_LANGUAGE === 'km';
const pick = (env, en, km) => (isKhmer(env) ? km : en);

// First line of every alert: the department it belongs to (as in /help) and the kind of alert (owner request).
const DEPT = { finance: '💰 Finance', hr: '👥 HR', marketing: '📣 Marketing', admin: '👑 Administrator' };
const NOTES = {
  topup: ['finance', 'TOP-UP', 'បញ្ចូលប្រាក់'],
  purchase: ['finance', 'BOOK PURCHASE', 'ទិញសៀវភៅ'],
  member: ['hr', 'NEW MEMBER', 'សមាជិកថ្មី'],
  request: ['marketing', 'BOOK REQUEST', 'សំណើសៀវភៅ'],
  promo: ['marketing', 'PROMO VIDEO', 'វីដេអូផ្សព្វផ្សាយ'],
  poster: ['marketing', 'POSTER', 'Poster ផ្សព្វផ្សាយ'],
  recommend: ['admin', 'BOOK IDEAS', 'ណែនាំសៀវភៅ'],
};
export const note = (env, kind) => { const [dept, en, km] = NOTES[kind]; return `${DEPT[dept]} · *** ${pick(env, en, km)} ***`; };
const short = id => `${String(id).slice(0, 17)}…`;
// "23/11 09:00" in Phnom Penh time.
const khTime = t => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Phnom_Penh', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t).replace(',', '');

// Message style (owner request): short and easy to scan. Line 1 = icon + what happened; then a few
// short facts, one per line; the last line = what to do next (if anything). No long explanations.
export const T = {
  unknown: env => pick(env, '❓ Unknown command · /help', '❓ មិនស្គាល់ command · /help'),
  taskReceived: (env, id, type) => pick(env, `📝 Task received · ${type}\n⏳ Planning…`, `📝 បានទទួល ${short(id)} — កំពុងរៀបចំផែនការ…`),
  developReceived: (env, id) => pick(env, '💻 Website change received\n⏳ Planning…', `📝 បានទទួល ${short(id)} — កំពុងរៀបចំផែនការកែកូដ…`),
  rateLimited: (env, limit, period) => pick(env, `⛔ Limit: ${limit} tasks per ${period}. Try later.`, `⛔ ដល់ដែនកំណត់ ${limit} task ក្នុង${String(period).startsWith('day') ? 'មួយថ្ងៃ' : 'មួយម៉ោង'}។`),

  // Approval request (plan or preview + proposed action + buttons)
  approval: (env, task, proposal, actionText, ttl) => pick(env,
    `${proposal}\n\n👉 ${actionText}\n⏳ ${ttl} h · ${short(task.id)}`,
    `${proposal}\n\n👉 ${actionText}\n⏳ ${ttl} ម៉ោង · ${short(task.id)}`),
  buttons: env => pick(env, { approve: '✅ Approve', reject: '❌ Reject', cancel: '🛑 Cancel' }, { approve: '✅ យល់ព្រម', reject: '❌ បដិសេធ', cancel: '🛑 បោះបង់' }),

  approved: (env, taskId) => pick(env, '✅ Approved · running…', '✅ យល់ព្រមហើយ — កំពុងដំណើរការ…'),
  rejected: (env, taskId, prClosed) => pick(env, `❌ Rejected${prClosed ? ' · PR closed' : ''}`, `❌ បានបដិសេធ${prClosed ? ' · PR បិទ' : ''}`),
  expired: env => pick(env, '⏳ Approval expired. Send it again.', '⏳ ការយល់ព្រមផុតកំណត់ — សូមផ្ញើម្តងទៀត'),
  enqueueFailed: env => pick(env, '⚠️ Approved, but could not start.', '⚠️ យល់ព្រមហើយ ប៉ុន្តែចាប់ផ្តើមមិនបាន'),
  alreadyHandled: env => pick(env, 'ℹ️ Already handled.', 'ℹ️ បានធ្វើរួចហើយ'),

  cancelled: (env, id) => pick(env, `🛑 Cancelled · ${short(id)}`, `🛑 បានបោះបង់ ${short(id)}`),
  cancelRunning: (env, id) => pick(env, `⚙️ ${short(id)} is running on GitHub — cancel it there.`, `⚙️ ${short(id)} កំពុងដំណើរការលើ GitHub — បោះបង់ពីទីនេះមិនបាន`),
  notFound: env => pick(env, '❓ Task not found', '❓ រកមិនឃើញ task'),
  cannotCancel: (env, status) => pick(env, `⚠️ Cannot cancel (${status})`, `⚠️ បោះបង់មិនបាន (${status})`),

  // Execution reports
  jobDone: (env, taskId, state, note, url, demo, prUrl = '') => pick(env,
    [`${state === 'completed' ? '✅ Done' : '❌ Failed'} · ${short(taskId)}`, note, prUrl ? `🔀 PR (draft): ${prUrl}` : '', url ? `🔗 ${url}` : '', demo ? 'ℹ️ Demo job: nothing posted or uploaded.' : ''].filter(Boolean).join('\n'),
    `${state === 'completed' ? '✅' : '❌'} ${short(taskId)}: ${state}\n${note}${url ? `\n${url}` : ''}${prUrl ? `\nPR (draft): ${prUrl}` : ''}`),
  merged: (env, n, sha) => pick(env, `✅ Merged PR #${n} · ${sha}\nℹ️ Not live yet: deploy next.`, `✅ បាន merge PR #${n} (commit ${sha})។ វេបសាយផ្ទាល់មិនទាន់ប្តូរទេ។`),
  planFailed: (env, task, msg) => pick(env, `⚠️ Planning failed\n${msg}\n👉 Check /admin diag, then send again.`, `⚠️ រៀបចំផែនការមិនបាន: ${msg}\nសូមពិនិត្យ /diag ហើយផ្ញើម្តងទៀត។`),
  stepFailed: (env, task, step, msg) => pick(env, `❌ Failed · ${short(task.id)}\n${msg}`, `❌ ${short(task.id)} បរាជ័យ: ${msg}`),
  paused: (env, task, msg, ref) => pick(env, `⏸ Paused\n${msg}\n👉 /resume ${ref} · /cancel ${ref}`, `⏸ បានផ្អាក: ${msg}\n👉 /resume ${ref} · /cancel ${ref}`),
  processingError: (env, msg) => pick(env, `⚠️ Could not process your message (${msg}). Send it again.`, `⚠️ ដំណើរការសារមិនបាន (${msg}) — សូមផ្ញើម្តងទៀត`),

  // Pull request review shown before the merge approval
  prReview: env => pick(env,
    { ready: (n, url) => `🔍 PR #${n} ready\n🔗 ${url}`, files: c => `📄 Files (${c}):`, changes: '✏️ Changes:', more: c => `… +${c} lines (see PR)`, noDiff: 'ℹ️ Open the link to see the changes.', checks: '✅ PHP lint · tests · secret scan' },
    { ready: (n, url) => `🔍 PR #${n} រួចរាល់: ${url}`, files: c => `📄 ឯកសារ (${c}):`, changes: '✏️ ការកែប្រែ:', more: c => `… +${c} បន្ទាត់ (មើលក្នុង PR)`, noDiff: 'ℹ️ សូមបើក link ដើម្បីមើល', checks: '✅ PHP lint · tests · secret scan' }),

  // Plan rendering
  plan: env => pick(env,
    { head: who => `📋 Plan · ${who}`, steps: 'Steps:', risks: '⚠️ Risks:', rights: v => (v ? '⚖️ Rights check needed' : '') },
    { head: who => `📋 ផែនការ (${who}):`, steps: 'ជំហាន:', risks: '⚠️ ហានិភ័យ:', rights: v => (v ? '⚖️ ត្រូវពិនិត្យសិទ្ធិអ្នកនិពន្ធ' : '') }),

  // Books
  requestAlert: (env, r) => `${note(env, 'request')}\n` + pick(env, `📚 #${r.id} ${r.book_title}${r.author ? ` — ${r.author}` : ''}${r.language ? ` (${r.language})` : ''}`, `📚 #${r.id} ${r.book_title}${r.author ? ` — ${r.author}` : ''}`),
  requestButtons: env => ({ find: pick(env, '🔎 Find a legal copy', '🔎 ស្វែងរក'), reject: T.buttons(env).reject }),
  watching: (env, cursor) => pick(env, `👀 Watching book requests (from #${cursor})`, `👀 កំពុងតាមដានសំណើសៀវភៅ (ចាប់ពី #${cursor})`),
  candidates: env => pick(env,
    { head: q => `📚 "${q}" · public domain`, foot: '👉 Tap one to prepare a private draft.', button: i => `📥 Draft ${i}`,
      none: q => `🔒 "${q}": no public-domain copy (likely under copyright).` },
    { head: q => `📚 "${q}" · public domain`, foot: '👉 ចុចដើម្បីរៀបចំ draft (មិនទាន់បង្ហាញ)', button: i => `📥 Draft ${i}`,
      none: q => `🔒 "${q}": រកមិនឃើញក្នុង public domain (ប្រហែលមាន copyright)` }),
  preparing: (env, title, id) => pick(env, `📥 Preparing draft · "${title}"…`, `📥 កំពុងរៀបចំ draft "${title}"…`),
  draftPreview: (env, b) => pick(env,
    [`📖 Draft ready (private)`, `${b.title} — ${b.author}`, `🏷 ${b.genres} · ${b.languages}`, `📦 EPUB ${b.mb} MB${b.cover ? ' + cover' : ''}`, `⚖️ Public domain · Gutenberg #${b.id}`,
     b.dups ? `⚠️ Already on the site (#${b.dups}): publishing will be refused.` : ''].filter(Boolean).join('\n'),
    [`📖 Draft រួចរាល់ (មិនទាន់បង្ហាញ)`, `${b.title} — ${b.author}`, `📦 EPUB ${b.mb} MB${b.cover ? ' + គម្រប' : ''} · ${b.languages}`, `⚖️ Public domain · Gutenberg #${b.id}`,
     b.dups ? `⚠️ មានសៀវភៅនេះរួចហើយ (#${b.dups}) — នឹងមិន publish ទេ` : ''].filter(Boolean).join('\n')),
  published: (env, p, bookId, slug, requestNote) => pick(env, `✅ Published · "${p.title}"\n📖 Book #${bookId}${slug ? ` · /${slug}` : ''}${requestNote}`, `✅ បាន publish "${p.title}" (book #${bookId})${requestNote}`),
  requestDone: (env, id) => pick(env, `\n✔️ Request #${id} done`, ` · សំណើ #${id} រួចរាល់`),
  sourceDown: env => pick(env, '🔧 Project Gutenberg is down. Try later.', '🔧 Project Gutenberg មិនដំណើរការ — សូមសាកពេលក្រោយ'),
  deployHead: (env, sha) => pick(env, `🚀 Deploy · ${sha}`, `🚀 Deploy · ${sha}`),
  deployFiles: (env, n) => pick(env, `📄 Files (${n}):`, `📄 ឯកសារ (${n}):`),
  deployDone: (env, ok, note, url) => [pick(env, ok ? '✅ Deployed to booksharekh.com' : '❌ Deploy failed', ok ? '✅ បាន deploy ទៅ booksharekh.com' : '❌ Deploy បរាជ័យ'), note, url ? `🔗 ${url}` : ''].filter(Boolean).join('\n'),
  deployNothing: env => pick(env, 'ℹ️ Nothing new to deploy', 'ℹ️ មិនមានអ្វីថ្មីសម្រាប់ deploy'),
  noPending: env => pick(env, '📭 No book requests', '📭 គ្មានសំណើសៀវភៅ'),
  requestRejected: (env, id) => pick(env, `❌ Request #${id} rejected`, `❌ សំណើ #${id} បានបដិសេធ`),

  // Top-ups (money): show exactly what will be credited.
  topupAlert: (env, t) => {
    const lines = [note(env, 'topup'), `💰 Top-up #${t.id}`, `👤 ${t.user || '?'}`, `💵 ${t.amount} ${t.currency} · ${String(t.method || '').toUpperCase()}`,
      t.transaction_id ? `🧾 ${t.transaction_id}` : '', t.notes ? `📝 ${t.notes}` : '', t.has_image ? '' : pick(env, '⚠️ No receipt image', '⚠️ គ្មានរូបវិក្កយបត្រ')];
    return [...lines.filter(Boolean), '', pick(env, '👉 Approve and credit?', '👉 បញ្ចូលលុយ?')].join('\n');
  },
  topupButtons: env => T.buttons(env), // same Approve / Reject buttons as everywhere else
  topupApproved: (env, t, balance) => pick(env, `✅ Top-up #${t.id} · +${t.amount} ${t.currency}\n👤 ${t.user} · 💰 ${balance}`,
    `✅ Top-up #${t.id} +${t.amount} ${t.currency} · ${t.user} (សមតុល្យ ${balance})`),
  topupRejected: (env, t) => pick(env, `❌ Top-up #${t.id} rejected · ${t.amount} ${t.currency}\n👤 ${t.user}`, `❌ Top-up #${t.id} ${t.amount} ${t.currency} · ${t.user} បានបដិសេធ`),
  topupProblem: (env, id, msg) => pick(env, `⚠️ Top-up #${id}: ${msg}`, `⚠️ Top-up #${id}: ${msg}`),
  topupUnknown: env => pick(env, '❓ Top-up not found · /finance', 'រកមិនឃើញ។ សូមវាយ /topups'),
  // Users: one short message per check, only when something happened.
  purchaseAlert: (env, lines) => `${note(env, 'purchase')}\n${lines}`,
  userActivity: (env, reg, total) => `${note(env, 'member')}\n${reg}\n\n` + pick(env, `👥 Total: ${total}`, `👥 សរុប ${total} នាក់`),
  usersSummary: (env, total, reg, logins) => pick(env, `👥 Total: ${total}\n🆕 New (24h): ${reg}\n🔑 Logins (24h): ${logins}`,
    `👥 សរុប ${total} នាក់\n🆕 ថ្មី (24h): ${reg}\n🔑 Login (24h): ${logins}`),
  // Marketing promo videos (posting on TikTok / Facebook is done by the owner).
  promoVideo: (env, v, voiced) => `${note(env, 'promo')}\n🎬 ${v.title}${voiced === false ? pick(env, ' (no voice)', ' (គ្មានសំឡេង)') : ''}\n` +
    pick(env, '👇 Caption below (copy it)', '👇 Caption នៅសារបន្ទាប់ (copy យកទៅ post)'),
  promoDone: (env, ok, msg) => (ok ? pick(env, '✅ Video ready · post it on TikTok / Facebook', '✅ វីដេអូរួចរាល់ — post លើ TikTok / Facebook')
    : pick(env, `❌ Video failed: ${msg}`, `❌ បង្កើតវីដេអូមិនបាន: ${msg}`)),
  promoBusy: env => pick(env, '⏳ A video is in progress · one at a time', '⏳ មានវីដេអូមួយកំពុងធ្វើ — ម្តងមួយ។ សូមរង់ចាំ ឬ /cancel'),
  recommend: (env, lines) => [note(env, 'recommend'),
    pick(env, '📈 Popular books the site lacks:', '📈 សៀវភៅពេញនិយម ដែលវេបសាយមិនទាន់មាន:'), ...lines].join('\n'),
  recommendNone: env => pick(env, 'ℹ️ No new book ideas this time', 'ℹ️ គ្មានសៀវភៅថ្មីសម្រាប់ណែនាំលើកនេះ'),
  posterImage: (env, p) => `${note(env, 'poster')}\n🖼 ${p.title}\n` + pick(env, '👇 Caption below (copy it)', '👇 Caption នៅសារបន្ទាប់ (copy យកទៅ post)'),
  posterDone: (env, ok, msg) => (ok ? pick(env, '✅ Poster ready · post it on Facebook / Instagram', '✅ Poster រួចរាល់ — post លើ Facebook / Instagram')
    : pick(env, `❌ Poster failed: ${msg}`, `❌ បង្កើត poster មិនបាន: ${msg}`)),
  posterBusy: env => pick(env, '⏳ A poster is in progress · one at a time', '⏳ មាន poster មួយកំពុងធ្វើ — ម្តងមួយ។ សូមរង់ចាំ ឬ /cancel'),
  posterStarted: env => pick(env, '🖼 Designing the poster…', '🖼 កំពុងសរសេរអត្ថបទ poster…'),
  promoStarted: env => pick(env, '🎬 Writing the video script…', '🎬 កំពុងសរសេរ script វីដេអូ…'),
  // AI chain: an AI at its limit rests; the next one takes over (times shown in Phnom Penh time).
  aiResting: (env, provider, kind, until) => {
    const name = { anthropic: 'Claude', openai: 'Codex', google: 'Gemini' }[provider] || provider;
    const why = { quota: pick(env, 'limit reached', 'ដល់ដែនកំណត់'), auth: pick(env, 'key rejected', 'key មិនត្រឹមត្រូវ'), rate_limit: pick(env, 'busy', 'រវល់'),
      model_not_found: pick(env, 'model not available', 'មិនមាន model'), config: pick(env, 'not set up', 'មិនទាន់កំណត់') }[kind] || kind;
    return pick(env, `🔄 ${name}: ${why}\n↪️ Other AIs continue · back at ${khTime(until)}`,
      `🔄 ${name} ${why}\n↪️ AI ផ្សេងធ្វើបន្ត · ត្រឡប់មកវិញ ${khTime(until)}`);
  },
  pausedAuto: (env, until, ref) => pick(env, `⏸ All AIs at their limits\n▶️ Continues at ${khTime(until)} · ${ref}`,
    `⏸ AI ទាំងអស់ដល់ដែនកំណត់ — នឹងបន្តដោយស្វ័យប្រវត្តិម៉ោង ${khTime(until)}`),
  // Command replies (technical words, commands and IDs stay English).
  rememberUsage: env => pick(env, 'Use: /remember video.language=Khmer', 'ប្រើ: /remember video.language=Khmer'),
  notSecret: env => pick(env, 'Not saved: this looks like a password, key or token. Saved settings are sent to the AI with every plan, so never store credentials here.',
    '⛔ មិនបានរក្សាទុក: មើលទៅដូចជា password, key ឬ token។ អ្វីដែល AI ចាំ ត្រូវផ្ញើទៅ AI រាល់ពេល — កុំដាក់ពាក្យសម្ងាត់នៅទីនេះ។'),
  saved: (env, k, v) => pick(env, `💾 Saved: ${k} = ${v}\nℹ️ Sent to the AI with every plan; on the free Gemini tier Google may use it to improve its products.`,
    `💾 បានរក្សាទុក: ${k} = ${v}\nℹ️ AI ប្រើវារាល់ពេលរៀបចំផែនការ។ លើ Gemini ឥតគិតថ្លៃ Google អាចប្រើវាដើម្បីកែលម្អផលិតផលរបស់ខ្លួន។`),
  noMemory: env => pick(env, '📭 Nothing saved.', '📭 មិនទាន់មានអ្វីរក្សាទុក។'),
  noTasks: env => pick(env, '📭 No tasks yet.', '📭 មិនទាន់មានការងារ។'),
  taskUsage: env => pick(env, 'Use: /admin <what you want>', 'ប្រើ: /admin <អ្វីដែលអ្នកចង់បាន>'),
  taskRefUsage: (env, usage) => pick(env, `Use: ${usage}`, `ប្រើ: ${usage}`),
  taskNotFound: env => pick(env, '❓ Task not found (or the id matches several tasks).', '❓ រកមិនឃើញ task (ឬ id ត្រូវនឹង task ច្រើន)។'),
  resumed: (env, id) => pick(env, `▶️ Resumed · ${id}\nℹ️ Pauses again if the AI limit is still reached.`, `▶️ បានបន្ត · ${id}\nℹ️ បើ AI នៅតែដល់ដែនកំណត់ វានឹងផ្អាកម្តងទៀត។`),
  cannotResume: (env, status) => pick(env, `⚠️ Cannot resume (${status})`, `⚠️ បន្តមិនបាន (${status})`),
  developUsage: env => pick(env, 'Use: /developer <change>, e.g. /developer change the homepage heading', 'ប្រើ: /developer <អ្វីដែលត្រូវកែ> ឧ. /developer ប្តូរចំណងជើងទំព័រដើម'),
  repoMissing: env => pick(env, '⚠️ Website repository not connected (WEBSITE_REPO is not set).', '⚠️ មិនទាន់ភ្ជាប់ website repository (WEBSITE_REPO មិនទាន់កំណត់)។'),
  booksUsage: env => pick(env, 'Use: /books search <title>', 'ប្រើ: /books search <ចំណងជើង>'),
  researchUsage: env => pick(env, 'Use: /marketing find <title>', 'ប្រើ: /marketing រក <ចំណងជើង>'),
  importNoApi: env => pick(env, '⚠️ Website API not connected: drafts cannot be created yet.', '⚠️ មិនទាន់ភ្ជាប់ Website API — មិនទាន់អាចបង្កើត draft បាន។'),
  importRunning: (env, id) => pick(env, `⏳ Already importing this book · ${id}`, `⏳ សៀវភៅនេះកំពុងនាំចូលហើយ · ${id}`),
  importNotPd: env => pick(env, '🔒 Not public domain with an EPUB on Project Gutenberg: cannot import.', '🔒 មិនមែន public domain ឬគ្មាន EPUB លើ Project Gutenberg — នាំចូលមិនបាន។'),
  importFailed: (env, reason) => pick(env, `❌ Import could not start (${reason})`, `❌ មិនអាចចាប់ផ្តើមនាំចូលបាន (${reason})`),
  previewHead: (env, n, names) => pick(env, `🧪 Preview: ${n} sample alerts (made-up data, buttons do nothing)\n\n${names}`, `🧪 គំរូ alert ${n} (ទិន្នន័យសាកល្បង ប៊ូតុងមិនដំណើរការ)\n\n${names}`),
  forgetUsage: env => pick(env, 'Use: /forget <name> · names: /memory', 'ប្រើ: /forget <ឈ្មោះ> · មើល /memory'),
  forgetMissing: (env, key) => pick(env, `❓ "${key}" not saved · /memory`, `❓ គ្មាន "${key}" · /memory`),
  forgotten: (env, key) => pick(env, `🗑 Deleted: ${key}`, `🗑 បានលុប: ${key}`),
  noTopups: env => pick(env, '📭 No pending top-ups', '📭 គ្មាន topup រង់ចាំ'),
  booksHeading: (env, n) => pick(env, `📚 Latest ${n} books:`, `📚 សៀវភៅថ្មីៗ ${n}:`),
  searchHeading: (env, q) => pick(env, `🔎 "${q}":`, `🔎 "${q}":`),
  noBooks: env => pick(env, '(no books found)', '(រកមិនឃើញ)'),

  // /website health
  health: env => pick(env,
    { head: s => `🌐 Website: ${s}`, home: (st, ms, pw) => `Homepage HTTP ${st} · ${ms} ms${pw ? ` · ${pw}` : ''}`, down: d => `Homepage down: ${d}`,
      debugOn: 'Debug mode ON in production! Set APP_DEBUG=false.',
      ignition: 'Ignition debug page reachable. Set APP_DEBUG=false.', debugOff: 'Debug off',
      exposed: p => `${p} is public!`, safe: list => `${list} private`,
      apiOk: (app, lv, php) => `✅ API: ${app} · Laravel ${lv} · PHP ${php}`, apiErr: m => `❌ API: ${m}`, apiNone: '▫️ API not connected' },
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
  create_poster: 'បង្កើត poster?',
};
