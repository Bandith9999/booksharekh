# BookShareKH website kit

Files to put in the **private** website repository `Bandith9999/booksharekh-website`. That repository is separate from this AI Manager repository.

| File | Purpose |
|---|---|
| `.github/workflows/laravel-developer.yml` | Runs only when the AI Manager dispatches it after your Telegram approval. Claude Code (on your Claude subscription) edits the files. The workflow then runs PHP lint and tests, scans for secrets, commits to `ai/<task-id>`, opens a pull request and reports back. It never deploys. |
| `.github/workflows/ci.yml` | Runs on every PR and on `main`: lint, tests, secret scan, and a check that no `.env` file is committed. |
| `prepare-export.mjs` | Builds a clean copy of the cPanel source and scans it for secrets before the first push. |

## One-time setup
1. **Export the source** (cPanel → File Manager → compress the Laravel root folder → download). Extract it, then run:
   `node website-kit/prepare-export.mjs <extracted-folder> <clean-folder>`.
   Exit code 2 means hard-coded secrets were found: move them to `.env` and rotate them before pushing.
2. **Create the repository:** on GitHub, create `booksharekh-website` as **Private** with no README. Push the clean folder plus this kit's `.github/` folder.
3. **Add secrets** in the website repo (Settings → Secrets and variables → Actions):
   - `CLAUDE_CODE_OAUTH_TOKEN`: run `claude setup-token` on your PC and paste the result there, never in chat. It uses your Claude subscription's usage.
   - `WORKER_URL`: `https://booksharekh-ai-manager.booksharekh-ai.workers.dev`
   - `JOB_CALLBACK_SECRET`: the same value stored in Cloudflare.
4. **Change repo settings:**
   - Settings → Actions → General → Workflow permissions: enable **"Allow GitHub Actions to create and approve pull requests"**.
   - Settings → Branches: protect `main`. Require pull requests and the `CI` check, and disallow force pushes.
5. **Update the Cloudflare `GITHUB_TOKEN`:** edit the fine-grained token so it also covers `booksharekh-website` with **Actions: Read and write**.
6. **Connect it in the AI Manager:** set `"WEBSITE_REPO": "booksharekh-website"` in `wrangler.jsonc` and deploy. `/diag` should then show the website repository as readable.

## Not in this kit yet
- **Deployment to Namecheap.** It needs your hosting details (SSH or SFTP availability, folder layout) and will deploy only an approved commit SHA, with a backup first and a health check after.
- **The restricted Laravel AI API.** It will be written against your real Book model once the source is in the repository.
