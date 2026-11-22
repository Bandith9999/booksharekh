// Manager agent: turns an owner request into a structured, provider-neutral plan.
import { clamp } from '../helpers.js';
import { addArtifact, memoryContext } from '../db.js';
import { PROMPTS, wrapUntrusted } from './prompts.js';
import { PLAN_SCHEMA } from './schemas.js';
import { T, planLanguageRule } from '../i18n.js';

const TITLES = {
  book_researcher: 'Book Researcher', book_editor: 'EPUB/PDF Editor', content_creator: 'Content Creator',
  video_creator: 'Video Creator', laravel_developer: 'Laravel Developer', qa_reviewer: 'QA Reviewer',
};

export function renderPlan(plan, res, env = null) {
  const L = T.plan(env);
  const lines = [L.head(`${res.provider}/${res.model}`), plan.summary, '', L.steps];
  plan.steps.forEach((s, i) => lines.push(`${i + 1}. ${TITLES[s.agent] || s.agent} — ${s.objective}`));
  if (plan.risks.length) { lines.push('', L.risks); plan.risks.forEach(r => lines.push(`• ${r}`)); }
  const rights = L.rights(plan.needs_rights_verification);
  if (rights) lines.push('', rights);
  return lines.join('\n');
}

export const planAction = {
  kind: 'ai',
  description: 'Plan a task and propose specialist steps',
  async buildRequest(env, { task }) {
    const memory = await memoryContext(env);
    return {
      systemPrompt: PROMPTS.manager.system + planLanguageRule(env),
      promptVersion: PROMPTS.manager.version,
      messages: [{ role: 'user', content: `Task type: ${task.task_type}\n${wrapUntrusted('saved_settings', memory || '(none)')}\n${wrapUntrusted('owner_request', task.request_text)}` }],
      responseSchema: PLAN_SCHEMA,
      effort: 'low',
      metadata: { taskType: task.task_type, request: task.request_text },
    };
  },
  async onComplete(env, { task, agentTask, result }) {
    const plan = result.structuredOutput;
    await addArtifact(env, {
      taskId: task.id, agentTaskId: agentTask.id, kind: 'plan',
      content: JSON.stringify({ plan, provider: result.provider, model: result.model, prompt_version: PROMPTS.manager.version, usage: result.usage }),
    });
    await env.DB.prepare('UPDATE tasks SET proposal=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .bind(clamp(renderPlan(plan, result, env), 1500), task.id).run();
    return plan;
  },
};
