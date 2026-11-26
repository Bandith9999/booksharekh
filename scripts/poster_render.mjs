// Renders one BookShareKH poster as a 4:5 portrait post (1080x1350). HTML → PNG with headless Chrome.
// Style (owner request 2026-11-26): a promotional "E-Library" image that is almost textless. The book
// covers are the hero, shown large on a soft pastel background (light gradient with a soft glow, a shelf,
// or a phone screen like an e-reader) so every cover is clearly visible. The only text is one short Khmer
// heading in a Khmer font and a small BookShareKH signature: no titles, notes, prices, buttons or web
// address (the caption carries the words). The Content Creator AI picks the layout, palette, font and decor.
//   node scripts/poster_render.mjs <job.json> <out.png>
// job: { layout, palette, font, decor, heading, covers: [https urls], logo_url }
// The heading shrinks to fit its box (any font).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetchImage } from './fetch_image.mjs';
import { KHMER_FONTS, fontFaces, fontOf } from './khmer_fonts.mjs';

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
// Soft pastels so the covers stand out. bg1 → bg2: background gradient, ink: heading, a1: soft accent
// (glow, bokeh), a2: shelf / phone rim.
export const POSTER_PALETTES = {
  cream: { bg1: '#fdf8f0', bg2: '#f3e6d0', ink: '#3b3128', a1: '#f6d9a8', a2: '#e3cfae' },
  peach: { bg1: '#fff4ee', bg2: '#fcd9c8', ink: '#4a3029', a1: '#ffc7ad', a2: '#efc1aa' },
  blush: { bg1: '#fff3f5', bg2: '#f6d6de', ink: '#4a2c35', a1: '#f7bccb', a2: '#e9c2cc' },
  lavender: { bg1: '#f8f5fd', bg2: '#e2daf3', ink: '#352c4d', a1: '#d3c4f0', a2: '#d4cbe6' },
  sky: { bg1: '#f3f8fd', bg2: '#d5e6f5', ink: '#24364b', a1: '#bcd8f2', a2: '#c6d6e6' },
  mint: { bg1: '#f2fbf6', bg2: '#d2eee0', ink: '#21392e', a1: '#b9e6cf', a2: '#c3dccf' },
  sage: { bg1: '#f5f7f0', bg2: '#dfe7d4', ink: '#2c3826', a1: '#cfdcbc', a2: '#ccd6bf' },
};
export const LAYOUTS = ['showcase', 'hero', 'phone'];
export const DECORS = ['glow', 'shelf', 'bokeh', 'none'];
export const FONTS_KM = KHMER_FONTS; // heading fonts: scripts/khmer_fonts.mjs

// Through the AI Manager on the GitHub runner (the site's firewall blocks GitHub servers).
async function dataUri(url, maxBytes = 8 * 1024 * 1024) {
  const img = await fetchImage(url, maxBytes);
  return img ? `data:${img.type};base64,${img.bytes.toString('base64')}` : null;
}

const HEAD = { top: 70, height: 230 }; // the Khmer heading
const STAGE_TOP = 330; // the covers start here
const CX = W / 2;

// A cover with a soft shadow and a faint reflection below it (a book standing on a glossy shelf).
const cover = (src, { x, y, w, h, rot = 0, z = 1, reflect = true }) => `<div class="abs cv" style="left:${Math.round(x)}px;top:${Math.round(y)}px;width:${w}px;height:${h}px;z-index:${z};transform:rotate(${rot}deg)">
<img class="main" src="${src}">${reflect ? `<img class="refl" src="${src}">` : ''}</div>`;

function decorHtml(decor, p, floor) {
  switch (decor) {
    case 'glow': return `<div class="abs" style="left:${CX - 540}px;top:${STAGE_TOP - 60}px;width:1080px;height:920px;border-radius:50%;background:radial-gradient(closest-side,#ffffff 0%,${p.a1}aa 50%,transparent 100%)"></div>`;
    case 'shelf': return `<div class="abs" style="left:70px;right:70px;top:${floor}px;height:26px;border-radius:6px;background:${p.a2};box-shadow:0 18px 30px rgba(0,0,0,.10);z-index:0"></div>`;
    case 'bokeh': return [[120, 400, 150], [940, 360, 190], [150, 1090, 120], [930, 1030, 160], [80, 760, 70], [1010, 700, 80]]
      .map(([x, y, s]) => `<div class="abs" style="left:${x - s / 2}px;top:${y - s / 2}px;width:${s}px;height:${s}px;border-radius:50%;background:radial-gradient(circle,#ffffff 0%,${p.a1} 70%);opacity:.55;filter:blur(2px)"></div>`).join('')
      + [[200, 270, 26], [860, 250, 20], [990, 1180, 24], [90, 1200, 18]].map(([x, y, s]) => `<div class="abs" style="left:${x}px;top:${y}px;font-size:${s}px;color:#ffffff;text-shadow:0 0 8px ${p.a1}">✦</div>`).join('');
    default: return '';
  }
}

// ---------- layouts: the covers are the poster. Each returns { floor, html } ----------
const LAYOUT = {
  // 2-3 covers in a row; with 3 the first is the biggest and in front.
  showcase(c) {
    if (c.length === 1) return LAYOUT.hero(c);
    const three = c.length >= 3;
    const bigH = 720, bigW = Math.round(bigH / 1.5), smH = three ? 520 : 630, smW = Math.round(smH / 1.5);
    const floor = three ? STAGE_TOP + 40 + bigH : STAGE_TOP + 90 + smH;
    if (!three) return { floor, html: [cover(c[0], { x: CX - smW - 22, y: floor - smH, w: smW, h: smH, rot: -2, z: 2 }), cover(c[1], { x: CX + 22, y: floor - smH, w: smW, h: smH, rot: 2, z: 2 })].join('') };
    return { floor, html: [
      cover(c[1], { x: CX - bigW / 2 - smW + 110, y: floor - smH, w: smW, h: smH, rot: -4, z: 1 }),
      cover(c[2], { x: CX + bigW / 2 - 110, y: floor - smH, w: smW, h: smH, rot: 4, z: 1 }),
      cover(c[0], { x: CX - bigW / 2, y: floor - bigH, w: bigW, h: bigH, z: 3 }),
    ].join('') };
  },
  // One large cover in focus.
  hero(c) {
    const h = 740, w = Math.round(h / 1.5), floor = STAGE_TOP + 40 + h;
    return { floor, html: cover(c[0], { x: CX - w / 2, y: floor - h, w, h, z: 2 }) };
  },
  // A phone / e-reader showing the first cover ("read on your phone"), other covers leaning on each side.
  phone(c) {
    const pw = 460, ph = 900, px = CX - pw / 2, py = STAGE_TOP, floor = py + ph;
    const sw = 320, sh = 480, sy = floor - sh;
    const side = c.slice(1, 3).map((s, i) => cover(s, { x: i ? px + pw - 80 : px - sw + 80, y: sy, w: sw, h: sh, rot: i ? 6 : -6, z: 3, reflect: false })).join('');
    return { floor, html: `<div class="abs phone" style="left:${px}px;top:${py}px;width:${pw}px;height:${ph}px"><div class="screen"><img src="${c[0]}"></div></div>${side}` };
  },
};

export function posterHtml(job) {
  const p = POSTER_PALETTES[job.palette] || POSTER_PALETTES.cream;
  const f = fontOf(job.font, 'kantumruy');
  const covers = (job.covers || []).filter(Boolean);
  const layout = LAYOUT[job.layout] ? job.layout : 'showcase';
  const decor = DECORS.includes(job.decor) ? job.decor : 'glow';
  // No cover could be loaded: the heading alone, centred.
  const stage = covers.length ? LAYOUT[layout](covers) : { floor: H - 200, html: '' };
  const headBox = covers.length ? { top: HEAD.top, height: HEAD.height } : { top: H / 2 - 260, height: 520 };
  const sig = `<div class="abs sig">${job.logo ? `<img src="${job.logo}">` : ''}<span>BookShare<b>KH</b></span></div>`;
  return `<!doctype html><html lang="km"><head><meta charset="utf-8"><style>
${fontFaces([job.font])}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${W}px;height:${H}px;overflow:hidden}
body{font-family:'Noto Sans Khmer',sans-serif;color:${p.ink};position:relative;background:linear-gradient(170deg,${p.bg1} 0%,${p.bg1} 30%,${p.bg2} 100%)}
.abs{position:absolute}
h1{position:absolute;left:90px;right:90px;top:${headBox.top}px;height:${headBox.height}px;display:flex;align-items:center;justify-content:center;text-align:center;z-index:5;
  font-family:'${f.family}','Noto Sans Khmer',sans-serif;font-weight:400;font-size:${Math.round((covers.length ? 80 : 96) * f.scale)}px;line-height:1.5;color:${p.ink}}
.cv img.main{width:100%;height:100%;object-fit:cover;display:block;border-radius:6px;box-shadow:0 30px 50px rgba(40,30,20,.22),0 8px 16px rgba(40,30,20,.14)}
.cv img.refl{position:absolute;left:0;top:100%;margin-top:6px;width:100%;height:100%;object-fit:cover;border-radius:6px;transform:scaleY(-1);opacity:.18;
  -webkit-mask-image:linear-gradient(to top,#000 0%,transparent 20%);mask-image:linear-gradient(to top,#000 0%,transparent 20%)}
.phone{z-index:4;border-radius:56px;background:#1e1e24;padding:18px;box-shadow:0 40px 70px rgba(40,30,20,.28),inset 0 0 0 3px ${p.a2}}
.phone .screen{width:100%;height:100%;border-radius:40px;overflow:hidden;background:#fff}
.phone .screen img{width:100%;height:100%;object-fit:cover;display:block}
.phone::before{content:'';position:absolute;top:30px;left:50%;width:110px;height:26px;margin-left:-55px;border-radius:14px;background:#1e1e24;z-index:2}
.sig{right:56px;bottom:40px;display:flex;align-items:center;gap:10px;opacity:.7;font-family:'Poppins';font-weight:600;font-size:26px;color:${p.ink};z-index:6}
.sig img{width:38px;height:38px;object-fit:contain;border-radius:9px;background:#fff;padding:3px}
.sig b{font-weight:800}
</style></head><body>
${decorHtml(decor, p, stage.floor)}
<h1 data-fit="${headBox.height}">${esc(job.heading || '')}</h1>
${stage.html}
${sig}
${FIT_SCRIPT}
</body></html>`;
}

export async function renderPoster(job, outFile) {
  const work = join(dirname(outFile), 'poster-work');
  mkdirSync(work, { recursive: true });
  // A cover that could not be loaded is left out.
  const covers = [];
  for (const url of (job.covers || []).slice(0, 3)) { const d = await dataUri(url); if (d) covers.push(d); }
  const logo = await dataUri(job.logo_url || 'https://booksharekh.com/dist/img/logo/logo.png', 4 * 1024 * 1024);
  const html = join(work, 'poster.html');
  writeFileSync(html, posterHtml({ ...job, covers, logo }), 'utf8');
  screenshot(html, outFile, W, H);
  return { file: outFile, covers: covers.length, logo: Boolean(logo), layout: job.layout || 'showcase' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [jobFile, out] = process.argv.slice(2);
  console.log(JSON.stringify(await renderPoster(JSON.parse(readFileSync(jobFile, 'utf8')), resolve(out))));
}
