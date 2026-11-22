# BookShareKH AI Manager — No PC/VPS always on

An **implementable first milestone**, not the full production book-processing system.

Cloudflare Worker = Telegram + owner-only approvals + D1 memory. Optional paid AI API = task planning. GitHub Actions = approved text report or 8-second **demo** vertical video. Nothing uploads to BookShareKH or TikTok. Books downloaded: **zero**.

## Requirements

- Cloudflare account (Workers Free + D1)
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

## G. Turn on hosted AI planning (optional)

Edit `wrangler.jsonc`: set `AI_PROVIDER` to `openai`, `anthropic`, or `gemini`; set a supported `AI_MODEL` for that provider. Add the matching API key via `wrangler secret put`. Deploy again. Requests use the provider's official HTTPS API; charges and rate limits belong to that provider account.

## Important implementation boundaries

- This is a **first tested scaffold**. Cloud deployment and live Telegram/GitHub integration have **not** been executed here, because they require your accounts and secrets.
- `/task` planning + approval + sample processing are implemented. Book metadata harvesting, EPUB/PDF transformation, verified rights workflows, Laravel API uploads, full production coworker orchestration, TikTok OAuth and public posting are **not yet implemented**.
- Never put raw EPUB/PDF bytes in D1. Use licensed source files and an appropriate external media store if adding them later.
- GitHub Actions is for discrete jobs, not a permanently running AI coworker. It can queue, fail, time out, and incur charges outside included quotas. Set billing and concurrency limits.
- The webhook verifies `X-Telegram-Bot-Api-Secret-Token` and owner user ID. Only use private owner chats.
- Tasks are durable in D1 but there is no scheduled recovery for a lost callback or interrupted GitHub runner. Build a reconciler and retry controls before production use.
- For privacy/copyright, only process titles/covers/files with rights to use and publish; do not remove third-party rights notices or watermarks.
- Keep the real BookShareKH.com application on Namecheap Stellar Plus.
