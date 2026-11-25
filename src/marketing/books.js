// Books from the site that posters and videos may show or talk about: matches for the owner's topic
// first, then popular and new books not used recently, then the least recently used.
import { clamp } from '../helpers.js';
import { promoBooks, searchPromoBooks } from '../website/laravel-api.js';

// Words to search the site for: the topic minus filler words (English); Khmer words if the runtime can split them.
const STOP = new Set('about with that this these those from into poster posters design designs designe make create please book books best good some your their them there have want need like show list topic ideas idea month week video videos clip reel'.split(' '));
const KM_STOP = new Set(['សៀវភៅ', 'អំពី', 'សម្រាប់', 'ដែល', 'និង', 'ក្បាល', 'ធ្វើ', 'បង្កើត', 'រចនា', 'ផ្សព្វផ្សាយ', 'វីដេអូ']);
export function topicKeywords(topic = '') {
  const t = String(topic).toLowerCase();
  const words = (t.match(/[a-z][a-z'-]{3,}/g) || []).filter(w => !STOP.has(w)).map(w => (w.length > 5 && w.endsWith('s') ? w.slice(0, -1) : w));
  try {
    for (const s of new Intl.Segmenter('km', { granularity: 'word' }).segment(t)) {
      if (s.isWordLike && /[ក-៿]/.test(s.segment) && s.segment.length >= 3 && !KM_STOP.has(s.segment)) words.push(s.segment);
    }
  } catch { /* no Khmer word splitting here */ }
  return [...new Set(words)].slice(0, 3);
}

// used: { book id: time last used }. Every book has an https cover.
export async function bookCandidates(env, topic = '', used = {}) {
  const n = topic ? 20 : 16;
  const searches = topic ? await Promise.all(topicKeywords(topic).map(k => searchPromoBooks(env, k).catch(() => []))) : [];
  const [popular, latest] = await Promise.all([promoBooks(env, 'popular', n), promoBooks(env, 'latest', n)]);
  const seen = new Set(), all = [];
  for (const [list, kind] of [...searches.map(l => [l, 'match']), [popular, 'popular'], [latest, 'new']]) {
    for (const b of list) {
      const id = Number(b.id);
      if (!/^https:\/\//.test(b?.cover_url || '') || seen.has(id)) continue;
      seen.add(id);
      all.push({ id, kind, title: clamp(b.title, 90), author: clamp(b.author || '', 60), cover_url: clamp(b.cover_url, 400) });
    }
  }
  const match = all.filter(b => b.kind === 'match');
  const rest = all.filter(b => b.kind !== 'match');
  const fresh = rest.filter(b => !used[b.id]);
  const old = rest.filter(b => used[b.id]).sort((a, b) => used[a.id] - used[b.id]); // least recently used first
  return [...match, ...fresh, ...old].slice(0, topic ? 30 : 24);
}

// The AI's book choice, kept only if every id is a real candidate (max 3); filled up to `min` from the candidates.
export function chosenCovers(candidates = [], ids = [], min = 0) {
  const byId = new Map(candidates.map(c => [c.id, c]));
  const out = [];
  for (const id of ids || []) { const c = byId.get(Number(id)); if (c && !out.includes(c)) out.push(c); }
  for (const c of candidates) { if (out.length >= min) break; if (!out.includes(c)) out.push(c); }
  return out.slice(0, 3);
}

export const booksForPrompt = c => c.map(b => `${b.id} — ${b.title}${b.author ? ` — ${b.author}` : ''} (${b.kind})`).join('\n') || '(none)';
