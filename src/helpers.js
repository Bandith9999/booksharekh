export function classifyTask(s) {
  return /video|tiktok|reel|វីដេអូ/i.test(s) ? 'video_demo' : 'report';
}
export function clamp(text, n=3500) {
  return String(text || '').slice(0, n);
}
export function parseMemory(message) {
  const m = /^\/remember\s+([a-zA-Z0-9_.-]{1,80})=(.{1,1000})$/s.exec(message.trim());
  return m ? { key: m[1], value: m[2].trim() } : null;
}
export function isOwner(actual, owner) {
  return String(actual) === String(owner) && String(owner) !== 'REPLACE_WITH_TELEGRAM_NUMERIC_ID';
}
export function safeTaskId(s) {
  return /^BSK-[a-f0-9-]{36}$/.test(String(s));
}
// "/task@MyBot  do x" -> { cmd: 'task', args: 'do x' }; non-commands -> null.
export function parseCommand(text) {
  const m = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(String(text || '').trim());
  return m ? { cmd: m[1].toLowerCase(), args: (m[2] || '').trim() } : null;
}
// Actionable fixes for provider errors. Never include secret values here.
export function anthropicHint(status) {
  if (status === 401) return 'Key rejected: create a new API key in the Claude Console (API Keys), then run `npx wrangler secret put ANTHROPIC_API_KEY` and paste only the sk-ant-… value. A Claude Pro/Max subscription is not an API key.';
  if (status === 403) return 'Key lacks permission for this model or workspace.';
  if (status === 404) return 'Model not available to this account: check AI_MODEL in wrangler.jsonc.';
  if (status === 400) return 'Request rejected: check AI_MODEL and account credit balance.';
  if (status === 429) return 'Rate limited or spend limit reached: check limits/billing in the Claude Console.';
  if (status === 529 || status >= 500) return 'Anthropic is temporarily unavailable: try again shortly.';
  return 'Unexpected response.';
}
export function githubHint(status) {
  if (status === 401) return 'GITHUB_TOKEN is invalid or expired: create a new fine-grained token and run `npx wrangler secret put GITHUB_TOKEN`.';
  if (status === 403) return 'Token lacks permission: the fine-grained token needs Repository access to this repo and Repository permissions → Actions: Read and write.';
  if (status === 404) return 'Not found: check GITHUB_OWNER/GITHUB_REPO, that the token can access the repo, and that .github/workflows/worker-job.yml is on main.';
  if (status === 422) return 'Workflow rejected the request: check that branch main exists and the workflow has workflow_dispatch with a task_id input.';
  return 'Unexpected response from GitHub.';
}
