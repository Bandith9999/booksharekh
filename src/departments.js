// The bot as a company: five departments, each with its commands and AI staff.
// /help (= /menu, /start) shows everything grouped; /admin /dev /finance /hr /marketing open one
// department with tap buttons. Buttons run only commands that need no extra text.
import { reply, tg } from './telegram.js';
import { isKhmer } from './i18n.js';

const k = (env, en, km) => (isKhmer(env) ? km : en);

// cmd, usage (args), English, Khmer. `tap` = can run from a button (no text needed).
export const DEPARTMENTS = [
  { key: 'admin', icon: '👑', name: 'Administrator', en: 'Runs the company: tasks, AI team, settings', km: 'គ្រប់គ្រងការងារ ក្រុម AI និង settings',
    agents: ['manager', 'qa_reviewer'],
    commands: [
      ['status', '', 'Tasks (waiting first)', 'ការងារ (រង់ចាំមុន)', true],
      ['task', '<request>', 'New task for the AI team', 'ការងារថ្មីឲ្យក្រុម AI'],
      ['taskstatus', '<id>', 'Details of one task', 'ព័ត៌មានការងារមួយ'],
      ['cancel', '<id>', 'Cancel a task', 'បោះបង់ការងារ'],
      ['resume', '<id>', 'Continue a paused task', 'បន្តការងារដែលបានផ្អាក'],
      ['agents', '', 'AI staff by department', 'បុគ្គលិក AI តាមផ្នែក', true],
      ['diag', '', 'System check', 'ពិនិត្យប្រព័ន្ធ', true],
      ['memory', '', 'Saved settings', 'Settings ដែលបានរក្សា', true],
      ['remember', 'key=value', 'Save a setting', 'រក្សា setting'],
      ['preview', '', 'Sample of every alert', 'គំរូ alert ទាំងអស់', true],
    ] },
  { key: 'dev', icon: '💻', name: 'Developer', en: 'Website code: change, check, deploy', km: 'កូដវេបសាយ: កែ ពិនិត្យ deploy',
    agents: ['laravel_developer'],
    commands: [
      ['develop', '<change>', 'AI changes the website code (PR)', 'AI កែកូដវេបសាយ (PR)'],
      ['website', '', 'Website health check', 'ពិនិត្យវេបសាយ', true],
      ['deploy', '', 'Put merged code live', 'ដាក់កូដដែល merge ឲ្យដំណើរការ', true],
    ] },
  { key: 'finance', icon: '💰', name: 'Finance', en: 'Money: top-ups. Only you approve; no AI decides money.', km: 'ប្រាក់: top-up។ មានតែអ្នកទេដែលយល់ព្រម — AI មិនសម្រេចរឿងប្រាក់ទេ។',
    agents: [],
    commands: [
      ['topups', '', 'Top-ups waiting for approval', 'Top-up រង់ចាំយល់ព្រម', true],
    ] },
  { key: 'hr', icon: '👥', name: 'HR', en: 'Members and guests', km: 'សមាជិក និងភ្ញៀវ',
    agents: [],
    commands: [
      ['users', '', 'Members: total, new, logins', 'សមាជិក: សរុប ថ្មី login', true],
    ] },
  { key: 'marketing', icon: '📣', name: 'Marketing', en: 'Books and content for visitors', km: 'សៀវភៅ និង content សម្រាប់អ្នកទស្សនា',
    agents: ['book_researcher', 'book_editor', 'content_creator', 'video_creator'],
    commands: [
      ['requests', '', 'Book requests from visitors', 'សំណើសៀវភៅពីអ្នកទស្សនា', true],
      ['books', '', 'Latest books on the site', 'សៀវភៅថ្មីៗលើវេបសាយ', true],
      ['research', '<title>', 'Find a public-domain book', 'រកសៀវភៅ public domain'],
    ] },
];

export const DEPT_BY_KEY = Object.fromEntries(DEPARTMENTS.map(d => [d.key, d]));
export const TAP_COMMANDS = new Set(DEPARTMENTS.flatMap(d => d.commands.filter(c => c[4]).map(c => c[0])));
export const departmentOf = agentName => DEPARTMENTS.find(d => d.agents.includes(agentName));

const line = (env, [cmd, args, en, km]) => `/${cmd}${args ? ` ${args}` : ''} — ${k(env, en, km)}`;
const deptButtons = () => ({ inline_keyboard: [
  DEPARTMENTS.slice(0, 3).map(d => ({ text: `${d.icon} ${d.name}`, callback_data: `dp:${d.key}` })),
  DEPARTMENTS.slice(3).map(d => ({ text: `${d.icon} ${d.name}`, callback_data: `dp:${d.key}` })),
] });

// /help: every command, grouped by department, plus department buttons.
export function helpText(env) {
  const parts = [k(env, '🏢 BookShareKH — AI company', '🏢 BookShareKH — ក្រុមហ៊ុន AI')];
  for (const d of DEPARTMENTS) parts.push(`\n${d.icon} ${d.name} — /${d.key}\n${d.commands.map(c => line(env, c)).join('\n')}`);
  parts.push(k(env, '\nEvery change waits for your approval.', '\nរាល់ការផ្លាស់ប្តូរ ត្រូវរង់ចាំការយល់ព្រមពីអ្នក។'));
  return parts.join('\n');
}

// /admin, /dev, ...: one department card with its AI staff and tap buttons.
export function departmentCard(env, key, titles = {}) {
  const d = DEPT_BY_KEY[key];
  const staff = d.agents.length ? d.agents.map(a => titles[a] || a).join(', ') : k(env, 'none (rule-based, you decide)', 'គ្មាន (អ្នកជាអ្នកសម្រេច)');
  const text = [`${d.icon} ${d.name}`, k(env, d.en, d.km), `🤖 AI: ${staff}`, '', ...d.commands.map(c => line(env, c))].join('\n');
  const taps = d.commands.filter(c => c[4]).map(([cmd, , en, km]) => ({ text: `/${cmd}`, callback_data: `run:${cmd}` }));
  const rows = [];
  for (let i = 0; i < taps.length; i += 3) rows.push(taps.slice(i, i + 3));
  rows.push([{ text: k(env, '⬅️ All departments', '⬅️ ផ្នែកទាំងអស់'), callback_data: 'dp:all' }]);
  return { text, reply_markup: { inline_keyboard: rows } };
}

export const sendHelp = (env, chat) => reply(env, chat, helpText(env), { reply_markup: deptButtons() });
export const sendDepartment = (env, chat, key, titles) => {
  const card = departmentCard(env, key, titles);
  return reply(env, chat, card.text, { reply_markup: card.reply_markup });
};

// Telegram's "/" menu: department commands first, then the rest. Shown only in the owner's chat.
const MENU_VERSION = '2';
export async function registerMenu(env) {
  const done = await env.DB.prepare("SELECT value FROM settings WHERE key='bot_menu_version'").first().catch(() => null);
  if (done?.value === `${MENU_VERSION}:${env.BOT_LANGUAGE || 'en'}`) return false;
  const commands = [
    { command: 'help', description: k(env, 'All commands by department', 'Command ទាំងអស់តាមផ្នែក') },
    ...DEPARTMENTS.map(d => ({ command: d.key, description: `${d.icon} ${d.name}` })),
    ...DEPARTMENTS.flatMap(d => d.commands.map(([cmd, , en, km]) => ({ command: cmd, description: `${d.icon} ${k(env, en, km)}`.slice(0, 256) }))),
  ];
  await tg(env, 'setMyCommands', { commands, scope: { type: 'chat', chat_id: Number(env.OWNER_TELEGRAM_ID) } });
  await env.DB.prepare(`INSERT INTO settings (key,value,updated_at) VALUES ('bot_menu_version',?,CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`).bind(`${MENU_VERSION}:${env.BOT_LANGUAGE || 'en'}`).run();
  return true;
}
