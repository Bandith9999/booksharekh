// The bot as a company: five departments. Owner request: talk to a department in plain words instead of
// remembering many commands, e.g.
//   /marketing poster about 5 parenting books for parents      /developer change the homepage heading
// routeRequest() turns the words into the department's job (a keyword router: instant, no AI quota).
// When the words fit more than one job, the bot asks with buttons. A department command without words
// opens its card with tap buttons. The old commands (/poster, /develop, …) still work but are not in
// the "/" menu any more.
import { reply, tg } from './telegram.js';
import { isKhmer } from './i18n.js';

const k = (env, en, km) => (isKhmer(env) ? km : en);

// commands: cmd, usage (args), English, Khmer, tap (= can run from a button, no text needed).
// examples: what the owner can type after the department command.
export const DEPARTMENTS = [
  { key: 'admin', icon: '👑', name: 'Administrator', en: 'Runs the company: tasks, AI team, settings', km: 'គ្រប់គ្រងការងារ ក្រុម AI និង settings',
    agents: ['manager', 'qa_reviewer'],
    examples: [['status', 'status'], ['cancel BSK-1a2b', 'cancel BSK-1a2b'], ['remember audience=parents in Phnom Penh', 'remember audience=ឪពុកម្តាយ'], ['plan a reading challenge for June', 'រៀបចំកម្មវិធីអានសៀវភៅខែមិថុនា']],
    commands: [
      ['status', '', 'Tasks (waiting first)', 'ការងារ (រង់ចាំមុន)', true],
      ['task', '<request>', 'New task for the AI team', 'ការងារថ្មីឲ្យក្រុម AI'],
      ['taskstatus', '<id>', 'Details of one task', 'ព័ត៌មានការងារមួយ'],
      ['cancel', '<id>', 'Cancel a task', 'បោះបង់ការងារ'],
      ['resume', '<id>', 'Continue a paused task', 'បន្តការងារដែលបានផ្អាក'],
      ['agents', '', 'AI staff by department', 'បុគ្គលិក AI តាមផ្នែក', true],
      ['diag', '', 'System check', 'ពិនិត្យប្រព័ន្ធ', true],
      ['memory', '', 'What the AI remembers', 'អ្វីដែល AI ចាំ', true],
      ['remember', 'name=text', 'Tell the AI to remember', 'ឲ្យ AI ចាំ'],
      ['forget', '<name>', 'Delete a saved note', 'លុបអ្វីដែល AI ចាំ'],
      ['preview', '', 'Sample of every alert', 'គំរូ alert ទាំងអស់', true],
    ] },
  { key: 'developer', icon: '💻', name: 'Developer', en: 'Website code: change, check, deploy', km: 'កូដវេបសាយ: កែ ពិនិត្យ deploy',
    agents: ['laravel_developer'],
    examples: [['change the homepage heading to "Welcome"', 'ប្តូរចំណងជើងទំព័រដើម ទៅ "សូមស្វាគមន៍"'], ['check', 'check'], ['deploy', 'deploy']],
    commands: [
      ['develop', '<change>', 'AI changes the website code (PR)', 'AI កែកូដវេបសាយ (PR)'],
      ['website', '', 'Website health check', 'ពិនិត្យវេបសាយ', true],
      ['deploy', '', 'Put merged code live', 'ដាក់កូដដែល merge ឲ្យដំណើរការ', true],
    ] },
  { key: 'finance', icon: '💰', name: 'Finance', en: 'Money: top-ups. Only you approve; no AI decides money.', km: 'ប្រាក់: top-up។ មានតែអ្នកទេដែលយល់ព្រម — AI មិនសម្រេចរឿងប្រាក់ទេ។',
    agents: [],
    examples: [['top-ups', 'top-ups']],
    commands: [
      ['topups', '', 'Top-ups waiting for approval', 'Top-up រង់ចាំយល់ព្រម', true],
    ] },
  { key: 'hr', icon: '👥', name: 'HR', en: 'Members and guests', km: 'សមាជិក និងភ្ញៀវ',
    agents: [],
    examples: [['members', 'members']],
    commands: [
      ['users', '', 'Members: total, new, logins', 'សមាជិក: សរុប ថ្មី login', true],
    ] },
  { key: 'marketing', icon: '📣', name: 'Marketing', en: 'Books and content for visitors', km: 'សៀវភៅ និង content សម្រាប់អ្នកទស្សនា',
    agents: ['book_researcher', 'book_editor', 'content_creator', 'video_creator'],
    examples: [['poster about 5 parenting books for parents', 'poster អំពីសៀវភៅ ៥ ក្បាល សម្រាប់ឪពុកម្តាយ'], ['video about reading before bed', 'វីដេអូ អំពីការអានមុនគេង'],
      ['find Pride and Prejudice', 'រក Pride and Prejudice'], ['requests', 'requests'], ['ideas', 'ideas']],
    commands: [
      ['poster', '[topic]', 'TikTok photo poster (9:16), on your topic or a website theme', 'Poster TikTok (9:16) តាមប្រធានបទរបស់អ្នក', true],
      ['promo', '[topic]', 'Video with Khmer voice + caption', 'វីដេអូ មានសំឡេង + caption ខ្មែរ', true],
      ['requests', '', 'Book requests from visitors', 'សំណើសៀវភៅពីអ្នកទស្សនា', true],
      ['books', '', 'Latest books on the site', 'សៀវភៅថ្មីៗលើវេបសាយ', true],
      ['research', '<title>', 'Find a public-domain book', 'រកសៀវភៅ public domain'],
      ['recommend', '', 'Popular books the site lacks (auto every 3 days)', 'សៀវភៅពេញនិយមដែលវេបសាយមិនទាន់មាន', true],
    ] },
];

// Old names that still open a department.
export const DEPT_ALIAS = { dev: 'developer' };
export const DEPT_BY_KEY = Object.fromEntries(DEPARTMENTS.map(d => [d.key, d]));
export const deptKey = cmd => (DEPT_BY_KEY[cmd] ? cmd : DEPT_ALIAS[cmd] || null);
export const TAP_COMMANDS = new Set(DEPARTMENTS.flatMap(d => d.commands.filter(c => c[4]).map(c => c[0])));
export const departmentOf = agentName => DEPARTMENTS.find(d => d.agents.includes(agentName));

// ---------- plain words → the department's job ----------
// Returns { cmd, args } to run, or { ask: [cmd, …], text } when the words fit several jobs.
const TASK_ID = /\bBSK-[a-f0-9-]{4,36}…?/i;
const words = t => t.split(/\s+/).filter(Boolean).length;
// Remove the leading "make/design a poster about" part, keep the topic.
const topicOf = (text, noun) => text
  .replace(new RegExp(`^\\s*(please\\s+)?((make|design|designe|create|do|write|generate)\\s+)?(an?\\s+|one\\s+|new\\s+)*(${noun})\\s*(about|on|for|of|with|:|-)?\\s*`, 'i'), '')
  .replace(/^\s*(បង្កើត|ធ្វើ|រចនា)?\s*/, '')
  .trim();

const POSTER = /\b(posters?|flyers?|banners?|photo ?posts?|images?)\b|ប៉ូស្ទ័រ|ផូស្ទ័រ|រូបភាព/i;
const VIDEO = /\b(videos?|promos?|clips?|reels?)\b|វីដេអូ/i;

export function routeRequest(dept, text) {
  const t = String(text || '').trim();
  const low = t.toLowerCase();
  if (!t) return null;
  switch (dept) {
    case 'developer':
      if (/^(check|health|status|is the (web)?site (up|ok|working))\b|^ពិនិត្យ/.test(low) && words(t) <= 5) return { cmd: 'website', args: '' };
      if (/^(deploy|go live|publish)\b/.test(low) && words(t) <= 4) return { cmd: 'deploy', args: '' };
      return { cmd: 'develop', args: t };
    case 'marketing': {
      const p = low.search(POSTER), v = low.search(VIDEO);
      if (p >= 0 && (v < 0 || p <= v)) return { cmd: 'poster', args: topicOf(t, 'posters?|flyers?|banners?|photo ?posts?|images?|ប៉ូស្ទ័រ|ផូស្ទ័រ|poster') };
      if (v >= 0) return { cmd: 'promo', args: topicOf(t, 'videos?|promos?|promo videos?|clips?|reels?|វីដេអូ') };
      if (/^(book )?requests?\b|^សំណើ/.test(low)) return { cmd: 'requests', args: '' };
      if (/^(ideas|recommend(ations)?|what books (should|to) (we )?add|missing books)\b|^ណែនាំ/.test(low)) return { cmd: 'recommend', args: '' };
      if (/^(latest|new) books?\b|^books$/.test(low)) return { cmd: 'books', args: '' };
      const find = /^(find|research|search( for)?|import|រក)\s+(.+)$/i.exec(t);
      if (find) return { cmd: 'research', args: find[3].trim() };
      return { ask: ['poster', 'promo', 'research'], text: t };
    }
    case 'admin': {
      const id = TASK_ID.exec(t)?.[0];
      if (id && /^(cancel|stop)\b|^បោះបង់/.test(low)) return { cmd: 'cancel', args: id };
      if (id && /^(resume|continue)\b|^បន្ត/.test(low)) return { cmd: 'resume', args: id };
      if (id) return { cmd: 'taskstatus', args: id };
      if (/^(status|tasks|list|what('s| is) (waiting|running))\b|^ការងារ/.test(low) && words(t) <= 4) return { cmd: 'status', args: '' };
      if (/^(diag|diagnostics|check( the)? system|system check)\b/.test(low)) return { cmd: 'diag', args: '' };
      if (/^(agents|staff|team|ai team)\b/.test(low) && words(t) <= 3) return { cmd: 'agents', args: '' };
      if (/^(memory|what do you remember)\b/.test(low)) return { cmd: 'memory', args: '' };
      if (/^remember\s+\S/.test(low)) return { cmd: 'remember', args: t.replace(/^remember\s+/i, '') };
      if (/^forget\s+\S+$/.test(low)) return { cmd: 'forget', args: t.replace(/^forget\s+/i, '') };
      if (/^preview\b/.test(low)) return { cmd: 'preview', args: '' };
      return { cmd: 'task', args: t };
    }
    case 'finance': return { cmd: 'topups', args: '' };
    case 'hr': return { cmd: 'users', args: '' };
    default: return null;
  }
}

// Buttons for "which one did you mean?" (the text waits in settings under a short id).
const ASK_LABEL = { poster: ['🖼 Poster', '🖼 Poster'], promo: ['🎬 Video', '🎬 វីដេអូ'], research: ['🔎 Find a book', '🔎 រកសៀវភៅ'] };
export const ASKABLE = new Set(Object.keys(ASK_LABEL));
export async function askWhich(env, chat, options, text) {
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  await env.DB.prepare('INSERT INTO settings (key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)').bind(`ask:${id}`, text).run();
  const row = options.filter(o => ASKABLE.has(o)).map(o => ({ text: k(env, ...ASK_LABEL[o]), callback_data: `as:${o}:${id}` }));
  return reply(env, chat, k(env, `What should Marketing make from:\n“${text}”?`, `ចង់ឲ្យ Marketing ធ្វើអ្វី សម្រាប់:\n“${text}”?`), { reply_markup: { inline_keyboard: [row] } });
}
// The tapped choice: the waiting text, read once.
export async function takeAsked(env, id) {
  const key = `ask:${id}`;
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first();
  if (!row) return null;
  await env.DB.prepare('DELETE FROM settings WHERE key=?').bind(key).run();
  return row.value;
}

// ---------- help, cards, menu ----------
const exampleLines = (env, d) => d.examples.map(([en, km]) => `/${d.key} ${k(env, en, km)}`).join('\n');
const deptButtons = () => ({ inline_keyboard: [
  DEPARTMENTS.slice(0, 3).map(d => ({ text: `${d.icon} ${d.name}`, callback_data: `dp:${d.key}` })),
  DEPARTMENTS.slice(3).map(d => ({ text: `${d.icon} ${d.name}`, callback_data: `dp:${d.key}` })),
] });

// /help: the five departments with examples of what to type, plus department buttons.
export function helpText(env) {
  const parts = [k(env, '🏢 BookShareKH — AI company\nTell a department what you want, in your own words:', '🏢 BookShareKH — ក្រុមហ៊ុន AI\nប្រាប់ផ្នែកណាមួយ នូវអ្វីដែលអ្នកចង់បាន:')];
  for (const d of DEPARTMENTS) parts.push(`\n${d.icon} ${d.name} — /${d.key}\n${k(env, d.en, d.km)}\n${exampleLines(env, d)}`);
  parts.push(k(env, '\nA department alone (e.g. /marketing) shows its buttons. Every change waits for your approval.',
    '\nវាយតែឈ្មោះផ្នែក (ឧ. /marketing) ដើម្បីមើលប៊ូតុង។ រាល់ការផ្លាស់ប្តូរ ត្រូវរង់ចាំការយល់ព្រមពីអ្នក។'));
  return parts.join('\n');
}

// /admin, /developer, …: one department card with its AI staff, examples and tap buttons.
export function departmentCard(env, key, titles = {}) {
  const d = DEPT_BY_KEY[key];
  const staff = d.agents.length ? d.agents.map(a => titles[a] || a).join(', ') : k(env, 'none (rule-based, you decide)', 'គ្មាន (អ្នកជាអ្នកសម្រេច)');
  const text = [`${d.icon} ${d.name}`, k(env, d.en, d.km), `🤖 AI: ${staff}`, '', k(env, 'Type, for example:', 'វាយ ឧទាហរណ៍:'), exampleLines(env, d)].join('\n');
  const taps = d.commands.filter(c => c[4]).map(([cmd, , en, km]) => ({ text: k(env, en, km).split(/[,(:]/)[0].trim().slice(0, 30), callback_data: `run:${cmd}` }));
  const rows = [];
  for (let i = 0; i < taps.length; i += 2) rows.push(taps.slice(i, i + 2));
  rows.push([{ text: k(env, '⬅️ All departments', '⬅️ ផ្នែកទាំងអស់'), callback_data: 'dp:all' }]);
  return { text, reply_markup: { inline_keyboard: rows } };
}

export const sendHelp = (env, chat) => reply(env, chat, helpText(env), { reply_markup: deptButtons() });
export const sendDepartment = (env, chat, key, titles) => {
  const card = departmentCard(env, key, titles);
  return reply(env, chat, card.text, { reply_markup: card.reply_markup });
};

// Telegram's "/" menu: only help and the five departments. Shown only in the owner's chat.
const MENU_VERSION = '8';
export async function registerMenu(env) {
  const done = await env.DB.prepare("SELECT value FROM settings WHERE key='bot_menu_version'").first().catch(() => null);
  if (done?.value === `${MENU_VERSION}:${env.BOT_LANGUAGE || 'en'}`) return false;
  const commands = [
    { command: 'help', description: k(env, 'How to use the departments', 'របៀបប្រើផ្នែកនីមួយៗ') },
    ...DEPARTMENTS.map(d => ({ command: d.key, description: `${d.icon} ${d.name}: ${k(env, d.en, d.km)}`.slice(0, 256) })),
  ];
  await tg(env, 'setMyCommands', { commands, scope: { type: 'chat', chat_id: Number(env.OWNER_TELEGRAM_ID) } });
  await env.DB.prepare(`INSERT INTO settings (key,value,updated_at) VALUES ('bot_menu_version',?,CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`).bind(`${MENU_VERSION}:${env.BOT_LANGUAGE || 'en'}`).run();
  return true;
}
