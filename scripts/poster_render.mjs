// Renders one BookShareKH poster as a full-portrait TikTok photo post (1080x1920, 9:16). HTML → PNG
// with headless Chrome. The Content Creator AI picks a design for every poster so they do not all look
// the same: a layout, a colour palette, a Khmer headline font and a decoration (see DESIGNS below).
//   node scripts/poster_render.mjs <job.json> <out.png>
// job: { layout, palette, font, decor, kicker, headline, highlight, subline, points: [..], cta,
//        covers: [https urls], books: [{ title, note }], logo_url, background_url }
// TikTok draws its buttons on the right edge and the caption over the bottom ~300 px: key content
// stays inside a safe area (left 60, right 140, bottom 330). Text shrinks to fit its box (any font).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetchImage } from './fetch_image.mjs';
import { KHMER_FONTS, bodyFontOf, fontFaces, fontOf } from './khmer_fonts.mjs';

export const W = 1080, H = 1920;

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

// ---------- design choices (keep in sync with POSTER_DESIGN in src/marketing/poster.js) ----------
export const FONTS_KM = KHMER_FONTS; // headline fonts: scripts/khmer_fonts.mjs
// light: dark text on a light background.
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
export const LAYOUTS = ['fan', 'spotlight', 'list', 'grid', 'magazine', 'arc'];
export const DECORS = ['glow', 'dots', 'stripes', 'circles', 'waves', 'none'];

// Through the AI Manager on the GitHub runner (the site's firewall blocks GitHub servers).
async function dataUri(url, maxBytes = 8 * 1024 * 1024) {
  const img = await fetchImage(url, maxBytes);
  return img ? `data:${img.type};base64,${img.bytes.toString('base64')}` : null;
}

const cover = (src, style, cls = 'book') => `<img class="${cls}" style="${style}" src="${src}">`;
const coverStyle = (w, x, y, r = 0, z = 1) => `width:${w}px;height:${Math.round(w * 1.5)}px;left:${x}px;top:${y}px;transform:rotate(${r}deg);z-index:${z}`;

// The headline, with the AI's highlight word(s) marked (only if they really are in the headline).
function headlineHtml(headline, highlight) {
  const h = esc(headline), m = esc(highlight || '').trim();
  return m && h.includes(m) ? h.replace(m, `<span class="hl">${m}</span>`) : h;
}

function decorHtml(decor, p) {
  switch (decor) {
    case 'glow': return `<div class="deco" style="width:600px;height:600px;border-radius:50%;filter:blur(70px);background:${p.a1};opacity:.3;top:-180px;right:-220px"></div>
<div class="deco" style="width:540px;height:540px;border-radius:50%;filter:blur(70px);background:${p.a2};opacity:.24;top:960px;left:-280px"></div>`;
    case 'dots': return `<div class="deco" style="width:420px;height:420px;top:120px;right:-60px;opacity:.35;background:radial-gradient(${p.a2} 5px,transparent 6px) 0 0/34px 34px"></div>
<div class="deco" style="width:300px;height:300px;top:1180px;left:-40px;opacity:.3;background:radial-gradient(${p.a1} 5px,transparent 6px) 0 0/34px 34px"></div>`;
    case 'stripes': return `<div class="deco" style="width:1600px;height:240px;top:640px;left:-260px;transform:rotate(-12deg);opacity:.16;background:repeating-linear-gradient(90deg,${p.a1} 0 28px,transparent 28px 64px)"></div>`;
    case 'circles': return `<div class="deco" style="width:760px;height:760px;border-radius:50%;top:-260px;right:-300px;border:3px solid ${p.a1};opacity:.45;box-shadow:0 0 0 46px transparent,0 0 0 49px ${p.a2}55,0 0 0 96px transparent,0 0 0 99px ${p.a1}33"></div>`;
    case 'waves': return `<svg class="deco" style="left:0;top:1260px;opacity:.28" width="${W}" height="660" viewBox="0 0 1080 660"><path d="M0 120 C 180 40, 360 200, 540 120 S 900 40, 1080 120 V660 H0Z" fill="${p.a1}"/><path d="M0 210 C 200 130, 380 290, 560 210 S 920 130, 1080 210 V660 H0Z" fill="${p.a2}" opacity=".7"/></svg>`;
    default: return '';
  }
}

const brand = (logo, p, { center = false, small = false } = {}) => `<div class="brandbar" style="${center ? 'justify-content:center;' : ''}">
${logo ? `<div class="logo${small ? ' sm' : ''}"><img src="${logo}"></div>` : ''}<div><div class="brand${small ? ' sm' : ''}">BookShare<span>KH</span></div><div class="site">booksharekh.com</div></div></div>`;
const chips = points => points.slice(0, 3).map(x => `<div class="pt">✓ ${esc(x)}</div>`).join('');
const ctaHtml = cta => `<div class="btn">${esc(cta || 'ចូលមើលឥឡូវនេះ')}</div><div class="url">booksharekh.com</div>`;
const kickerHtml = k => (k ? `<div class="kicker">${esc(k)}</div>` : '');
const titleBlock = (j, fit) => `${kickerHtml(j.kicker)}<h1 data-fit="${fit}">${headlineHtml(j.headline, j.highlight)}</h1>${j.subline ? `<p class="sub" data-fit="190">${esc(j.subline)}</p>` : ''}`;

// ---------- layouts ----------
const LAYOUT = {
  // Headline on top, covers fanned out in the middle, badges and button below (the classic).
  fan(j, c) {
    const slots = [[400, 0, 0, 0, 5], [300, -265, 70, -8, 4], [300, 265, 70, 8, 4], [230, -385, 150, -14, 3], [230, 385, 150, 14, 3]];
    const wall = c.slice(0, 5).map((s, i) => { const [w, x, y, r, z] = slots[i]; return cover(s, `${coverStyle(w, 0, y, r, z)};left:calc(50% - 50px + ${x}px - ${w / 2}px)`); }).join('');
    return `<div class="abs" style="top:70px;left:60px;right:140px">${j.brandHtml}</div>
<div class="abs col" style="top:240px;left:60px;right:140px">${titleBlock(j, 380)}</div>
<div class="abs" style="top:780px;left:0;right:0;height:620px">${wall}</div>
<div class="abs row" style="top:1430px;left:60px;right:140px">${chips(j.points)}</div>
<div class="abs cta" style="top:1560px;left:60px">${ctaHtml(j.cta)}</div>`;
  },
  // One big hero book on the right, the others in a column on the left, a bold colour band behind.
  spotlight(j, c) {
    const [hero, ...rest] = c;
    const side = rest.slice(0, 4).map((s, i) => cover(s, coverStyle(150, 60 + (i % 2) * 40, 860 + i * 150, i % 2 ? 4 : -4, 2 + i))).join('');
    return `<div class="abs" style="top:70px;left:60px;right:140px">${j.brandHtml}</div>
<div class="abs col" style="top:240px;left:60px;right:140px">${titleBlock(j, 420)}</div>
<div class="abs band" style="top:900px;left:-80px;width:1300px;height:420px;transform:rotate(-8deg)"></div>
${side}${hero ? cover(hero, coverStyle(470, 380, 800, 5, 6), 'book hero') : ''}
<div class="abs row" style="top:1560px;left:60px;right:140px">${chips(j.points)}</div>
<div class="abs cta" style="top:1660px;left:60px;transform:scale(.9);transform-origin:left top">${ctaHtml(j.cta)}</div>`;
  },
  // Numbered book list with title and a short note each: best for "N books about …" posters.
  list(j, c) {
    const n = Math.min(c.length, 5), top = 640, bottom = 1530, rowH = Math.floor((bottom - top) / Math.max(n, 3));
    const rows = c.slice(0, 5).map((s, i) => {
      const b = j.books?.[i] || {};
      const h = rowH - 22, w = Math.round(h / 1.5);
      return `<div class="lrow" style="top:${top + i * rowH}px;height:${h}px">
<div class="num">${i + 1}</div>${cover(s, `width:${w}px;height:${h}px;position:relative`, 'book thumb')}
<div class="ltext"><div class="ltitle" data-fit="${Math.round(h * 0.45)}">${esc(b.title || '')}</div>${b.note ? `<div class="lnote" data-fit="${Math.round(h * 0.5)}">${esc(b.note)}</div>` : ''}</div></div>`;
    }).join('');
    return `<div class="abs" style="top:60px;left:60px;right:140px">${brand(j.logo, j.p, { small: true })}</div>
<div class="abs col" style="top:200px;left:60px;right:140px">${kickerHtml(j.kicker)}<h1 data-fit="330">${headlineHtml(j.headline, j.highlight)}</h1></div>
${rows}
<div class="abs cta" style="top:1560px;left:60px">${ctaHtml(j.cta)}</div>`;
  },
  // A tilted wall of covers (a bookshelf feel) on top, the message on a colour card below.
  grid(j, c) {
    const fill = Array.from({ length: 12 }, (_, i) => c[i % c.length]);
    const tiles = fill.map(s => `<img class="tile" src="${s}">`).join('');
    return `<div class="abs gridwall">${tiles}</div>
<div class="abs fade"></div>
<div class="abs card col" style="top:860px;left:50px;right:130px;padding:44px 44px 48px">${titleBlock(j, 340)}<div class="row" style="margin-top:22px">${chips(j.points)}</div></div>
<div class="abs cta" style="top:1585px;left:60px">${ctaHtml(j.cta)}</div>
<div class="abs" style="top:50px;left:40px;padding:14px 26px;border-radius:28px;background:${j.p.bg2}d9">${brand(j.logo, j.p, { small: true })}</div>`;
  },
  // Magazine cover: big masthead, covers overlapping across the middle, headline in boxes at the bottom.
  magazine(j, c) {
    const row = c.slice(0, 4).map((s, i, a) => cover(s, coverStyle(300, 60 + i * (700 / Math.max(a.length - 1, 1)), 430 + (i % 2) * 60, i % 2 ? 5 : -5, 2 + i))).join('');
    return `<div class="abs masthead" style="top:60px;left:60px;right:140px">BookShare<span>KH</span></div>
<div class="abs" style="top:250px;left:60px;right:140px;display:flex;justify-content:space-between;align-items:center">${kickerHtml(j.kicker)}${j.logo ? `<div class="logo sm"><img src="${j.logo}"></div>` : ''}</div>
${row}
<div class="abs col" style="top:1030px;left:60px;right:140px"><h1 class="boxed" data-fit="360">${headlineHtml(j.headline, j.highlight)}</h1>${j.subline ? `<p class="sub" data-fit="120">${esc(j.subline)}</p>` : ''}</div>
<div class="abs cta" style="top:1590px;left:60px">${ctaHtml(j.cta)}</div>`;
  },
  // Everything centred, covers on an arc at the bottom like an open hand of cards.
  arc(j, c) {
    const n = Math.min(c.length, 5), span = 44;
    const cards = c.slice(0, 5).map((s, i) => {
      const a = n === 1 ? 0 : -span / 2 + (span * i) / (n - 1);
      return `<img class="book" src="${s}" style="width:260px;height:390px;left:${500 - 130}px;top:1000px;transform-origin:50% 160%;transform:rotate(${a}deg);z-index:${10 - Math.abs(i - (n - 1) / 2)}">`;
    }).join('');
    return `<div class="abs" style="top:70px;left:60px;right:140px">${brand(j.logo, j.p, { center: true })}</div>
<div class="abs col center" style="top:250px;left:60px;right:140px">${titleBlock(j, 400)}</div>
${cards}
<div class="abs row" style="top:1470px;left:60px;right:140px;justify-content:center">${chips(j.points)}</div>
<div class="abs cta" style="top:1575px;left:60px;right:140px;justify-content:center">${ctaHtml(j.cta)}</div>`;
  },
};

export function posterHtml(job) {
  const p = PALETTES[job.palette] || PALETTES.brand_night;
  const f = fontOf(job.font, 'noto'), bf = bodyFontOf(job.body_font);
  const layout = LAYOUT[job.layout] ? job.layout : 'fan';
  const covers = (job.covers || []).filter(Boolean);
  const j = { ...job, p, points: job.points || [], logo: job.logo };
  j.brandHtml = brand(job.logo, p);
  const tint = p.light ? `${p.bg1}e6,${p.bg2}f2` : `${p.bg1}d9,${p.bg2}f0`;
  const bg = job.background ? `linear-gradient(170deg,${tint}),url(${job.background}) center/cover` : `linear-gradient(170deg,${p.bg1} 0%,${p.bg2} 100%)`;
  const body = covers.length || layout !== 'list' ? LAYOUT[layout](j, covers) : LAYOUT.fan(j, covers);
  return `<!doctype html><html lang="km"><head><meta charset="utf-8"><style>
${fontFaces([job.font, job.body_font, 'kantumruy'])}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${W}px;height:${H}px;overflow:hidden}
body{font-family:'${bf.family}','Noto Sans Khmer','Poppins',sans-serif;color:${p.ink};position:relative;background:${bg}}
.abs,.deco{position:absolute}
.col{display:flex;flex-direction:column}.row{display:flex;flex-wrap:wrap;gap:16px}.center{align-items:center;text-align:center}
.brandbar{display:flex;align-items:center;gap:20px}
.logo{width:104px;height:104px;border-radius:26px;background:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 10px 30px rgba(0,0,0,.25)}
.logo.sm{width:84px;height:84px;border-radius:22px}.logo img{width:80%;height:80%;object-fit:contain}
.brand{font-family:'Poppins';font-weight:800;font-size:56px;letter-spacing:-.5px;line-height:1}.brand.sm{font-size:44px}
.brand span,.masthead span{color:${p.a1}}
.site{font-family:'Poppins';font-weight:600;font-size:26px;color:${p.light ? p.a2 : p.a2};margin-top:6px}
.kicker{align-self:flex-start;font-weight:700;font-size:34px;line-height:1.5;color:${p.chipInk};background:${p.a2};border-radius:14px;padding:6px 22px 10px;margin-bottom:22px}
.center .kicker{align-self:center}
h1{font-family:'${f.family}','Noto Sans Khmer','Poppins',sans-serif;font-weight:700;font-size:${Math.round(96 * f.scale)}px;line-height:1.5;color:${p.ink};
  text-shadow:${p.light ? 'none' : '0 4px 24px rgba(0,0,0,.35)'}}
.hl{color:${p.a1}}
h1.boxed{line-height:1.75}
h1.boxed{color:${p.light ? p.ink : '#fff'}}
h1.boxed .hl{color:${p.chipInk};background:${p.a1};padding:0 14px;border-radius:10px;box-decoration-break:clone;-webkit-box-decoration-break:clone}
.sub{font-size:40px;line-height:1.6;color:${p.sub};margin-top:16px}
.book{position:absolute;object-fit:cover;border-radius:14px;border:6px solid #fff;box-shadow:0 26px 60px rgba(0,0,0,.45)}
.book.hero{border-width:8px;box-shadow:0 36px 80px rgba(0,0,0,.55)}
.band{background:linear-gradient(90deg,${p.a1},${p.a2});opacity:.9}
.pt{font-size:32px;font-weight:700;color:${p.chipInk};background:${p.a2};border-radius:40px;padding:8px 28px 12px}
.cta{display:flex;align-items:center;gap:26px}
.btn{font-weight:700;font-size:40px;color:#fff;background:${p.a1};border-radius:60px;padding:14px 46px 20px;box-shadow:0 12px 30px ${p.a1}80}
.url{font-family:'Poppins';font-weight:800;font-size:38px;color:${p.ink}}
.lrow{position:absolute;left:60px;right:140px;display:flex;align-items:center;gap:26px;background:${p.light ? '#ffffffb3' : '#ffffff14'};border-radius:22px;padding:10px 24px 10px 10px}
.lrow .thumb{border-width:4px;border-radius:10px;box-shadow:0 10px 24px rgba(0,0,0,.35);flex:none}
.num{flex:none;width:66px;height:66px;border-radius:50%;background:${p.a1};color:#fff;font-family:'Poppins';font-weight:800;font-size:38px;display:flex;align-items:center;justify-content:center;margin-left:8px}
.ltext{flex:1;min-width:0;overflow:hidden}.ltitle{font-family:'Poppins','Noto Sans Khmer';font-weight:600;font-size:34px;line-height:1.25}
.lnote{font-size:29px;line-height:1.5;color:${p.sub};margin-top:6px}
.gridwall{top:-120px;left:-160px;width:1400px;height:1150px;display:grid;grid-template-columns:repeat(4,1fr);gap:26px;transform:rotate(-9deg)}
.tile{width:100%;aspect-ratio:2/3;object-fit:cover;border-radius:12px;box-shadow:0 16px 36px rgba(0,0,0,.4)}
.fade{top:640px;left:0;width:${W}px;height:400px;background:linear-gradient(180deg,transparent,${p.bg2})}
.card{background:${p.light ? '#fffffff0' : `${p.bg2}f0`};border-radius:36px;box-shadow:0 30px 70px rgba(0,0,0,.35);border-top:10px solid ${p.a1}}
.masthead{font-family:'Poppins';font-weight:800;font-size:150px;letter-spacing:-6px;line-height:1;color:${p.ink}}
</style></head><body>
${decorHtml(job.decor, p)}
${body}
${FIT_SCRIPT}
</body></html>`;
}

export async function renderPoster(job, outFile) {
  const work = join(dirname(outFile), 'poster-work');
  mkdirSync(work, { recursive: true });
  // Book list rows stay with their cover: a row whose cover could not be loaded is dropped with it.
  const covers = [], books = [];
  for (const [i, url] of (job.covers || []).slice(0, 5).entries()) {
    const d = await dataUri(url);
    if (d) { covers.push(d); books.push(job.books?.[i] || {}); }
  }
  const logo = await dataUri(job.logo_url || 'https://booksharekh.com/dist/img/logo/logo.png', 4 * 1024 * 1024);
  const background = await dataUri(job.background_url); // a website photo behind everything, tinted in the palette
  const html = join(work, 'poster.html');
  writeFileSync(html, posterHtml({ ...job, covers, logo, background, books }), 'utf8');
  screenshot(html, outFile, W, H);
  return { file: outFile, covers: covers.length, logo: Boolean(logo), background: Boolean(background), layout: job.layout || 'fan' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [jobFile, out] = process.argv.slice(2);
  console.log(JSON.stringify(await renderPoster(JSON.parse(readFileSync(jobFile, 'utf8')), resolve(out))));
}
