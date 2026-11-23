// Small D1 data-access helpers shared by the orchestration modules.
import { clamp, sha256Hex } from './helpers.js';

export const newId = prefix => `${prefix}-${crypto.randomUUID()}`;
export const parseJson = (s, fallback = null) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

export async function audit(env, taskId, event, actor, details = '') {
  await env.DB.prepare('INSERT INTO audit_log (task_id,event,actor,details) VALUES (?,?,?,?)')
    .bind(taskId, event, String(actor), clamp(details, 500)).run();
}

export const getTask = (env, id) => env.DB.prepare('SELECT * FROM tasks WHERE id=?').bind(id).first();
export const getAgentTask = (env, id) => env.DB.prepare('SELECT * FROM agent_tasks WHERE id=?').bind(id).first();
export async function listAgentTasks(env, taskId) {
  return (await env.DB.prepare('SELECT * FROM agent_tasks WHERE task_id=? ORDER BY created_at, rowid').bind(taskId).all()).results || [];
}
export async function listDependencies(env, taskId) {
  return (await env.DB.prepare(`SELECT d.agent_task_id, d.depends_on_id FROM task_dependencies d
    JOIN agent_tasks a ON a.id=d.agent_task_id WHERE a.task_id=?`).bind(taskId).all()).results || [];
}
export const getAgentOverride = (env, name) => env.DB.prepare('SELECT * FROM agents WHERE name=?').bind(name).first();

// Small structured content only. Large binaries belong in object storage; store their URI here.
export async function addArtifact(env, { taskId, agentTaskId = null, kind, uri = null, content = null, contentType = 'application/json' }) {
  const next = await env.DB.prepare('SELECT COALESCE(MAX(version),0)+1 v FROM task_artifacts WHERE task_id=? AND kind=?').bind(taskId, kind).first();
  await env.DB.prepare(`INSERT INTO task_artifacts (task_id,agent_task_id,kind,version,uri,content,content_type,sha256) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(taskId, agentTaskId, kind, next.v, uri, content, contentType, content == null ? null : await sha256Hex(content)).run();
  return next.v;
}
export const latestArtifact = (env, taskId, kind) =>
  env.DB.prepare('SELECT * FROM task_artifacts WHERE task_id=? AND kind=? ORDER BY version DESC LIMIT 1').bind(taskId, kind).first();

export async function memoryContext(env) {
  const rows = await env.DB.prepare('SELECT key,value FROM memories ORDER BY updated_at DESC LIMIT 15').all();
  return (rows.results || []).map(x => `${x.key}: ${x.value}`).join('\n');
}

// Resolve a full or shortened task id to exactly one task.
export async function findTask(env, ref) {
  const rows = (await env.DB.prepare('SELECT * FROM tasks WHERE id LIKE ? LIMIT 2').bind(`${ref}%`).all()).results || [];
  return rows.length === 1 ? rows[0] : null;
}
