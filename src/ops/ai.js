// Website Operations: the only two jobs that need an AI. Everything else is plain code.
//  1. Genres for books that have none or only a catch-all genre (existing genres only).
//  2. New reviews the rules did not flag: ok / spam / offensive.
// Token rules: only new or changed records (fingerprint cache), compact input (title, author,
// 200 characters of description), bounded batches, compact JSON output, a weekly and a monthly
// token budget. The AI is the website_ops agent (tier review: Gemini → Codex → Claude, cheapest first).
import { clamp, sha256Hex } from '../helpers.js';
import { newId } from '../db.js';
import { classifyGenresAction, classifyReviewsAction } from './actions.js';
import { runAIAction } from '../agents/runner.js';
import { cacheGet, cachePut } from './store.js';
import { normKey } from './checks.js';

import { GENRE_BATCH, REVIEW_BATCH } from './actions.js';
export const opsBudgets = env => ({
  weekly: Number(env.AI_OPS_WEEKLY_TOKENS) || 40000,
  monthly: Number(env.AI_OPS_MONTHLY_TOKENS) || 150000,
  batches: Math.min(Number(env.AI_OPS_MAX_BATCHES) || 4, 10),
});

export async function opsTokensUsed(env) {
  const q = days => env.DB.prepare(`SELECT COALESCE(SUM(input_tokens+output_tokens),0) t, COUNT(*) n FROM agent_execution_logs
      WHERE agent='website_ops' AND created_at >= datetime('now', ?)`).bind(`-${days} days`).first();
  const [w, m] = await Promise.all([q(7), q(30)]);
  return { week: Number(w.t), weekCalls: Number(w.n), month: Number(m.t), monthCalls: Number(m.n) };
}
async function budgetLeft(env) {
  const b = opsBudgets(env), u = await opsTokensUsed(env);
  return u.week < b.weekly && u.month < b.monthly;
}

async function aiStep(env, task, actionName, n) {
  const id = newId('AT');
  await env.DB.prepare(`INSERT INTO agent_tasks (id,task_id,agent,action,status,input,max_attempts,idempotency_key,attempts,started_at)
      VALUES (?,?,?,?,'running','{}',1,?,1,CURRENT_TIMESTAMP)`).bind(id, task.id, 'website_ops', actionName, `${task.id}:website_ops:${actionName}:${n}`).run();
  return env.DB.prepare('SELECT * FROM agent_tasks WHERE id=?').bind(id).first();
}
async function finishStep(env, at, ok, output, error) {
  await env.DB.prepare(`UPDATE agent_tasks SET status=?, output=?, error=?, finished_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .bind(ok ? 'completed' : 'failed', ok ? JSON.stringify(output) : null, ok ? null : clamp(error, 300), at.id).run();
}

async function ask(env, task, actionName, n, payload) {
  const at = await aiStep(env, task, actionName, n);
  const base = { classify_genres: classifyGenresAction, classify_reviews: classifyReviewsAction }[actionName];
  try {
    const res = await runAIAction(env, { task, agentTask: at, action: { ...base, buildRequest: (e, ctx) => base.buildRequest(e, { ...ctx, payload }) } });
    await finishStep(env, at, true, { items: res.structuredOutput?.items?.length ?? 0 });
    return res.structuredOutput?.items || [];
  } catch (e) {
    await finishStep(env, at, false, null, e?.message || String(e));
    return null; // AI unavailable: the run continues with the rule-based results
  }
}

// Returns { findings, sent, cached, skipped }.
export async function suggestGenres(env, task, books, taxonomy) {
  const genres = (taxonomy.genres || []).filter(g => !/^\s*$/.test(g.name));
  const known = new Map(genres.map(g => [g.id, g]));
  const genreSig = await sha256Hex(genres.map(g => `${g.id}:${normKey(g.name)}`).join('|'));
  const todo = [], findings = [];
  let cached = 0;
  for (const b of books) {
    const fp = await sha256Hex([b.title, b.author, clamp(b.description, 200), (b.genre_ids || []).join(','), genreSig].join('|'));
    const hit = await cacheGet(env, `genre:${b.id}`, fp);
    if (hit) { cached++; if (hit.genre_ids?.length) findings.push(genreFinding(b, hit, known)); continue; }
    todo.push({ b, fp });
  }
  let sent = 0, n = 0;
  const { batches } = opsBudgets(env);
  for (let i = 0; i < todo.length && n < batches; i += GENRE_BATCH, n++) {
    if (!await budgetLeft(env)) break;
    const part = todo.slice(i, i + GENRE_BATCH);
    const items = await ask(env, task, 'classify_genres', n, { genres, books: part.map(x => x.b) });
    if (!items) break;
    sent += part.length;
    const byId = new Map(items.map(it => [Number(it.id), it]));
    for (const { b, fp } of part) {
      const it = byId.get(b.id);
      // Only existing genres, at most 3, and only confident answers become proposals.
      const ids = [...new Set((it?.genre_ids || []).map(Number).filter(id => known.has(id)))].slice(0, 3);
      const value = { genre_ids: it?.confidence === 'low' ? [] : ids, confidence: it?.confidence || 'low' };
      await cachePut(env, `genre:${b.id}`, fp, value);
      if (value.genre_ids.length) findings.push(genreFinding(b, value, known));
    }
  }
  return { findings, sent, cached, skipped: Math.max(0, todo.length - sent) };
}

function genreFinding(b, v, known) {
  const before = [...(b.genre_ids || [])].sort((x, y) => x - y);
  const after = [...new Set(v.genre_ids)].sort((x, y) => x - y);
  const names = ids => ids.map(id => known.get(id)?.name || `#${id}`).join(', ') || 'none';
  return {
    kind: 'genre_suggest', area: 'genres', ref: `book:${b.id}`, source: 'ai', risk: v.confidence === 'high' ? 'low' : 'medium', safe: false,
    line: `Genre · "${clamp(b.title, 50)}" · ${names(before)} → ${names(after)}`,
    op: { op: 'book.genres', target: b.id, before, after },
  };
}

export async function classifyReviews(env, task, reviews) {
  const todo = [], findings = [];
  let cached = 0;
  for (const r of reviews) {
    if (String(r.comment || '').trim().length < 3) continue;
    const fp = await sha256Hex(`${r.rating}|${r.comment}`);
    const hit = await cacheGet(env, `review:${r.id}`, fp);
    if (hit) { cached++; if (hit.label !== 'ok') findings.push(reviewFinding(r, hit.label)); continue; }
    todo.push({ r, fp });
  }
  let sent = 0, n = 0;
  const { batches } = opsBudgets(env);
  for (let i = 0; i < todo.length && n < batches; i += REVIEW_BATCH, n++) {
    if (!await budgetLeft(env)) break;
    const part = todo.slice(i, i + REVIEW_BATCH);
    const items = await ask(env, task, 'classify_reviews', n, { reviews: part.map(x => x.r) });
    if (!items) break;
    sent += part.length;
    const byId = new Map(items.map(it => [Number(it.id), it.label]));
    for (const { r, fp } of part) {
      const label = ['spam', 'offensive'].includes(byId.get(r.id)) ? byId.get(r.id) : 'ok';
      await cachePut(env, `review:${r.id}`, fp, { label });
      if (label !== 'ok') findings.push(reviewFinding(r, label));
    }
  }
  return { findings, sent, cached, skipped: Math.max(0, todo.length - sent) };
}
const reviewFinding = (r, label) => ({ kind: 'review_flag', area: 'reviews', ref: `review:${r.id}`, source: 'ai', risk: label === 'offensive' ? 'high' : 'medium', safe: false,
  line: `Review #${r.id} (${r.rating}★) · ${label} · "${clamp(r.comment, 60)}"`, op: null });

