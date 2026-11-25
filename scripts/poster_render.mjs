// Renders one BookShareKH poster as a 4:5 portrait post (1080x1350). HTML → PNG with headless Chrome.
// Style (owner request 2026-11-25): a calm, editorial "book recommendation" card like bookstagram posts:
// a paper-coloured card, a hand-lettered heading, book covers with "Title by Author" and a short Khmer
// note about each book. No button and no website address on the image; only a small BookShareKH
// signature in the corner. The Content Creator AI picks the layout, palette, fonts and decoration.
//   node scripts/poster_render.mjs <job.json> <out.png>
// job: { layout, palette, font, body_font, decor, heading, quote, covers: [https urls],
//        books: [{ title, author, note }], logo_url }
// Text shrinks to fit its box (any font).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetchImage } from './fetch_image.mjs';
import { KHMER_FONTS, bodyFontOf, fontFaces, fontOf } from './khmer_fonts.mjs';

export const W = 1080, H = 1350;

const CHROMES = [process.env.CHROME, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Headless Chrome: HTML file → PNG (transparent where the page has no background). Also used by the video.
export function screenshot(htmlFile, outFile, w, h) {
  let err = '';
  for (const c of CHROMES) {
    if (c.includes('/') && !existsSync(c)) continue;
    const r = spawnSync(c, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--force-device-scale-factor=1',
      '--allow-file-access-from-files', '--default-background-color=00000000', `--window-size=${w},${h}`, '--virtual-time-budget=6000',
      `--screenshot=${resolve(outFile)}`, pathToFileURL(htmlFile).href], { encoding: 'utf8', timeout: 120000 });
    if (r.status === 0 && existsSync(outFile) && statSync(outFile).size > 1000) return;
    err = (r.stderr || r.error?.message || '').slice(-300);
  }
  throw new Error(`screenshot failed (${CHROMES.find(c => !c.includes('/') || existsSync(c)) || 'no Chrome found'}): ${err}`);
}
// Shrink each [data-fit] text until it fits its height and width (fonts differ a lot in size).
export const FIT_SCRIPT = `<script>
document.fonts.ready.then(() => {
  for (const el of document.querySelectorAll('[data-fit]')) {
    const max = Number(el.dataset.fit);
    let size = parseFloat(getComputedStyle(el).fontSize);
    while ((el.scrollHeight > max || el.scrollWidth > el.clientWidth + 1) && size > 18) { size -= 2; el.style.fontSize = size + 'px'; }
  }
});
</script>`;

// Video palettes (scripts/promo_render.mjs). light: dark text on a light background.
export const PALETTES = {
  brand_night: { bg1: '#264653', bg2: '#1f2a44', ink: '#ffffff', sub: '#e7edf3', a1: '#f27f6b', a2: '#b6d433', chipInk: '#1f2a44' },
  sunset: { bg1: '#ff7e5f', bg2: '#6a2c70', ink: '#ffffff', sub: '#ffe9e0', a1: '#ffd166', a2: '#ffffff', chipInk: '#6a2c70' },
  forest: { bg1: '#2d6a4f', bg2: '#081c15', ink: '#ffffff', sub: '#d8f3dc', a1: '#ffd166', a2: '#95d5b2', chipInk: '#081c15' },
  ocean: { bg1: '#0077b6', bg2: '#03045e', ink: '#ffffff', sub: '#caf0f8', a1: '#ffb703', a2: '#90e0ef', chipInk: '#03045e' },
  berry: { bg1: '#7209b7', bg2: '#3a0ca3', ink: '#ffffff', sub: '#f3e8ff', a1: '#f72585', a2: '#4cc9f0', chipInk: '#240046' },
  royal_gold: { bg1: '#16213e', bg2: '#0f0f1e', ink: '#fdf6e3', sub: '#e9dcc0', a1: '#e9c46a', a2: '#f4a261', chipInk: '#16213e' },
  cream_paper: { bg1: '#fbf5e9', bg2: '#f1e4c8', ink: '#2d2a26', sub: '#5b5248', a1: '#e76f51', a2: '#2a9d8f', chipInk: '#ffffff', light: true },
  peach: { bg1: '#ffe5d9', bg2: '#ffcad4', ink: '#3d405b', sub: '#5c5f7a', a1: '#e07a5f', a2: '#81b29a', chipInk: '#ffffff', light: true },
  mint: { bg1: '#e8f6ef', bg2: '#c7ebdc', ink: '#1d3557', sub: '#36506e', a1: '#e63946', a2: '#457b9d', chipInk: '#ffffff', light: true },
};

// ---------- poster design choices (keep in sync with POSTER_DESIGN in src/marketing/poster.js) ----------
// outer: page colour, card: the inner card, ink: headings, sub: notes, a1: accent, a2: soft accent.
export const POSTER_PALETTES = {
  cream: { outer: '#fbf6ee', card: '#f3ebdd', ink: '#1c1a17', sub: '#2f2b26', a1: '#c96f53', a2: '#e8c9a0' },
  sage: { outer: '#f1f4ed', card: '#e1e8da', ink: '#1f2a1f', sub: '#33402f', a1: '#5f7f5a', a2: '#c9d8b6' },
  blush: { outer: '#fcf1ef', card: '#f5dfdb', ink: '#2b1d1f', sub: '#43302f', a1: '#c8566b', a2: '#f0bcc4' },
  sky: { outer: '#f0f5f9', card: '#dde9f1', ink: '#14263a', sub: '#2c3f52', a1: '#3d6fa3', a2: '#b9d3e8' },
  lavender: { outer: '#f5f2f9', card: '#e6e0f0', ink: '#231c33', sub: '#3a3150', a1: '#7a5ea8', a2: '#cfc2e6' },
  sand: { outer: '#f8f1e6', card: '#ecdfc8', ink: '#2a2118', sub: '#45392b', a1: '#9c6b30', a2: '#d9bf8f' },
  night: { outer: '#161a24', card: '#212736', ink: '#f4efe6', sub: '#dcd5c9', a1: '#e9b872', a2: '#4a5670', dark: true },
};
export const LAYOUTS = ['list', 'single', 'quote'];
export const DECORS = ['none', 'frame', 'tape', 'sparkle'];
export const FONTS_KM = KHMER_FONTS; // heading fonts: scripts/khmer_fonts.mjs

// Through the AI Manager on the GitHub runner (the site's firewall blocks GitHub servers).
async function dataUri(url, maxBytes = 8 * 1024 * 1024) {
  const img = await fetchImage(url, maxBytes);
  return img ? `data:${img.type};base64,${img.bytes.toString('base64')}` : null;
}

// The card's inner area (the outer page shows as a margin around it, like the reference post).
const CARD = { top: 46, left: 46, right: W - 46, bottom: H - 64 };
const INNER = { left: CARD.left + 70, right: CARD.right - 70 };

const tape = (decor, w) => (decor === 'tape' ? `<span class="tape" style="left:${Math.round(w / 2 - 55)}px"></span>` : '');
const coverImg = (src, w, h, decor) => `<div class="cv" style="width:${w}px;height:${h}px"><img src="${src}">${tape(decor, w)}</div>`;
// "Title by Author" like the reference (book titles on the site are in Latin script).
const bookLine = (b = {}, fit) => `<div class="btitle" data-fit="${fit}">${esc(b.title || '')}${b.author ? ` <span class="by">by ${esc(b.author)}</span>` : ''}</div>`;

function decorHtml(decor, p) {
  switch (decor) {
    case 'frame': return `<div class="abs" style="top:${CARD.top + 22}px;left:${CARD.left + 22}px;right:${W - CARD.right + 22}px;bottom:${H - CARD.bottom + 22}px;border:2px solid ${p.a1};opacity:.45;border-radius:6px"></div>`;
    case 'sparkle': return [[92, 84, 30], [952, 96, 22], [960, 1210, 28], [96, 1226, 20]]
      .map(([x, y, s]) => `<div class="abs" style="left:${x}px;top:${y}px;font-size:${s}px;color:${p.a1};opacity:.8">✦</div>`).join('');
    default: return '';
  }
}

// ---------- layouts ----------
const TOP = 300; // content starts under the heading
const LAYOUT = {
  // 1-3 rows: cover on the left, "Title by Author" and a short note on the right (the reference post).
  list(j, c) {
    const n = Math.max(Math.min(c.length, 3), 1), area = CARD.bottom - 60 - TOP, rowH = Math.floor(area / n);
    const h = Math.min(rowH - 50, 400), w = Math.round(h / 1.5);
    return c.slice(0, 3).map((s, i) => {
      const b = j.books[i] || {};
      return `<div class="abs lrow" style="top:${TOP + i * rowH}px;height:${rowH - 40}px">${coverImg(s, w, h, j.decor)}
<div class="ltext">${bookLine(b, 130)}${b.note ? `<div class="note" data-fit="${Math.max(rowH - 190, 120)}">${esc(b.note)}</div>` : ''}</div></div>`;
    }).join('');
  },
  // One book in focus: a large cover, its title and a longer note below.
  single(j, c) {
    const b = j.books[0] || {};
    return `<div class="abs" style="top:${TOP}px;left:0;right:0;display:flex;justify-content:center">${c[0] ? coverImg(c[0], 400, 600, j.decor) : ''}</div>
<div class="abs col center" style="top:${TOP + 650}px;left:${INNER.left}px;right:${W - INNER.right}px">${bookLine(b, 110)}${b.note ? `<div class="note" data-fit="150">${esc(b.note)}</div>` : ''}</div>`;
  },
  // A motivational line in large type; up to 3 small covers below as "read next".
  quote(j, c) {
    const covers = c.slice(0, 3);
    const qBottom = covers.length ? 860 : CARD.bottom - 120;
    const row = covers.map(s => coverImg(s, 170, 255, j.decor)).join('');
    return `<div class="abs col center" style="top:${TOP - 20}px;left:${INNER.left}px;right:${W - INNER.right}px;height:${qBottom - TOP}px;justify-content:center">
<div class="qmark">“</div><div class="quote" data-fit="${qBottom - TOP - 110}">${esc(j.quote || '')}</div></div>
${covers.length ? `<div class="abs" style="top:${qBottom + 40}px;left:0;right:0;display:flex;justify-content:center;gap:48px">${row}</div>` : ''}`;
  },
};

export function posterHtml(job) {
  const p = POSTER_PALETTES[job.palette] || POSTER_PALETTES.cream;
  const f = fontOf(job.font, 'fasthand'), bf = bodyFontOf(job.body_font);
  const covers = (job.covers || []).filter(Boolean);
  let layout = LAYOUT[job.layout] ? job.layout : 'list';
  if (layout !== 'quote' && !covers.length) layout = 'quote'; // no cover could be loaded
  const j = { ...job, books: job.books || [], decor: DECORS.includes(job.decor) ? job.decor : 'none' };
  if (layout === 'quote' && !j.quote) j.quote = j.books.find(b => b.note)?.note || '';
  const sig = `<div class="abs sig">${job.logo ? `<img src="${job.logo}">` : ''}<span>BookShare<b>KH</b></span></div>`;
  return `<!doctype html><html lang="km"><head><meta charset="utf-8"><style>
${fontFaces([job.font, job.body_font, 'notoserif', 'fasthand'])}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${W}px;height:${H}px;overflow:hidden}
body{font-family:'${bf.family}','Noto Sans Khmer',sans-serif;color:${p.ink};position:relative;background:${p.outer}}
.abs{position:absolute}.col{display:flex;flex-direction:column}.center{align-items:center;text-align:center}
.card{top:${CARD.top}px;left:${CARD.left}px;width:${CARD.right - CARD.left}px;height:${CARD.bottom - CARD.top}px;background:${p.card}}
h1{position:absolute;top:${CARD.top + 70}px;left:${INNER.left}px;right:${W - INNER.right}px;height:170px;display:flex;align-items:center;justify-content:center;text-align:center;
  font-family:'${f.family}','Noto Sans Khmer',sans-serif;font-weight:400;font-size:${Math.round(84 * f.scale)}px;line-height:1.45;color:${p.ink}}
.lrow{left:${INNER.left - 10}px;right:${W - INNER.right}px;display:flex;align-items:center;gap:56px}
.cv{position:relative;flex:none}
.cv img{width:100%;height:100%;object-fit:cover;display:block;box-shadow:0 10px 26px rgba(0,0,0,${p.dark ? '.5' : '.22'}),0 2px 6px rgba(0,0,0,.12)}
.tape{position:absolute;top:-18px;width:110px;height:36px;background:${p.a2};opacity:.85;transform:rotate(-4deg)}
.ltext{flex:1;min-width:0}
.btitle{font-family:'Noto Serif Khmer','Hanuman',Georgia,'DejaVu Serif',serif;font-weight:700;font-size:42px;line-height:1.3;color:${p.ink};overflow:hidden}
.by{font-weight:600}
.note{font-size:38px;line-height:1.7;color:${p.sub};margin-top:14px;overflow:hidden}
.center .note{font-size:36px}
.qmark{font-family:Georgia,'DejaVu Serif',serif;font-size:170px;line-height:.8;height:96px;color:${p.a1};opacity:.85}
.quote{font-family:'${f.family}','Noto Sans Khmer',sans-serif;font-size:${Math.round(66 * f.scale)}px;line-height:1.65;color:${p.ink};overflow:hidden;width:100%}
.sig{right:${W - CARD.right + 6}px;bottom:14px;display:flex;align-items:center;gap:10px;opacity:.6;font-family:'Poppins';font-weight:600;font-size:24px;color:${p.dark ? '#ffffff' : p.ink}}
.sig img{width:34px;height:34px;object-fit:contain;border-radius:8px;background:#fff;padding:3px}
.sig b{color:${p.a1};font-weight:800}
</style></head><body>
<div class="abs card"></div>
${decorHtml(j.decor, p)}
<h1 data-fit="170">${esc(job.heading || '')}</h1>
${LAYOUT[layout](j, covers)}
${sig}
${FIT_SCRIPT}
</body></html>`;
}

export async function renderPoster(job, outFile) {
  const work = join(dirname(outFile), 'poster-work');
  mkdirSync(work, { recursive: true });
  // Each book stays with its cover: a book whose cover could not be loaded is dropped with it.
  const covers = [], books = [];
  for (const [i, url] of (job.covers || []).slice(0, 3).entries()) {
    const d = await dataUri(url);
    if (d) { covers.push(d); books.push(job.books?.[i] || {}); }
  }
  const logo = await dataUri(job.logo_url || 'https://booksharekh.com/dist/img/logo/logo.png', 4 * 1024 * 1024);
  const html = join(work, 'poster.html');
  writeFileSync(html, posterHtml({ ...job, covers, logo, books }), 'utf8');
  screenshot(html, outFile, W, H);
  return { file: outFile, covers: covers.length, logo: Boolean(logo), layout: job.layout || 'list' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [jobFile, out] = process.argv.slice(2);
  console.log(JSON.stringify(await renderPoster(JSON.parse(readFileSync(jobFile, 'utf8')), resolve(out))));
}
