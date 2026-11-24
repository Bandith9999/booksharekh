// Client for the restricted BookShareKH Laravel API (installed in the website repository).
// Contract (all JSON, Bearer token with scoped abilities):
//   GET /api/ai/health                     -> { ok, app, laravel, php, time }
//   GET /api/ai/books?latest=N             -> { data: [{ id, title, author, status, created_at }] }
//   GET /api/ai/books/search?q=...         -> { data: [...] }
//   POST /api/ai/drafts, POST /api/ai/drafts/{id}/files, POST /api/ai/drafts/{id}/publish
//   GET /api/ai/requests?after_id=N, GET|PATCH /api/ai/requests/{id}
// Every write is preceded by an owner approval in the Worker.
import { clamp } from '../helpers.js';

const TIMEOUT_MS = 10000;
const RETRYABLE = new Set(['rate_limit', 'server', 'timeout', 'network']);

export class WebsiteApiError extends Error {
  // kind: not_configured | auth | not_installed | rejected | rate_limit | server | timeout | network | bad_response
  constructor(message, kind) { super(message); this.kind = kind; }
  get retryable() { return RETRYABLE.has(this.kind); }
}

export const apiConfigured = env => Boolean(env.LARAVEL_API_URL && env.LARAVEL_API_TOKEN);

async function call(env, method, path, { params = {}, json, form, timeout = TIMEOUT_MS, raw = false, accept = [] } = {}) {
  if (!apiConfigured(env)) throw new WebsiteApiError('The Laravel API is not connected yet (LARAVEL_API_URL / LARAVEL_API_TOKEN).', 'not_configured');
  const url = new URL(`${String(env.LARAVEL_API_URL).replace(/\/+$/, '')}${path}`);
  if (url.protocol !== 'https:') throw new WebsiteApiError('LARAVEL_API_URL must use https', 'not_configured');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const headers = { Authorization: `Bearer ${String(env.LARAVEL_API_TOKEN).trim()}`, Accept: 'application/json', 'User-Agent': 'BookShareKH-AI-Manager' };
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form; // multipart; fetch sets the boundary
  let r;
  try {
    r = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    throw new WebsiteApiError(e?.name === 'TimeoutError' ? 'Website API timed out' : `Website API network error: ${clamp(e?.message, 80)}`, e?.name === 'TimeoutError' ? 'timeout' : 'network');
  }
  if (r.status === 401 || r.status === 403) {
    // Tell apart: Laravel refusing the key (JSON {error}) vs Cloudflare/firewall blocking before Laravel (HTML).
    const text = await r.text().catch(() => '');
    let laravel = null;
    try { laravel = JSON.parse(text)?.error ?? null; } catch { /* not JSON: blocked before Laravel */ }
    const fix = 'Create a key with all abilities (php artisan ai:token ... see README) and run `npx wrangler secret put LARAVEL_API_TOKEN`.';
    if (laravel) throw new WebsiteApiError(`Website API refused the key (HTTP ${r.status}: ${clamp(laravel, 100)}). ${fix}`, 'auth');
    const byCloudflare = /cloudflare|error code: 10\d\d/i.test(text) || r.headers.get('cf-mitigated');
    throw new WebsiteApiError(`The request was blocked before reaching Laravel (HTTP ${r.status}, ${byCloudflare ? 'by Cloudflare' : 'by the server firewall'}): ${clamp(text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '), 100)}`, 'blocked');
  }
  if (r.status === 404) throw new WebsiteApiError('Website API endpoint not found (HTTP 404): the AI API is not installed on the site yet.', 'not_installed');
  if (r.status === 429) throw new WebsiteApiError('Website API rate limit reached; try again shortly.', 'rate_limit');
  if (r.status >= 500) throw new WebsiteApiError(`Website API error (HTTP ${r.status}).`, 'server');
  if (raw && r.ok) return r;
  const res = await r.json().catch(() => null);
  // Callers that handle refusals themselves (Website Operations) get { http, ...body }.
  if (accept.includes(r.status) && res) return { http: r.status, ...res };
  // 409/422: the site refused the request (duplicate, rights, changed files); never retried.
  if (r.status === 409 || r.status === 422) throw new WebsiteApiError(`Website refused: ${clamp(res?.error || res?.message || `HTTP ${r.status}`, 200)}`, 'rejected');
  if (!r.ok || !res) throw new WebsiteApiError(`Unexpected website API response (HTTP ${r.status}).`, 'bad_response');
  return res;
}
const get = (env, path, params) => call(env, 'GET', path, { params });

export const createDraft = (env, body) => call(env, 'POST', '/api/ai/drafts', { json: body });
export function uploadDraftFile(env, draftId, type, bytes, filename, mime) {
  const form = new FormData();
  form.set('type', type);
  form.set('file', new Blob([bytes], { type: mime }), filename);
  return call(env, 'POST', `/api/ai/drafts/${Number(draftId)}/files`, { form, timeout: 120000 });
}
export const publishDraft = (env, draftId, body) => call(env, 'POST', `/api/ai/drafts/${Number(draftId)}/publish`, { json: body, timeout: 60000 });
export const listRequests = (env, afterId = 0) => get(env, '/api/ai/requests', { after_id: Number(afterId) || 0 });
export const getRequest = async (env, id) => (await get(env, `/api/ai/requests/${Number(id)}`)).request;
export const updateRequest = (env, id, body) => call(env, 'PATCH', `/api/ai/requests/${Number(id)}`, { json: body });
// Top-ups (abilities topups:read / topups:approve). Approve/reject send the exact amount and
// transaction ID the owner saw; the site refuses (409) if the record changed or was already decided.
export const listTopups = (env, afterId = 0, pendingOnly = false) =>
  get(env, '/api/ai/topups', { after_id: Number(afterId) || 0, ...(pendingOnly ? { status: 'pending' } : {}) });
// Sign-ups/sign-ins since a site-time timestamp (or the last N hours) + total users (ability users:read).
// Book purchases after an id (ability users:read): buyer email, user name, book title.
export const listPurchases = (env, afterId = 0) => get(env, '/api/ai/purchases', { after_id: Number(afterId) || 0 });
export const userActivity =(env, since) => get(env, '/api/ai/users/activity', typeof since === 'number' ? { hours: since } : { since });
export const topupImage =(env, id) => call(env, 'GET', `/api/ai/topups/${Number(id)}/image`, { raw: true, timeout: 20000 });
export const approveTopup = (env, id, body) => call(env, 'POST', `/api/ai/topups/${Number(id)}/approve`, { json: body });
export const rejectTopup = (env, id, body) => call(env, 'POST', `/api/ai/topups/${Number(id)}/reject`, { json: body });

const listOf = body => (Array.isArray(body?.data) ? body.data : []).slice(0, 20).map(b => ({
  id: b.id, title: clamp(b.title, 120), author: clamp(b.author, 80), status: clamp(b.status, 20), created_at: clamp(b.created_at, 25),
}));

export const apiHealth = env => get(env, '/api/ai/health');
// One public image file from the site through the AI API (the site's firewall blocks GitHub servers).
export const mediaFile = (env, path) => call(env, 'GET', '/api/ai/media/file', { params: { path }, raw: true, timeout: 20000 });
// Public marketing images on the site (logo, backgrounds, banners; never payment/QR images).
// Before the website has /api/ai/media, the two images every page uses are offered.
const KNOWN_MEDIA = ['dist/img/logo/logo.png', 'dist/img/library-bg.jpg'];
export async function siteMedia(env) {
  const base = String(env.LARAVEL_API_URL || env.WEBSITE_URL || 'https://booksharekh.com').replace(/\/+$/, '');
  const host = new URL(base).host;
  try {
    const body = await get(env, '/api/ai/media');
    return (Array.isArray(body?.data) ? body.data : [])
      .filter(m => { try { const u = new URL(m.url); return u.protocol === 'https:' && u.host === host; } catch { return false; } })
      .slice(0, 40).map(m => ({ name: clamp(m.name, 120), url: clamp(m.url, 400), width: Number(m.width) || null, height: Number(m.height) || null }));
  } catch (e) {
    if (e instanceof WebsiteApiError && e.kind === 'not_installed') return KNOWN_MEDIA.map(name => ({ name, url: `${base}/${name}`, width: null, height: null }));
    throw e;
  }
}
// Books for promo videos: kind 'popular' (most viewed) or 'latest', with cover, link, views, description.
export async function promoBooks(env, kind, n = 10) {
  const body = await get(env, '/api/ai/books', { [kind === 'popular' ? 'popular' : 'latest']: n, promo: 1 });
  return Array.isArray(body?.data) ? body.data.slice(0, 20) : [];
}
export async function latestBooks(env, n = 5) { return listOf(await get(env, '/api/ai/books', { latest: Math.min(Math.max(n, 1), 20) })); }
export async function searchBooks(env, q) { return listOf(await get(env, '/api/ai/books/search', { q: clamp(q, 100) })); }
// Search with the promo fields (cover). Books without a cover are dropped by the caller.
export async function searchPromoBooks(env, q) {
  const body = await get(env, '/api/ai/books/search', { q: clamp(q, 100), promo: 1 });
  return Array.isArray(body?.data) ? body.data.slice(0, 20) : [];
}

export function formatBooks(books, heading, empty = '(no books found)') {
  if (!books.length) return `${heading}\n${empty}`;
  return [heading, ...books.map(b => `• #${b.id} ${b.title}${b.author ? ` — ${b.author}` : ''}${b.status ? ` [${b.status}]` : ''}`)].join('\n');
}

// ---- Website Operations (abilities ops:read / ops:write) ----
// Read-only inspection pages and SQL statistics; apply/rollback run only owner-approved changes.
export const opsBooks = (env, afterId = 0, limit = 200) => get(env, '/api/ai/ops/books', { after_id: Number(afterId) || 0, limit });
export const opsTaxonomy = env => get(env, '/api/ai/ops/taxonomy');
export const opsReviews = (env, afterId = 0, limit = 300) => get(env, '/api/ai/ops/reviews', { after_id: Number(afterId) || 0, limit });
export const opsMedia = env => get(env, '/api/ai/ops/media');
export const opsStats = env => get(env, '/api/ai/ops/stats');
// Returns { http, status: applied|conflict|invalid, changes, conflicts } (409/422 are answers, not errors).
export const opsApply = (env, approvalId, ops) => call(env, 'POST', '/api/ai/ops/apply', { json: { approval_id: approvalId, ops }, timeout: 60000, accept: [200, 409, 422] });
export const opsRollback = (env, approvalId) => call(env, 'POST', '/api/ai/ops/rollback', { json: { approval_id: approvalId }, timeout: 60000, accept: [200, 409] });
