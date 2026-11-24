// Website Operations: rule-based checks (plain code, no AI). Input = data from /api/ai/ops/*;
// output = findings. A finding is one line for Telegram, optionally with ONE exact change (op) for
// /api/ai/ops/apply. Rules never invent data: missing descriptions, publishers, covers or files are
// reported, never filled in. Deleting and merging are never proposed (not supported / not allowed).
import { clamp } from '../helpers.js';
import { OPS_EN } from './i18n.js';

const q = s => `"${clamp(String(s ?? ''), 60)}"`;
const tidy = s => String(s ?? '').replace(/\s+/g, ' ').trim();
// Comparison key: case, spaces, punctuation and a plural "s" do not matter.
export const normKey = s => tidy(s).toLowerCase().normalize('NFKC').replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, '').replace(/s$/, '');
const latin = s => /^[\x20-\x7E]+$/.test(s);
const titleCase = s => s.toLowerCase().replace(/(^|[\s\-(/])(\p{L})/gu, (m, p, c) => p + c.toUpperCase());
// Generic catch-all genres: a book that only has one of these is worth classifying.
export const GENERIC_GENRES = new Set(['general', 'other', 'others', 'misc', 'miscellaneou', 'uncategorized', 'uncategorised', 'unknown', 'ទូទៅ', 'ផ្សេងៗ'].map(normKey));
const YT_URL = /^https:\/\/(www\.|m\.)?(youtube\.com\/(watch\?v=|embed\/|shorts\/|playlist\?list=)|youtu\.be\/)[\w-]{6,}/;
export const YT_ID = /^[\w-]{11}$/;

const f = (kind, area, ref, line, extra = {}) => ({ kind, area, ref, line, op: null, risk: 'low', safe: false, ...extra });

// ---------- books ----------
export function checkBooks(books, taxonomy, L = OPS_EN) {
  const out = [];
  const genreName = new Map((taxonomy.genres || []).map(g => [g.id, g.name]));
  const bookCategories = (taxonomy.categories || []).filter(c => c.type === 'book');
  const catById = new Map((taxonomy.categories || []).map(c => [c.id, c]));
  const missing = { description: [], publisher: [], edition: [], publish_date: [] };
  const byKey = new Map();

  for (const b of books) {
    const ref = `book:${b.id}`;
    const name = q(b.title);
    // Title: spacing is fixed safely; ALL CAPS gets a proposal the owner must check.
    if (b.title && tidy(b.title) !== b.title) {
      out.push(f('title_spacing', 'books', ref, L.title_spacing(q(b.title), q(tidy(b.title))),
        { op: { op: 'book.set', target: b.id, field: 'title', before: b.title, after: tidy(b.title) }, safe: true }));
    } else if (b.title && latin(b.title) && b.title.length > 4 && b.title === b.title.toUpperCase() && /[A-Z]{3}/.test(b.title)) {
      out.push(f('title_caps', 'books', ref, L.title_caps(q(b.title), q(titleCase(b.title))),
        { op: { op: 'book.set', target: b.id, field: 'title', before: b.title, after: titleCase(b.title) }, risk: 'medium' }));
    }
    if (!b.title || !tidy(b.title)) out.push(f('title_missing', 'books', ref, L.title_missing(b.id), { risk: 'high' }));
    if (!b.author_id || !tidy(b.author)) out.push(f('author_missing', 'books', ref, L.author_missing(name), { risk: 'medium' }));
    for (const k of Object.keys(missing)) if (k === 'description' ? (b.description_length || 0) < 20 : !tidy(b[k])) missing[k].push(b);
    // Files: reported only (the owner uploads them in the dashboard).
    if (!b.cover?.ok) out.push(f(b.cover?.path ? 'cover_broken' : 'cover_missing', 'files', ref, (b.cover?.path ? L.cover_broken : L.cover_missing)(name), { risk: 'medium' }));
    const files = b.files || [];
    if (!files.length) out.push(f('file_missing', 'files', ref, L.file_missing(name), { risk: 'high' }));
    for (const x of files.filter(x => !x.ok)) out.push(f('file_broken', 'files', `${ref}:${x.type}`, L.file_broken(String(x.type).toUpperCase(), name), { risk: 'high' }));
    if (b.youtube_link && !YT_URL.test(b.youtube_link)) {
      out.push(f('youtube_invalid', 'books', ref, L.youtube_invalid(name, clamp(b.youtube_link, 50)),
        { op: { op: 'detail.set', target: b.id, field: 'youtube_link', before: b.youtube_link, after: null }, risk: 'medium' }));
    }
    // Category: one obvious choice (the only book category) is proposed; anything else is reported.
    const cat = b.category_id ? catById.get(b.category_id) : null;
    if (!b.category_id && bookCategories.length === 1) {
      out.push(f('category_missing', 'categories', ref, L.category_to(name, q(bookCategories[0].name)),
        { op: { op: 'book.category', target: b.id, before: null, after: bookCategories[0].id }, safe: true }));
    } else if (!b.category_id) out.push(f('category_missing', 'categories', ref, L.category_missing(name)));
    else if (cat && cat.type !== 'book') out.push(f('category_wrong_type', 'categories', ref, L.category_wrong_type(q(cat.name), cat.type, name), { risk: 'medium' }));
    // Genres: none, or only a catch-all genre → the AI suggests (see ops/ai.js); unknown ids are reported.
    const unknown = (b.genre_ids || []).filter(id => !genreName.has(id));
    if (unknown.length) out.push(f('genre_unknown', 'genres', ref, L.genre_unknown(unknown.join(', '), name), { risk: 'medium' }));
    // Duplicates: same title and author.
    const key = `${normKey(b.title)}|${normKey(b.author)}`;
    if (normKey(b.title)) byKey.set(key, [...(byKey.get(key) || []), b]);
  }
  for (const [k, list] of Object.entries(missing)) {
    if (!list.length) continue;
    const label = L.fields[k];
    // One line per field (counts), with the first titles; never filled in automatically.
    out.push(f(`missing_${k}`, 'books', `field:${k}:${list.length}`, L.missing_field(label, list.length, `${list.slice(0, 3).map(b => q(b.title)).join(', ')}${list.length > 3 ? ' …' : ''}`),
      { risk: k === 'description' ? 'medium' : 'low', count: list.length }));
  }
  for (const list of byKey.values()) {
    if (list.length > 1) out.push(f('book_duplicate', 'books', `books:${list.map(b => b.id).join(',')}`, L.book_duplicate(q(list[0].title), list.map(b => b.id).join(', #')), { risk: 'medium' }));
  }
  return out;
}

// ---------- genres, categories, authors ----------
export function checkTaxonomy(taxonomy, L = OPS_EN) {
  const out = [];
  const genres = taxonomy.genres || [];
  const byKey = new Map();
  for (const g of genres) byKey.set(normKey(g.name), [...(byKey.get(normKey(g.name)) || []), g]);
  for (const g of genres) {
    const ref = `genre:${g.id}`;
    const clash = (byKey.get(normKey(g.name)) || []).length > 1;
    if (tidy(g.name) !== g.name && !clash && !genres.some(o => o.id !== g.id && o.name === tidy(g.name))) {
      out.push(f('genre_spacing', 'genres', ref, L.genre_spacing(q(g.name), q(tidy(g.name))),
        { op: { op: 'genre.rename', target: g.id, before: g.name, after: tidy(g.name) }, safe: true }));
    } else if (latin(g.name) && g.name === g.name.toLowerCase() && /[a-z]{3}/.test(g.name) && !clash) {
      out.push(f('genre_case', 'genres', ref, L.genre_case(q(g.name), q(titleCase(tidy(g.name)))),
        { op: { op: 'genre.rename', target: g.id, before: g.name, after: titleCase(tidy(g.name)) } }));
    }
    if (!g.books) out.push(f('genre_unused', 'genres', ref, L.genre_unused(q(g.name))));
  }
  for (const list of byKey.values()) {
    if (list.length > 1) out.push(f('genre_duplicate', 'genres', `genres:${list.map(g => g.id).join(',')}`, L.genre_duplicate(list.map(g => `${q(g.name)} (${g.books})`).join(' · ')), { risk: 'medium' }));
  }
  for (const c of taxonomy.categories || []) {
    if (c.type === 'book' && !c.books) out.push(f('category_unused', 'categories', `category:${c.id}`, L.category_unused(q(c.name))));
  }
  // Authors: spacing is safe; lowercase names are proposals; similar names are reported, never merged.
  const authors = taxonomy.authors || [];
  const aKey = new Map();
  for (const a of authors) aKey.set(normKey(a.name), [...(aKey.get(normKey(a.name)) || []), a]);
  for (const a of authors) {
    const ref = `author:${a.id}`;
    const clash = authors.some(o => o.id !== a.id && o.name === tidy(a.name));
    if (tidy(a.name) !== a.name && !clash) {
      out.push(f('author_spacing', 'authors', ref, L.author_spacing(q(a.name), q(tidy(a.name))),
        { op: { op: 'author.rename', target: a.id, before: a.name, after: tidy(a.name) }, safe: true }));
    } else if (latin(a.name) && /[a-z]{2}/.test(a.name) && a.name.split(' ').some(w => /^[a-z]/.test(w)) && (aKey.get(normKey(a.name)) || []).length === 1) {
      const fixed = titleCase(tidy(a.name));
      if (fixed !== a.name && !authors.some(o => o.name === fixed)) {
        out.push(f('author_case', 'authors', ref, L.author_case(q(a.name), q(fixed)),
          { op: { op: 'author.rename', target: a.id, before: a.name, after: fixed } }));
      }
    }
  }
  for (const list of aKey.values()) {
    if (list.length > 1) out.push(f('author_duplicate', 'authors', `authors:${list.map(a => a.id).join(',')}`, L.author_duplicate(list.map(a => `${q(a.name)} (#${a.id})`).join(' · ')), { risk: 'medium' }));
  }
  return out;
}

// ---------- reviews (rules; the AI only looks at new reviews the rules did not flag) ----------
const BAD_WORDS = /\b(fuck|shit|bitch|bastard|asshole|dick|cunt|slut|whore)\w*/i;
const LINK = /(https?:\/\/|www\.|t\.me\/|bit\.ly)/i;
export function checkReviews(reviews, L = OPS_EN) {
  const out = [];
  const byText = new Map();
  for (const r of reviews) {
    const t = normKey(r.comment);
    if (t.length >= 8) byText.set(t, [...(byText.get(t) || []), r]);
  }
  const repeated = new Set([...byText.values()].filter(l => l.length >= 3).flat().map(r => r.id));
  const flagged = new Set();
  for (const r of reviews) {
    const key = LINK.test(r.comment) ? 'link' : BAD_WORDS.test(r.comment) ? 'offensive' : repeated.has(r.id) ? 'repeated' : null;
    const why = key && L.review_why[key];
    if (!why) continue;
    flagged.add(r.id);
    out.push(f('review_flag', 'reviews', `review:${r.id}`, L.review_flag(r.id, r.rating, why, q(r.comment)), { risk: key === 'offensive' ? 'high' : 'medium' }));
  }
  return { findings: out, flagged };
}

// ---------- audiobooks, videos, playlists, channels ----------
export function checkMedia(media, L = OPS_EN) {
  const out = [];
  const videoIds = new Map();
  for (const [kind, list] of [['audiobook', media.audiobooks || []], ['video', media.videos || []]]) {
    for (const m of list) {
      const ref = `${kind}:${m.id}`;
      if (!tidy(m.title)) out.push(f('media_no_title', 'media', ref, L.media_no_title(kind, m.id)));
      if (!YT_ID.test(String(m.youtube_video_id || ''))) out.push(f('media_bad_youtube', 'media', ref, L.media_bad_youtube(kind, m.id, q(m.youtube_video_id)), { risk: 'medium' }));
      else videoIds.set(m.youtube_video_id, [...(videoIds.get(m.youtube_video_id) || []), ref]);
      if (kind === 'audiobook' && !tidy(m.description)) out.push(f('media_no_description', 'media', ref, L.media_no_description(q(m.title || m.id))));
    }
  }
  for (const [id, refs] of videoIds) if (refs.length > 1) out.push(f('media_duplicate', 'media', `yt:${id}`, L.media_duplicate(refs.length, refs.join(', '))));
  const channels = new Set((media.channels || []).map(c => Number(c.id)));
  const cats = media.video_categories || {};
  for (const p of media.playlists || []) {
    if (p.channel_id && !channels.has(Number(p.channel_id))) out.push(f('media_bad_channel', 'media', `playlist:${p.id}`, L.media_bad_channel(q(p.title), p.channel_id), { risk: 'medium' }));
    if (p.category_id && cats[p.category_id] === 'book') out.push(f('media_bad_category', 'media', `playlist:${p.id}`, L.media_bad_category(q(p.title))));
  }
  return { findings: out, youtubeIds: [...videoIds.keys()] };
}

// ---------- book requests vs the catalog ----------
export function checkRequests(requests, books, L = OPS_EN) {
  const out = [];
  const byTitle = new Map(books.filter(b => normKey(b.title)).map(b => [normKey(b.title), b]));
  const seen = new Map();
  for (const r of requests) {
    if (r.status !== 'pending') continue;
    const k = normKey(r.book_title);
    const hit = k ? byTitle.get(k) : null;
    if (hit) {
      out.push(f('request_available', 'requests', `request:${r.id}`, L.request_available(r.id, q(r.book_title)),
        { op: { op: 'request.status', target: r.id, before: 'pending', after: 'done', note: L.request_note(clamp(hit.title, 150)) }, safe: true }));
    }
    if (k) seen.set(k, [...(seen.get(k) || []), r.id]);
  }
  for (const ids of seen.values()) if (ids.length > 1) out.push(f('request_duplicate', 'requests', `requests:${ids.join(',')}`, L.request_duplicate(ids.join(', #'))));
  return out;
}

// ---------- books the AI should classify (no genre, or only a catch-all genre) ----------
export function genreCandidates(books, taxonomy) {
  const name = new Map((taxonomy.genres || []).map(g => [g.id, g.name]));
  return books.filter(b => {
    const ids = (b.genre_ids || []).filter(id => name.has(id));
    return !ids.length || ids.every(id => GENERIC_GENRES.has(normKey(name.get(id))));
  });
}

// ---------- developer recommendations (from the data, never repeated once decided) ----------
export function devRecommendations({ findings, stats }, L = OPS_EN) {
  const has = k => findings.some(x => x.kind === k);
  const recs = [];
  // Texts from ops/i18n.js; the arguments below are only the English fallback for unknown keys.
  const add = (key, feature, reason, priority, n) => {
    const [ft, rs] = L.dev[key] || [feature, reason];
    const why = typeof rs === 'function' ? rs(n) : rs;
    recs.push(f(`dev:${key}`, 'dev', `dev:${key}`, `${ft} · ${why} · ${L.priority[priority] || priority}`, { feature: ft, reason: why, priority }));
  };
  if (has('genre_duplicate') || has('genre_unused')) add('genre_management', 'Genre merge and delete', 'duplicate or unused genres cannot be cleaned in the dashboard', 'Medium');
  if (has('author_duplicate')) add('author_merge', 'Author duplicate management', 'similar authors cannot be merged in the dashboard', 'Medium');
  if ((stats?.books_deleted || 0) > 0) add('restore_books', 'Restore deleted books', '', 'Low', stats.books_deleted);
  if ((stats?.table_rows?.tags || 0) > 0) add('tag_management', 'Tag management', 'tags exist but have no admin screen', 'Low');
  if (stats?.table_rows && stats.table_rows.favorites != null) add('favourites', 'Favourites and reading lists', 'tables exist but readers cannot use them yet', 'Medium');
  if (stats?.table_rows && stats.table_rows.book_reports != null) add('book_reports', 'Book reporting', 'readers cannot report broken books yet', 'Low');
  if (stats?.popular?.length) add('featured_books', 'Featured and recommended books', 'the homepage only sorts by views', 'Medium');
  add('dashboard_analytics', 'Admin dashboard analytics', 'the dashboard has no statistics', 'Medium');
  if (findings.filter(x => x.area === 'genres' || x.kind.startsWith('category')).length >= 5) add('bulk_genre_edit', 'Bulk genre editing', 'many books need genre changes one by one', 'Medium');
  return recs;
}
