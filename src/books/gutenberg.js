// Public-domain book source: Project Gutenberg, searched through the Gutendex API.
// Only titles Gutenberg marks copyright:false (public domain in the USA) with an EPUB are offered,
// and files are only ever downloaded from gutenberg.org over HTTPS.
import { clamp } from '../helpers.js';

const API = 'https://gutendex.com/books';
const UA = { 'User-Agent': 'BookShareKH-AI-Manager/1.0 (+https://booksharekh.com)' };
const ALLOWED_FILE_HOSTS = /(^|\.)gutenberg\.org$/;

// "Melville, Herman" -> "Herman Melville"
const personName = n => (/^[^,]+,\s*[^,]+$/.test(n || '') ? n.split(/,\s*/).reverse().join(' ') : (n || 'Unknown'));
// "Whaling -- Fiction" -> "Whaling"
const genresOf = subjects => [...new Set((subjects || []).map(s => clamp(s.split(' -- ')[0].trim(), 50)).filter(Boolean))].slice(0, 3);

export function safeFileUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:') u.protocol = 'https:';
    return u.protocol === 'https:' && ALLOWED_FILE_HOSTS.test(u.hostname) ? u.toString() : null;
  } catch { return null; }
}

function toCandidate(b) {
  if (!b || typeof b.id !== 'number') return null;
  const formats = b.formats || {};
  return {
    source: 'gutenberg',
    id: b.id,
    title: clamp(b.title, 250),
    author: clamp(personName(b.authors?.[0]?.name), 150),
    languages: (b.languages || []).slice(0, 3),
    genres: genresOf(b.subjects),
    description: b.summaries?.[0] ? clamp(b.summaries[0], 1500) : null,
    publicDomain: b.copyright === false,
    epubUrl: safeFileUrl(formats['application/epub+zip']),
    coverUrl: safeFileUrl(formats['image/jpeg']),
    pageUrl: `https://www.gutenberg.org/ebooks/${b.id}`,
  };
}

// The book source is down or slow (e.g. gutenberg.org maintenance). Retryable; shown to the owner as a short notice.
export class SourceDownError extends Error {
  constructor(detail) { super(`Book source unavailable (${detail})`); this.name = 'SourceDownError'; this.retryable = true; }
}

async function getJson(url) {
  let r;
  try { r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) }); }
  catch (e) { throw new SourceDownError(e?.name === 'TimeoutError' ? 'timeout' : 'network'); }
  if (r.status === 404) return null;
  if (r.status >= 500 || r.status === 429) throw new SourceDownError(`HTTP ${r.status}`);
  if (!r.ok) throw Object.assign(new Error(`Project Gutenberg search failed (HTTP ${r.status})`), { retryable: false });
  return r.json().catch(() => { throw new SourceDownError('bad response'); });
}

// English editions only by default (BOOK_LANGUAGES in wrangler.jsonc, e.g. "en" or "en,fr").
export async function searchPublicDomain(query, { limit = 3, languages = 'en' } = {}) {
  const langs = String(languages || 'en').split(',').map(l => l.trim().toLowerCase()).filter(l => /^[a-z]{2}$/.test(l));
  const body = await getJson(`${API}/?search=${encodeURIComponent(clamp(query, 120))}&languages=${langs.join(',')}`);
  return (body?.results || []).map(toCandidate)
    .filter(c => c?.publicDomain && c.epubUrl && c.languages.some(l => langs.includes(l))).slice(0, limit);
}

export async function getCandidate(id) {
  return toCandidate(await getJson(`${API}/${Number(id)}`));
}

// Download one file from gutenberg.org with a size cap. Returns Uint8Array.
export async function downloadFile(url, { maxBytes = 40 * 1024 * 1024 } = {}) {
  const safe = safeFileUrl(url);
  if (!safe) throw new Error('Refusing to download from a non-Gutenberg address');
  let r;
  try { r = await fetch(safe, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(60000) }); }
  catch (e) { throw Object.assign(new Error(`Download failed: ${clamp(e?.message, 80)}`), { retryable: true }); }
  if (!r.ok) throw Object.assign(new Error(`Download failed (HTTP ${r.status})`), { retryable: r.status >= 500 });
  if (r.url && !safeFileUrl(r.url)) throw new Error('Download was redirected away from gutenberg.org');
  if (Number(r.headers.get('content-length')) > maxBytes) throw new Error('File is larger than the 40 MB limit');
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error('File is larger than the 40 MB limit');
  return bytes;
}
