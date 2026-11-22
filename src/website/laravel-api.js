// Client for the restricted BookShareKH Laravel API (installed in the website repository).
// Contract (all JSON, Bearer token with scoped abilities):
//   GET /api/ai/health                     -> { ok, app, laravel, php, time }
//   GET /api/ai/books?latest=N             -> { data: [{ id, title, author, status, created_at }] }
//   GET /api/ai/books/search?q=...         -> { data: [...] }
// Write endpoints (drafts, metadata, files, publish) are added after the real Book model is inspected,
// and every write goes through an owner approval in the Worker first.
import { clamp } from '../helpers.js';

const TIMEOUT_MS = 10000;

export class WebsiteApiError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; } // not_configured | auth | not_installed | rate_limit | server | timeout | network | bad_response
}

export const apiConfigured = env => Boolean(env.LARAVEL_API_URL && env.LARAVEL_API_TOKEN);

async function get(env, path, params = {}) {
  if (!apiConfigured(env)) throw new WebsiteApiError('The Laravel API is not connected yet (LARAVEL_API_URL / LARAVEL_API_TOKEN).', 'not_configured');
  const url = new URL(`${String(env.LARAVEL_API_URL).replace(/\/+$/, '')}${path}`);
  if (url.protocol !== 'https:') throw new WebsiteApiError('LARAVEL_API_URL must use https', 'not_configured');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  let r;
  try {
    r = await fetch(url, { headers: { Authorization: `Bearer ${String(env.LARAVEL_API_TOKEN).trim()}`, Accept: 'application/json', 'User-Agent': 'BookShareKH-AI-Manager' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new WebsiteApiError(e?.name === 'TimeoutError' ? 'Website API timed out' : `Website API network error: ${clamp(e?.message, 80)}`, e?.name === 'TimeoutError' ? 'timeout' : 'network');
  }
  if (r.status === 401 || r.status === 403) throw new WebsiteApiError(`Website API refused the token (HTTP ${r.status}). Create a new token in Laravel and run \`npx wrangler secret put LARAVEL_API_TOKEN\`.`, 'auth');
  if (r.status === 404) throw new WebsiteApiError('Website API endpoint not found (HTTP 404): the AI API is not installed on the site yet.', 'not_installed');
  if (r.status === 429) throw new WebsiteApiError('Website API rate limit reached; try again shortly.', 'rate_limit');
  if (r.status >= 500) throw new WebsiteApiError(`Website API error (HTTP ${r.status}).`, 'server');
  const body = await r.json().catch(() => null);
  if (!r.ok || !body) throw new WebsiteApiError(`Unexpected website API response (HTTP ${r.status}).`, 'bad_response');
  return body;
}

const listOf = body => (Array.isArray(body?.data) ? body.data : []).slice(0, 20).map(b => ({
  id: b.id, title: clamp(b.title, 120), author: clamp(b.author, 80), status: clamp(b.status, 20), created_at: clamp(b.created_at, 25),
}));

export const apiHealth = env => get(env, '/api/ai/health');
export async function latestBooks(env, n = 5) { return listOf(await get(env, '/api/ai/books', { latest: Math.min(Math.max(n, 1), 20) })); }
export async function searchBooks(env, q) { return listOf(await get(env, '/api/ai/books/search', { q: clamp(q, 100) })); }

export function formatBooks(books, heading) {
  if (!books.length) return `${heading}\n(no books found)`;
  return [heading, ...books.map(b => `• #${b.id} ${b.title}${b.author ? ` — ${b.author}` : ''}${b.status ? ` [${b.status}]` : ''}`)].join('\n');
}
