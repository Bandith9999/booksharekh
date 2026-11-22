# BookShareKH AI Manager — No PC/VPS always on

An **implementable first milestone**, not the full production book-processing system.

Cloudflare Worker = Telegram + owner-only approvals + D1 memory. Cloudflare Queues = background work. Anthropic, OpenAI or Gemini API = task planning. GitHub Actions = approved text report or 8-second **demo** vertical video. Nothing uploads to BookShareKH or TikTok. Books downloaded: **zero**.

## Architecture (Phase 2)

```text
Telegram ──► Worker /telegram ──► D1 (task + steps) ──► Queue ──► Manager agent (AI plan, validated JSON)
                                                                    │
Owner taps Approve ◄── Telegram (plan + buttons) ◄── approval bound to the exact action (SHA-256)
        │
        ▼
     Queue ──► GitHub Actions dispatch (once per approval) ──► /job-result ──► D1 + Telegram report
```

- **The webhook** only validates the update, stores it and enqueues work. All AI calls and GitHub dispatches run from the queue consumer.
- **Each task** (`tasks`) has steps (`agent_tasks`), each owned by one agent and linked by `task_dependencies`. Steps whose dependencies are complete run in parallel. Status changes go through one state machine ([src/orchestration/state-machine.js](src/orchestration/state-machine.js)).
- **Agents** are defined in [src/agents/registry.js](src/agents/registry.js): system prompt and version, output schema, allowed tools, actions, retry limit and model tier. The AI can only *propose* steps. Only actions declared in code can run, and every external action needs owner approval.
- **Providers** ([src/ai/](src/ai/)) share one interface (`generate(env, request) → { provider, model, content, structuredOutput, usage, finishReason }`). Structured output is always validated in the Worker, whichever provider produced it.
- **Implemented today:** the Manager plans with AI, and the demo GitHub job runs after approval. The six specialist agents are registered with prompts, schemas and tool permissions, but their AI work arrives in Phases 3–6. `/agents` shows which are live.

## Requirements

- Cloudflare account (Workers Free + D1 + Queues)
- GitHub account and **private** repository `booksharekh-ai-manager` (or change the config)
- Telegram bot token from [BotFather](https://t.me/BotFather)
- Node.js 22+ installed **only for setup/deployment**; turn your computer off afterward
- Optional OpenAI, Anthropic, or Gemini **API** key, with billing/quota separately from Claude Pro/ChatGPT subscriptions

## A. Create the repository

Unzip, open terminal in this folder, run:

```bash
npm install
npm test
```

Create a **private** GitHub repository. Push the entire source, including `.github/workflows/worker-job.yml`, to its **main** branch. Do not add secrets to source code. GitHub Actions private repository usage is subject to your account's included allowance and billing settings.

## B. Deploy Cloudflare Worker and D1

```bash
npx wrangler login
npx wrangler d1 create booksharekh-ai-db
```

Copy the returned **database_id** into `wrangler.jsonc`. Also edit:

- `OWNER_TELEGRAM_ID` — the owner's numeric Telegram ID, not the bot's ID. Obtain it using Telegram's @userinfobot or a trusted equivalent.
- `GITHUB_OWNER` — GitHub username or organization owning the repository.
- `GITHUB_REPO` — exact repository name.
- `AI_PROVIDER` — `mock` to start; use `openai`, `anthropic`, or `gemini` later.
- `AI_MODEL` — valid model ID for your selected provider; verify provider documentation.

Then:

```bash
npx wrangler d1 migrations apply booksharekh-ai-db --remote
npx wrangler deploy
```

Wrangler prints an HTTPS Worker URL such as `https://booksharekh-ai-manager.<subdomain>.workers.dev`. Test `<URL>/health`.

## C. Configure secrets

These commands prompt for values. Generate independent random secrets with a password manager or cryptographically secure generator. **The same JOB_CALLBACK_SECRET** must be stored in both Cloudflare and GitHub Actions.

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put JOB_CALLBACK_SECRET
```

`GITHUB_TOKEN` is a **fine-grained personal access token**, limited to this one repository with **Actions: Read and write** as required for workflow dispatch. Never use GitHub's repository Actions built-in `GITHUB_TOKEN` as the Worker secret. Use a short expiration and rotate it.

Optional API keys (only one needed, selected by AI_PROVIDER):

```bash
npx wrangler secret put OPENAI_API_KEY
# or npx wrangler secret put ANTHROPIC_API_KEY
# or npx wrangler secret put GEMINI_API_KEY
```

Important: These are separately billed/quota-governed **developer API keys**. Consumer subscriptions are not interchangeable with API access.

## D. Add GitHub Actions secrets

In GitHub repository → Settings → Secrets and variables → Actions → New repository secret:

- `WORKER_URL` = HTTPS Worker base URL (no trailing `/`)
- `JOB_CALLBACK_SECRET` = exactly the same secret stored in Cloudflare

Confirm GitHub Actions is enabled for the repository and `worker-job.yml` exists on `main`.

## E. Configure Telegram webhook

After deploying Worker and storing its secrets:

```bash
node scripts/set-webhook.mjs https://YOUR_WORKER.workers.dev/telegram
```

You will enter the same Telegram bot token and webhook secret from step C. Be aware terminal input is **visible** in this helper; run privately. Alternatively use the Telegram Bot API `setWebhook` from your password-manager-backed tooling.

Send `/start` to the bot from the configured owner's **private** Telegram chat.

## F. First acceptance test

Send:

```
/remember website.framework=Laravel Blade
/remember videos.language=Khmer
/memory
/task Make a short promotional video for an authorized sample book
```

- You receive a task ID and a plan (mock if AI_PROVIDER=mock).
- Press **Approve demo**.
- Cloudflare dispatches the workflow in GitHub Actions.
- GitHub creates `output/report.txt` and (for video tasks) `output/sample.mp4` with a sample card **without copyrighted content**.
- GitHub calls `/job-result`; Worker updates D1 and sends a Telegram status notification with the GitHub run link.
- Open that run, find **Artifacts**, and download the output.
- Try pressing Approve twice: only the first action should dispatch.
- Use `/status` and `/pending` to inspect recent records.

## G. AI providers and models

**Default: $0 mode.** All seven agents use Google Gemini `gemini-3.8-flash` on the free API tier, and paid AI is locked (see section I).

Each agent uses a **tier**, and each tier maps to a provider and model in `wrangler.jsonc`. In $0 mode only the default tier is set, so every tier inherits it:

| Variable | Used by | $0 default |
|---|---|---|
| `AI_DEFAULT_PROVIDER` / `AI_DEFAULT_MODEL` | Manager, and every tier left unset | `google` / `gemini-3.8-flash` |
| `AI_FAST_PROVIDER` / `AI_FAST_MODEL` | Book Researcher, Content Creator, Video Creator | unset → default |
| `AI_REVIEW_PROVIDER` / `AI_REVIEW_MODEL` | EPUB/PDF Editor, QA Reviewer | unset → default |
| `AI_CODE_PROVIDER` / `AI_CODE_MODEL` | Laravel Developer | unset → default |

Providers are `anthropic`, `openai`, `google` (`gemini` also works) and `mock`. Each provider needs its key as a Cloudflare secret: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GEMINI_API_KEY`. The Phase 1 names `AI_PROVIDER` / `AI_MODEL` still work for the default tier.

To change one agent without redeploying, send `/agent book_researcher set provider=google model=<gemini-model-id>`, then `/diag`. The command checks the model id format and that the key is set. `/diag` then asks the provider whether the model is available to your account. Use `/agent <name> set reset` to go back to the tier.

- **Provider fallback is off.** Set `AI_FALLBACK_ENABLED=true` with `AI_FALLBACK_PROVIDER` and `AI_FALLBACK_MODEL` to turn it on. Even then, it is used only for rate limits, outages and timeouts. It is never used for refusals, auth errors or budget limits, and never by agents that disallow it (EPUB/PDF Editor, Laravel Developer, QA Reviewer).
- **Anthropic's own refusal fallback** (`ANTHROPIC_REFUSAL_FALLBACK=true`) is also off by default.
- **Budgets:** `TASK_TOKEN_BUDGET` (default 60,000) and `DAILY_TOKEN_BUDGET` (default 500,000) are checked before every model call. Every call is logged in `agent_execution_logs` with provider, model, tokens and prompt version.
- **Limits:** `TASK_RATE_LIMIT_PER_HOUR` (default 20) and `APPROVAL_TTL_HOURS` (default 24).

## H. Phase 2 deployment

Run these from a branch checkout that has been reviewed and merged to `main`. GitHub Actions runs the workflow from `main`.

```bash
npm install && npm test
npx wrangler queues create booksharekh-tasks
npx wrangler queues create booksharekh-tasks-dlq
npx wrangler d1 migrations apply booksharekh-ai-db --remote   # applies 0002 only; additive
npx wrangler deploy
```

**Check it:** send `/diag`, which should be all ✅. Then send `/agents`, then `/task Make a short promotional video for an authorized sample book`. Wait for the plan message, press **Approve**, wait for "job started" and then "completed", and finish with `/taskstatus <id>`.

**Rollback:**
- `npx wrangler rollback` restores the previous Worker version. Migration 0002 only added tables, so the older Worker ignores them. Leave them in place, because dropping them would delete Phase 2 history.
- Phase 1 code only understands `pending` tasks, so anything Phase 2 left in `planning`, `awaiting_approval` or `queued` will stay there. Cancel those first: `UPDATE tasks SET status='cancelled' WHERE status IN ('planning','awaiting_approval','queued')` via `wrangler d1 execute --remote`.
- The queues can stay. Delete them with `wrangler queues delete` only after rolling back.

## I. $0 mode: Gemini free tier

**Setup**
1. In Google AI Studio, create an API key in a Google Cloud project **with no billing account linked**. Linking billing moves the project to the paid tier.
2. Run `npx wrangler secret put GEMINI_API_KEY`.
3. In AI Studio, open the rate-limit page (https://aistudio.google.com/rate-limit) and note the RPM and RPD shown for `gemini-3.8-flash`. Set `AI_MAX_REQUESTS_PER_MINUTE` and `AI_MAX_REQUESTS_PER_DAY` in `wrangler.jsonc` *below* those numbers. Google publishes free-tier limits only there.
4. Deploy, then send `/diag`. It checks the model with a metadata call that uses no generation quota.

**Paid AI lock**
- `AI_PAID_ENABLED=false` lets only the mock provider and the Gemini models in `AI_FREE_MODELS` run. Anthropic, OpenAI and paid-only Gemini models are refused everywhere: at run time, by `/agent … set`, and as fallbacks.
- To unlock paid AI, the owner edits `wrangler.jsonc` and redeploys. The bot cannot unlock it.
- If a fallback is configured but locked, a Gemini outage is retried on Gemini only, and the blocked fallback is written to the audit log.

**Limits** (set in `wrangler.jsonc`)

| Variable | Default | What happens when it's reached |
|---|---|---|
| `AI_MAX_REQUESTS_PER_MINUTE` | 5 | The call waits 60 s, then retries |
| `AI_MAX_REQUESTS_PER_DAY` | 100 | The task **pauses** |
| `DAILY_TOKEN_BUDGET` | 300,000 | The task **pauses** |
| `TASK_TOKEN_BUDGET` | 30,000 | The task fails |
| `DAILY_TASK_LIMIT` | 20 | `/task` is refused |
| `TASK_RATE_LIMIT_PER_HOUR` | 10 | `/task` is refused |

Local daily counters reset at 00:00 UTC.

**When a quota runs out**
- If Gemini reports its daily quota is used up, or a local daily limit is reached, the task **pauses** and you get a Telegram message. Nothing switches to another provider.
- Google resets its quota at midnight Pacific time. Send `/resume <task-id>` after that, or `/cancel <task-id>`.
- Per-minute limits are retried after the delay Gemini asks for.

**Free-tier data handling (read before sending real website content)**
Google's Gemini API terms for unpaid services say:
- Google uses submitted content and responses to improve its products.
- Human reviewers may read, annotate and process API input and output (disconnected from your account first).
- "Do not submit sensitive, confidential, or personal information to the Unpaid Services."
- Users must be 18 or older.

What this means for BookShareKH:
- Everything in `/task` text and in `/remember` settings is sent to Gemini. `/remember` refuses values that look like passwords, keys or tokens.
- The EPUB/PDF Editor and the Laravel Developer handle private files and source code, so they refuse free-tier Gemini. That changes only if you set `GEMINI_PAID_TIER=true` (a project with billing) or knowingly set `AI_ALLOW_CONFIDENTIAL_ON_FREE_TIER=true`.
- Customer data, unpublished manuscripts, credentials and private code need a paid tier.

**What stays free, and what doesn't**

| Component | Free allowance (checked 2026-11-22) | Fits this bot? |
|---|---|---|
| Gemini API, free tier | RPM/RPD per project shown in AI Studio | Yes, for planning and short drafts within your quota |
| Cloudflare Workers Free | 100,000 requests/day; 10 ms CPU per request; 50 outbound requests per run | Yes; the handlers mostly wait on I/O. Watch the CPU-time metric in the dashboard |
| Cloudflare Queues (Free) | 10,000 operations/day; messages kept 24 h | Yes: about 3 operations per step, so roughly 1,000+ tasks/day |
| Cloudflare D1 Free | 5M rows read/day, 100k rows written/day, 5 GB | Yes |
| GitHub Actions | Unlimited for public repos; 2,000 minutes/month for private repos on GitHub Free | Yes: about 1–2 minutes per demo job, so roughly 1,000 jobs/month if the repo is private |
| Telegram Bot API | Free | Yes |

**Not available at $0:**
- Unlimited model use
- Confidential processing without Google using the data
- Premium video or image generation (Google's docs list Gemini Omni Flash and Genie 4 as not supported on the free tier)
- Claude or OpenAI models
- Large file storage beyond the R2 free allowance (R2 may also require a payment method on file)
- Any support guarantee: free-tier quotas can change or be reduced at Google's discretion

## J. Troubleshooting

Send `/diag` to the bot. It reports whether each secret is set (never its value), checks D1, asks Anthropic whether the key is accepted and `AI_MODEL` is available, and checks that the GitHub token can read the workflow.

- **Claude HTTP 401 / "AI planning failed"**: the `ANTHROPIC_API_KEY` value is wrong or revoked. Create a key in the Claude Console (API Keys), run `npx wrangler secret put ANTHROPIC_API_KEY`, and paste only the `sk-ant-…` value. A Claude Pro/Max subscription cannot be used as an API key. The task is saved as `plan_failed` and cannot be approved. Send the `/task` again after fixing the key.
- **GitHub HTTP 403 "Resource not accessible by personal access token"**: edit the fine-grained token (GitHub → Settings → Developer settings → Fine-grained tokens). Set Repository access to include this repository, and set Repository permissions → **Actions: Read and write**. If you create a new token, run `npx wrangler secret put GITHUB_TOKEN`. `dispatch_failed` tasks are not retried; create a new `/task`.

## Important implementation boundaries

- Telegram commands: `/task`, `/taskstatus`, `/approve`, `/reject`, `/cancel`, `/status`, `/pending`, `/agents`, `/agent`, `/remember`, `/memory`, `/diag`, `/help`. Buttons: Approve, Reject, Cancel task. Phase 1 approval buttons still work for tasks created before the upgrade.
- A task already running on GitHub Actions cannot be cancelled from Telegram; cancel the run in GitHub.
- If a GitHub dispatch times out, the Worker cannot know whether the run started, so it marks the task failed instead of dispatching twice. Check GitHub Actions before creating a new task.
- This is a **first tested scaffold**. Cloud deployment and live Telegram/GitHub integration have **not** been executed here, because they require your accounts and secrets.
- `/task` planning + approval + sample processing are implemented. Book metadata harvesting, EPUB/PDF transformation, verified rights workflows, Laravel API uploads, full production coworker orchestration, TikTok OAuth and public posting are **not yet implemented**.
- Never put raw EPUB/PDF bytes in D1. Use licensed source files and an appropriate external media store if adding them later.
- GitHub Actions is for discrete jobs, not a permanently running AI coworker. It can queue, fail, time out, and incur charges outside included quotas. Set billing and concurrency limits.
- The webhook verifies `X-Telegram-Bot-Api-Secret-Token` and owner user ID. Only use private owner chats.
- Tasks are durable in D1 but there is no scheduled recovery for a lost callback or interrupted GitHub runner. Build a reconciler and retry controls before production use.
- For privacy/copyright, only process titles/covers/files with rights to use and publish; do not remove third-party rights notices or watermarks.
- Keep the real BookShareKH.com application on Namecheap Stellar Plus.

## K. Website management (in progress)

- `/website` checks the live site: homepage, debug mode and exposed sensitive paths. It reports status codes only and never page contents.
- `/books [latest N | search <title>]` reads book data through the restricted Laravel AI API, once that API is installed (`LARAVEL_API_URL` + secret `LARAVEL_API_TOKEN`).
- `/develop <change>` makes the Manager plan the change and ask for your approval. Approving dispatches the **Laravel Developer** workflow in the private website repository: Claude Code edits the code on a new branch, then the workflow runs lint, tests and a secret scan and opens a pull request. Telegram gets the PR link and commit. **Nothing is deployed**; deployment will be a separate approval for that exact commit.
- Setup of the website repository: see [website-kit/README.md](website-kit/README.md).
