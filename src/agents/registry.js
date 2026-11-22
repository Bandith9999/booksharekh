// Agent registry: who each agent is, what it may touch, and which executable actions exist.
// Provider/model come from tiers (wrangler vars) and can be overridden per agent in the D1 `agents` table.
// The AI never adds actions or tools: only what is declared here can run.
import { TIERS } from '../ai/model-router.js';
import { planAction } from './manager.js';
import { PROMPTS } from './prompts.js';
import { AGENT_NAMES, PLAN_SCHEMA, QA_SCHEMA, RESEARCH_SCHEMA } from './schemas.js';

// Tool catalog. A tool is usable only if an agent lists it and an action names it.
export const TOOLS = {
  github_demo_workflow: { description: 'Dispatch the approved demo GitHub Actions job (report or sample video)', implemented: true },
  open_library_search: { description: 'Search Open Library metadata', implemented: false, phase: 3 },
  google_books_search: { description: 'Search Google Books metadata', implemented: false, phase: 3 },
  epub_validate: { description: 'Run EPUBCheck / ebooklib checks in GitHub Actions', implemented: false, phase: 5 },
  pdf_inspect: { description: 'Inspect PDF structure with pypdf / PyMuPDF', implemented: false, phase: 5 },
  ffmpeg_render: { description: 'Render vertical video with FFmpeg in GitHub Actions', implemented: false, phase: 5 },
  github_pull_request: { description: 'Run the Laravel Developer job on the private website repo: branch, edit, test, open a pull request', implemented: true },
};

// Demo GitHub job, approved per task. The Phase 1 workflow runs it.
const demoJob = (label) => ({
  kind: 'github_job', tool: 'github_demo_workflow', requiresApproval: true, approvalAction: 'dispatch_github_job',
  description: `Run the GitHub Actions demo job (${label}). Nothing is published.`,
});

// Which demo job step follows the plan, by task type.
export const DEMO_JOB_STEP = {
  video_demo: { agent: 'video_creator', action: 'demo_video_job' },
  report: { agent: 'book_researcher', action: 'demo_report_job' },
  website_code_change: { agent: 'laravel_developer', action: 'code_change_job' },
};

const LIST = [
  {
    name: 'manager', title: 'BookShareKH Manager', tier: 'default',
    description: 'Understands requests, plans, routes work to specialists, asks for approvals and reports results.',
    allowedTools: [], limitations: ['Plans only; cannot execute, publish or approve anything.'],
    maxAttempts: 3, allowFallback: true, maxOutputTokens: 3000, outputSchema: PLAN_SCHEMA,
    actions: { plan: planAction },
  },
  {
    name: 'book_researcher', title: 'Book Researcher', tier: 'fast', phase: 3,
    description: 'Finds bibliographic metadata, compares editions, records sources and rights evidence.',
    allowedTools: ['open_library_search', 'google_books_search', 'github_demo_workflow'],
    limitations: ['Rights default to requires_verification.', 'Never treats downloadable as redistributable.'],
    maxAttempts: 3, allowFallback: true, maxOutputTokens: 2000, outputSchema: RESEARCH_SCHEMA,
    actions: { demo_report_job: demoJob('text report') },
  },
  {
    name: 'book_editor', title: 'EPUB/PDF Editor', tier: 'review', phase: 5, confidential: true,
    description: 'Validates and repairs authorized EPUB/PDF files and reports quality issues.',
    allowedTools: ['epub_validate', 'pdf_inspect'],
    limitations: ['Only files with verified rights.', 'Never removes notices, attribution or DRM.'],
    maxAttempts: 2, allowFallback: false, maxOutputTokens: 4000, outputSchema: null, actions: {},
  },
  {
    name: 'content_creator', title: 'Content Creator', tier: 'fast', phase: 4,
    description: 'Writes Khmer and English descriptions, SEO metadata, captions and scripts as drafts.',
    allowedTools: [], limitations: ['Drafts only; publication needs owner approval.', 'No invented quotes or facts.'],
    maxAttempts: 3, allowFallback: true, maxOutputTokens: 3000, outputSchema: null, actions: {},
  },
  {
    name: 'video_creator', title: 'Video Creator', tier: 'fast', phase: 5,
    description: 'Storyboards, subtitles and vertical 9:16 previews from licensed assets.',
    allowedTools: ['ffmpeg_render', 'github_demo_workflow'],
    limitations: ['Never posts to TikTok, Facebook or other platforms without approval.'],
    maxAttempts: 2, allowFallback: true, maxOutputTokens: 3000, outputSchema: null,
    actions: { demo_video_job: demoJob('8-second sample-card video') },
  },
  {
    name: 'laravel_developer', title: 'Laravel Developer', tier: 'code', phase: 6, confidential: true,
    description: 'Prepares Laravel changes, migrations and tests as pull requests.',
    allowedTools: ['github_pull_request'],
    limitations: ['Never deploys or touches the production database.', 'Human review required.'],
    maxAttempts: 2, allowFallback: false, maxOutputTokens: 8000, outputSchema: null,
    // Code is edited by Claude Code inside GitHub Actions on the private website repo (Claude subscription),
    // never sent to the Worker's free-tier model. The job opens a pull request; it never deploys.
    actions: { code_change_job: {
      kind: 'github_job', tool: 'github_pull_request', workflow: 'website_dev', requiresApproval: true, approvalAction: 'dispatch_code_change',
      description: 'Run the Laravel Developer on the private website repo: new branch, code change, tests, pull request. Nothing is deployed.',
    } },
  },
  {
    name: 'qa_reviewer', title: 'QA Reviewer', tier: 'review', phase: 3,
    description: 'Checks research, content, files, videos, code and rights before owner review.',
    allowedTools: [], limitations: ['QA approval never replaces owner approval.'],
    maxAttempts: 3, allowFallback: false, maxOutputTokens: 2000, outputSchema: QA_SCHEMA, actions: {},
  },
].map(a => ({ ...a, prompt: PROMPTS[a.name] }));

export const AGENTS = Object.fromEntries(LIST.map(a => [a.name, a]));

export function getAgent(name) {
  const a = AGENTS[name];
  if (!a) throw new Error(`Unknown agent "${name}"`);
  return a;
}
export function getAction(agent, action) {
  const a = getAgent(agent).actions[action];
  if (!a) throw new Error(`Agent ${agent} has no action "${action}"`);
  return a;
}
export const isImplemented = agent => Object.keys(getAgent(agent).actions).length > 0;

// Static consistency checks; run at load and in tests.
export function validateRegistry() {
  const errors = [];
  const names = LIST.map(a => a.name);
  if (names.join() !== AGENT_NAMES.join()) errors.push('registry names differ from AGENT_NAMES');
  for (const a of LIST) {
    if (!TIERS.includes(a.tier)) errors.push(`${a.name}: unknown tier ${a.tier}`);
    if (!a.prompt?.system || !a.prompt?.version) errors.push(`${a.name}: missing system prompt`);
    if (!(a.maxAttempts >= 1 && a.maxAttempts <= 5)) errors.push(`${a.name}: maxAttempts out of range`);
    for (const t of a.allowedTools) if (!TOOLS[t]) errors.push(`${a.name}: unknown tool ${t}`);
    for (const [n, act] of Object.entries(a.actions)) {
      if (!['ai', 'github_job'].includes(act.kind)) errors.push(`${a.name}.${n}: unknown action kind ${act.kind}`);
      if (act.tool && !a.allowedTools.includes(act.tool)) errors.push(`${a.name}.${n}: tool ${act.tool} not in allowedTools`);
      if (act.tool && !TOOLS[act.tool]?.implemented) errors.push(`${a.name}.${n}: tool ${act.tool} not implemented`);
      if (act.kind === 'github_job' && !act.requiresApproval) errors.push(`${a.name}.${n}: external job without approval`);
    }
  }
  for (const s of Object.values(DEMO_JOB_STEP)) if (!AGENTS[s.agent]?.actions[s.action]) errors.push(`demo step ${s.agent}.${s.action} missing`);
  return errors;
}

const problems = validateRegistry();
if (problems.length) throw new Error(`Agent registry invalid: ${problems.join('; ')}`);
