// Approved GitHub Actions job execution. Exactly one workflow dispatch per approval.
import { clamp, githubHint, sha256Hex } from '../helpers.js';
import { audit, latestArtifact, newId } from '../db.js';
import { notifyTaskOwner } from '../telegram.js';
import { consumeApproval, finishApproval, releaseApproval } from './approvals.js';
import { transition } from './state-machine.js';

const HTTP_TIMEOUT_MS = 15000;

// Workflows the Worker may dispatch. Code-defined: the AI cannot add one.
export const WORKFLOWS = {
  // Demo report/video job in this repository.
  demo: { file: 'worker-job.yml', repo: env => env.GITHUB_REPO, label: 'demo job', repoSetting: 'GITHUB_REPO' },
  // Laravel Developer in the private website repository: branch, edit, test, open a pull request. Never deploys.
  website_dev: { file: 'laravel-developer.yml', repo: env => env.WEBSITE_REPO, label: 'Laravel Developer job', repoSetting: 'WEBSITE_REPO' },
};
export const WORKFLOW_FILE = WORKFLOWS.demo.file;
const workflowOf = action => WORKFLOWS[action?.workflow || 'demo'];

export class JobError extends Error {
  constructor(message, { retryable = false, unknown = false } = {}) { super(message); this.retryable = retryable; this.unknown = unknown; }
}

export function githubHeaders(env) {
  return { Authorization: `Bearer ${String(env.GITHUB_TOKEN || '').trim()}`, Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'booksharekh-cloudflare-manager' };
}
export const workflowUrl = (env, wf = WORKFLOWS.demo) =>
  `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(wf.repo(env) || '')}/actions/workflows/${wf.file}`;

// The exact action the owner approves. Any change to the request, plan, repo or workflow changes the hash.
export async function jobPayload(env, task, action = null) {
  const wf = workflowOf(action);
  const plan = await latestArtifact(env, task.id, 'plan');
  return {
    action: action?.approvalAction || 'dispatch_github_job', repo: `${env.GITHUB_OWNER}/${wf.repo(env)}`, workflow: wf.file, ref: 'main',
    inputs: { task_id: task.id }, task_type: task.task_type,
    request_sha256: await sha256Hex(task.request_text), plan_sha256: await sha256Hex(plan?.content ?? task.proposal),
  };
}

export async function dispatchWorkflow(env, taskId, wf = WORKFLOWS.demo) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_OWNER) throw new JobError('GitHub Actions secrets/settings not configured');
  if (!wf.repo(env)) throw new JobError(`${wf.label}: repository not configured (set ${wf.repoSetting} in wrangler.jsonc).`);
  let r;
  try {
    r = await fetch(`${workflowUrl(env, wf)}/dispatches`, { method: 'POST', headers: { ...githubHeaders(env), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main', inputs: { task_id: taskId } }), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (e) {
    // We cannot tell whether GitHub accepted it, so never dispatch again automatically.
    throw new JobError(`GitHub dispatch outcome unknown (${e?.name === 'TimeoutError' ? 'timeout' : 'network error'}). Check GitHub Actions before creating a new task.`, { unknown: true });
  }
  if (r.status === 204) return;
  const detail = (await r.json().catch(() => null))?.message || '';
  throw new JobError(`GitHub dispatch HTTP ${r.status}: ${clamp(detail, 120)}. ${githubHint(r.status)}`, { retryable: r.status >= 500 });
}

// Executes an approved GitHub job step. The step stays 'running' until /job-result arrives.
export async function runGithubJob(env, task, agentTask, action = null) {
  const wf = workflowOf(action);
  const approval = await env.DB.prepare(`SELECT * FROM task_approvals WHERE agent_task_id=? AND status IN ('approved','executing')
      ORDER BY requested_at DESC LIMIT 1`).bind(agentTask.id).first();
  if (!approval) throw new JobError('No valid owner approval for this step');
  if (approval.status === 'approved') {
    const c = await consumeApproval(env, approval.id, await jobPayload(env, task, action));
    if (!c.ok) throw new JobError(c.reason === 'payload_changed'
      ? 'The task changed after it was approved, so the approval no longer applies. Create a new task.'
      : `Approval cannot be used (${c.reason}).`);
  }
  const claim = await env.DB.prepare(`INSERT INTO workflow_runs (id,task_id,agent_task_id,approval_id,workflow,status) VALUES (?,?,?,?,?,'dispatching')
      ON CONFLICT(approval_id) DO UPDATE SET status='dispatching', attempts=attempts+1, error=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE workflow_runs.status='failed'`).bind(newId('WR'), task.id, agentTask.id, approval.id, wf.file).run();
  if (claim.meta?.changes !== 1) {
    const run = await env.DB.prepare('SELECT status FROM workflow_runs WHERE approval_id=?').bind(approval.id).first();
    if (['dispatched', 'completed'].includes(run?.status)) return; // redelivered after success: wait for the callback
    await env.DB.prepare("UPDATE workflow_runs SET status='unknown', updated_at=CURRENT_TIMESTAMP WHERE approval_id=? AND status='dispatching'").bind(approval.id).run();
    throw new JobError('An earlier dispatch attempt was interrupted and may have started a run. Check GitHub Actions before creating a new task.', { unknown: true });
  }
  try {
    await dispatchWorkflow(env, task.id, wf);
  } catch (e) {
    await env.DB.prepare('UPDATE workflow_runs SET status=?, error=?, updated_at=CURRENT_TIMESTAMP WHERE approval_id=?')
      .bind(e.unknown ? 'unknown' : 'failed', clamp(e.message, 500), approval.id).run();
    if (e.retryable) await releaseApproval(env, approval.id); else await finishApproval(env, approval.id, false);
    throw e;
  }
  await env.DB.prepare("UPDATE workflow_runs SET status='dispatched', updated_at=CURRENT_TIMESTAMP WHERE approval_id=?").bind(approval.id).run();
  await finishApproval(env, approval.id, true);
  // Keep the step leased while GitHub runs (job timeouts are well under this).
  await env.DB.prepare("UPDATE agent_tasks SET lease_until=datetime('now','+3 hours') WHERE id=?").bind(agentTask.id).run();
  await transition(env.DB, 'tasks', task.id, 'running');
  await audit(env, task.id, 'DISPATCHED', 'worker', `${wf.repo(env)}/${wf.file} approval=${approval.id}`);
  await notifyTaskOwner(env, task, `🚀 Task ${task.id}: GitHub Actions ${wf.label} started. You'll get a message when it finishes.`);
}
