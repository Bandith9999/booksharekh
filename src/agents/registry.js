// Agent registry: who each agent is, what it may touch, and which executable actions exist.
// Provider/model come from tiers (wrangler vars) and can be overridden per agent in the D1 `agents` table.
// The AI never adds actions or tools: only what is declared here can run.
import { TIERS } from '../ai/model-router.js';
import { planAction } from './manager.js';
import { promoAction } from '../marketing/promo.js';
import { posterAction } from '../marketing/poster.js';
import { qaContentAction } from './qa.js';
import { classifyGenresAction, classifyReviewsAction } from '../ops/actions.js';
import { PROMPTS } from './prompts.js';
import { AGENT_NAMES, PLAN_SCHEMA, QA_SCHEMA, RESEARCH_SCHEMA } from './schemas.js';

// Tool catalog. A tool is usable only if an agent lists it and an action names it.
export const TOOLS = {
  github_demo_workflow: { description: 'Dispatch the approved demo GitHub Actions job (report or sample video)', implemented: true },
  gutenberg_download: { description: 'Search Project Gutenberg and download public-domain EPUB/cover files (gutenberg.org only)', implemented: true },
  website_drafts: { description: 'Create private book drafts and upload files through the restricted Laravel API', implemented: true },
  website_publish: { description: 'Publish an approved draft through the restricted Laravel API', implemented: true },
  open_library_search: { description: 'Search Open Library metadata', implemented: false, phase: 3 },
  google_books_search: { description: 'Search Google Books metadata', implemented: false, phase: 3 },
  epub_validate: { description: 'Run EPUBCheck / ebooklib checks in GitHub Actions', implemented: false, phase: 5 },
  pdf_inspect: { description: 'Inspect PDF structure with pypdf / PyMuPDF', implemented: false, phase: 5 },
  ffmpeg_render: { description: 'Render vertical video with FFmpeg in GitHub Actions', implemented: false, phase: 5 },
  website_deploy: { description: 'Deploy an approved commit to booksharekh.com over SSH (changed files, backup, health check, rollback)', implemented: true },
  poster_render: { description: 'Render a 1080x1350 (4:5) editorial book poster (HTML + headless Chrome) in GitHub Actions and send it to the owner; never posts', implemented: true },
  promo_video: { description: 'Render 9:16 promo videos (book cover + Khmer text) in GitHub Actions and send them to the owner in Telegram; never posts', implemented: true },
  website_ops_api: { description: 'Read the website catalog and statistics (/api/ai/ops, read-only); apply only owner-approved, whitelisted, verified changes', implemented: true },
  github_pull_request: { description: 'Run the Laravel Developer job on the private website repo: branch, edit, test, open a pull request', implemented: true },
};

// Demo GitHub job, approved per task. The Phase 1 workflow runs it.
const demoJob = (label) => ({
  kind: 'github_job', tool: 'github_demo_workflow', requiresApproval: true, approvalAction: 'dispatch_github_job',
  description: `Run the GitHub Actions demo job (${label}). Nothing is published.`, descriptionKm: 'ដំណើរការ GitHub demo job។ មិនមានអ្វីត្រូវផ្សព្វផ្សាយទេ។',
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
    allowedTools: ['gutenberg_download', 'website_drafts', 'website_publish', 'open_library_search', 'google_books_search', 'github_demo_workflow'],
    limitations: ['Rights default to requires_verification.', 'Never treats downloadable as redistributable.'],
    maxAttempts: 3, allowFallback: true, maxOutputTokens: 2000, outputSchema: RESEARCH_SCHEMA,
    actions: {
      demo_report_job: demoJob('text report'),
      // Owner taps "Prepare draft": download a public-domain EPUB + cover, create a PRIVATE draft.
      prepare_draft: { kind: 'book_draft', tool: 'gutenberg_download', requiresApproval: true, approvalAction: 'prepare_book_draft',
        description: 'Download the public-domain EPUB and cover and create a private draft on booksharekh.com.',
        descriptionKm: 'ទាញយក EPUB និងគម្រប ហើយបង្កើត draft (មិនទាន់បង្ហាញ)។' },
      // Owner taps "Publish": approval bound to the draft's exact file fingerprints.
      publish_book: { kind: 'book_publish', tool: 'website_publish', requiresApproval: true, approvalAction: 'publish_book',
        description: 'Publish this book on booksharekh.com. It becomes visible to visitors.',
        descriptionKm: 'ផ្សព្វផ្សាយសៀវភៅនេះលើ booksharekh.com។' },
    },
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
    allowedTools: ['poster_render'], limitations: ['Drafts only; publication needs owner approval.', 'No invented quotes or facts.', 'Never posts: posters go to the owner in Telegram.'],
    maxAttempts: 3, allowFallback: true, maxOutputTokens: 3000, outputSchema: null,
    actions: {
      // /poster: Khmer poster text (AI), then the owner approves rendering in the website's style.
      write_poster: posterAction,
      poster_job: {
        kind: 'github_job', tool: 'poster_render', workflow: 'demo', requiresApproval: true, approvalAction: 'create_poster',
        description: 'Render the poster in GitHub Actions and send it with its caption to you in Telegram. Nothing is posted.',
        descriptionKm: 'បង្កើត poster ហើយផ្ញើមកអ្នកក្នុង Telegram។ មិន post ទេ។',
      },
    },
  },
  {
    name: 'video_creator', title: 'Video Creator', tier: 'fast', phase: 5,
    description: 'Storyboards, subtitles and vertical 9:16 previews from licensed assets.',
    allowedTools: ['ffmpeg_render', 'github_demo_workflow', 'promo_video'],
    limitations: ['Never posts to TikTok, Facebook or other platforms: videos and captions go to the owner in Telegram.'],
    maxAttempts: 2, allowFallback: true, maxOutputTokens: 3000, outputSchema: null,
    actions: {
      demo_video_job: demoJob('8-second sample-card video'),
      // /promo: Khmer on-screen lines + caption for 1 popular and 1 new book (AI), then the owner approves rendering.
      write_promo: promoAction,
      promo_video_job: {
        kind: 'github_job', tool: 'promo_video', workflow: 'demo', requiresApproval: true, approvalAction: 'create_promo_video',
        description: 'Render the promo videos in GitHub Actions and send them with captions to you in Telegram. Nothing is posted.',
        descriptionKm: 'បង្កើតវីដេអូ ហើយផ្ញើមកអ្នកក្នុង Telegram។ មិន post ទេ។',
      },
    },
  },
  {
    name: 'laravel_developer', title: 'Laravel Developer', tier: 'code', phase: 6, confidential: true,
    description: 'Prepares Laravel changes, migrations and tests as pull requests.',
    allowedTools: ['github_pull_request', 'website_deploy'],
    limitations: ['Never deploys or touches the production database.', 'Human review required.'],
    maxAttempts: 2, allowFallback: false, maxOutputTokens: 8000, outputSchema: null,
    // Code is edited by Claude Code inside GitHub Actions on the private website repo (Claude subscription),
    // never sent to the Worker's free-tier model. The job opens a pull request; it never deploys.
    actions: {
      code_change_job: {
        kind: 'github_job', tool: 'github_pull_request', workflow: 'website_dev', requiresApproval: true, approvalAction: 'dispatch_code_change',
        description: 'Run the Laravel Developer on the private website repo: new branch, code change, tests, pull request. Nothing is deployed.', descriptionKm: 'ឲ្យ Laravel Developer កែកូដ និងបង្កើត PR។ មិនទាន់ deploy ទេ។',
      },
      // Owner approves merging the exact reviewed commit into main (GitHub refuses if the PR changed).
      // Owner approves deploying exactly this commit to the live site (after merge, or via /deploy).
      deploy_job: {
        kind: 'github_job', tool: 'website_deploy', workflow: 'website_deploy', requiresApproval: true, approvalAction: 'deploy_website',
        description: 'Deploy this commit to booksharekh.com: backup first, upload changed files only, check the site, roll back automatically if it breaks.',
        descriptionKm: 'Deploy commit នេះទៅ booksharekh.com (backup មុន · upload តែឯកសារដែលបានកែ · ពិនិត្យ · rollback ស្វ័យប្រវត្តិ)។',
      },
      merge_pr: {
        kind: 'github_merge', tool: 'github_pull_request', requiresApproval: true, approvalAction: 'merge_pull_request',
        description: 'Merge this pull request into main on the website repo. The live site does not change until it is deployed.', descriptionKm: 'Merge PR នេះចូល main។ វេបសាយផ្ទាល់មិនទាន់ប្តូរទេ។',
      },
    },
  },
  {
    name: 'qa_reviewer', title: 'QA Reviewer', tier: 'review', phase: 3,
    description: 'Checks research, content, files, videos, code and rights before owner review.',
    allowedTools: [], limitations: ['QA approval never replaces owner approval.', 'Never receives private website code (free-tier Gemini prompts may be used by Google).'],
    maxAttempts: 2, allowFallback: false, maxOutputTokens: 2000, outputSchema: QA_SCHEMA,
    actions: { review_content: qaContentAction },
  },
  {
    name: 'website_ops', title: 'Website Operations', tier: 'review', phase: 7,
    description: 'Weekly website inspection: books, genres, authors, files, reviews, media, requests and statistics; prepares corrections for approval, applies and verifies them.',
    allowedTools: ['website_ops_api'],
    limitations: ['Rule-based checks first; AI only for genre suggestions and new reviews.', 'Never invents book data, never deletes, never changes prices, money or users.', 'Every change needs the owner approval in Telegram.'],
    maxAttempts: 1, allowFallback: false, maxOutputTokens: 1500, outputSchema: null,
    actions: { classify_genres: classifyGenresAction, classify_reviews: classifyReviewsAction },
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
      if (!['ai', 'github_job', 'github_merge', 'book_draft', 'book_publish'].includes(act.kind)) errors.push(`${a.name}.${n}: unknown action kind ${act.kind}`);
      if (act.tool && !a.allowedTools.includes(act.tool)) errors.push(`${a.name}.${n}: tool ${act.tool} not in allowedTools`);
      if (act.tool && !TOOLS[act.tool]?.implemented) errors.push(`${a.name}.${n}: tool ${act.tool} not implemented`);
      if (act.kind !== 'ai' && !act.requiresApproval) errors.push(`${a.name}.${n}: external action without approval`);
    }
  }
  for (const s of Object.values(DEMO_JOB_STEP)) if (!AGENTS[s.agent]?.actions[s.action]) errors.push(`demo step ${s.agent}.${s.action} missing`);
  return errors;
}

const problems = validateRegistry();
if (problems.length) throw new Error(`Agent registry invalid: ${problems.join('; ')}`);
