// Renders one BookShareKH poster as a full-portrait TikTok photo post (1080x1920, 9:16), in the website's
// style: logo, colours (coral #f27f6b, lime #b6d433, teal #264653, navy #1f2a44), Poppins for Latin text
// and Noto Sans Khmer for Khmer, real book covers from the site and a website photo as the background.
// HTML → PNG with headless Chrome.
//   node scripts/poster_render.mjs <job.json> <out.png>
// job: { headline, subline, points: [..], cta, covers: [https urls], logo_url, background_url }
// TikTok draws its buttons on the right edge and the caption over the bottom ~300 px: key content
// stays inside a safe area (left 60, right 140, bottom 330).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetchImage } from './fetch_image.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FONTS = join(ROOT, 'assets', 'fonts');
export const W = 1080, H = 1920;

const CHROMES = [process.env.CHROME, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const font = (family, file, weight) => `@font-face{font-family:'${family}';src:url('${pathToFileURL(join(FONTS, file)).href}') format('truetype');font-weight:${weight};}`;

// Through the AI Manager on the GitHub runner (the site's firewall blocks GitHub servers).
async function dataUri(url, maxBytes = 8 * 1024 * 1024) {
  const img = await fetchImage(url, maxBytes);
  return img ? `data:${img.type};base64,${img.bytes.toString('base64')}` : null;
}

// Book wall: the first cover is the hero in the middle; the others fan out behind it.
function bookWall(covers) {
  const slots = [
    { w: 400, x: 0, y: 0, r: 0, z: 5 },
    { w: 300, x: -265, y: 70, r: -8, z: 4 }, { w: 300, x: 265, y: 70, r: 8, z: 4 },
    { w: 230, x: -385, y: 150, r: -14, z: 3 }, { w: 230, x: 385, y: 150, r: 14, z: 3 },
  ];
  return covers.slice(0, 5).map((src, i) => {
    const s = slots[i];
    return `<img class="book" style="width:${s.w}px;height:${Math.round(s.w * 1.5)}px;transform:translateX(calc(-50% + ${s.x}px)) translateY(${s.y}px) rotate(${s.r}deg);z-index:${s.z}" src="${src}">`;
  }).join('');
}

export function posterHtml({ headline, subline, points = [], cta, covers = [], logo, background }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${font('Poppins', 'Poppins-Regular.ttf', 400)}${font('Poppins', 'Poppins-SemiBold.ttf', 600)}${font('Poppins', 'Poppins-Bold.ttf', 700)}${font('Poppins', 'Poppins-ExtraBold.ttf', 800)}
${font('Noto Sans Khmer', 'NotoSansKhmer-Regular.ttf', 400)}${font('Noto Sans Khmer', 'NotoSansKhmer-Bold.ttf', 700)}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${W}px;height:${H}px;overflow:hidden}
body{font-family:'Poppins','Noto Sans Khmer',sans-serif;color:#fff;position:relative;
  background:${background ? `linear-gradient(180deg,rgba(31,42,68,.93) 0%,rgba(38,70,83,.80) 38%,rgba(31,42,68,.88) 70%,rgba(20,28,46,.97) 100%),url(${background}) center/cover` : 'linear-gradient(170deg,#264653 0%,#1f2a44 100%)'}}
.glow{position:absolute;border-radius:50%;filter:blur(60px)}
.g1{width:560px;height:560px;background:#f27f6b;opacity:.28;top:-160px;right:-200px}
.g2{width:520px;height:520px;background:#b6d433;opacity:.22;top:900px;left:-260px}
.top{position:absolute;top:70px;left:60px;right:140px;display:flex;align-items:center;gap:20px}
.logo{width:104px;height:104px;border-radius:26px;background:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 10px 30px rgba(0,0,0,.25)}
.logo img{width:82px;height:82px;object-fit:contain}
.brand{font-weight:800;font-size:56px;letter-spacing:-.5px;line-height:1}
.brand span{color:#f27f6b}
.site{font-weight:600;font-size:28px;color:#b6d433;margin-top:6px}
.text{position:absolute;top:250px;left:60px;right:120px}
h1{font-family:'Noto Sans Khmer','Poppins',sans-serif;font-weight:700;font-size:86px;line-height:1.42;text-shadow:0 4px 24px rgba(0,0,0,.35)}
h1 .mark{background:linear-gradient(transparent 64%,rgba(182,212,51,.75) 64%);padding:0 8px}
.sub{font-family:'Noto Sans Khmer','Poppins',sans-serif;font-size:40px;line-height:1.6;color:#e7edf3;margin-top:18px}
.wall{position:absolute;left:0;right:0;top:720px;height:660px}
.book{position:absolute;left:50%;top:0;object-fit:cover;border-radius:14px;border:6px solid #fff;box-shadow:0 26px 60px rgba(0,0,0,.55)}
.shelf{position:absolute;left:90px;right:90px;top:1350px;height:22px;border-radius:12px;background:linear-gradient(90deg,#b6d433,#f27f6b);opacity:.9;box-shadow:0 14px 30px rgba(0,0,0,.4)}
.points{position:absolute;left:60px;right:140px;top:1410px;display:flex;flex-wrap:wrap;gap:16px}
.pt{font-family:'Noto Sans Khmer','Poppins',sans-serif;font-size:32px;font-weight:700;color:#1f2a44;background:#b6d433;border-radius:40px;padding:10px 28px 14px}
.cta{position:absolute;left:60px;top:${points.length > 2 ? 1580 : 1530}px;display:flex;align-items:center;gap:26px}
.btn{font-family:'Noto Sans Khmer','Poppins',sans-serif;font-weight:700;font-size:40px;color:#fff;background:#f27f6b;border-radius:60px;padding:16px 46px 22px;box-shadow:0 12px 30px rgba(242,127,107,.5)}
.url{font-weight:800;font-size:40px;color:#fff}
</style></head><body>
<div class="glow g1"></div><div class="glow g2"></div>
<div class="top">${logo ? `<div class="logo"><img src="${logo}"></div>` : ''}<div><div class="brand">BookShare<span>KH</span></div><div class="site">booksharekh.com</div></div></div>
<div class="text"><h1><span class="mark">${esc(headline)}</span></h1>${subline ? `<p class="sub">${esc(subline)}</p>` : ''}</div>
<div class="wall">${bookWall(covers)}</div>${covers.length ? '<div class="shelf"></div>' : ''}
<div class="points">${points.slice(0, 3).map(p => `<div class="pt">✓ ${esc(p)}</div>`).join('')}</div>
<div class="cta"><div class="btn">${esc(cta || 'ចូលមើលឥឡូវនេះ')}</div><div class="url">booksharekh.com</div></div>
</body></html>`;
}

export async function renderPoster(job, outFile) {
  const work = join(dirname(outFile), 'poster-work');
  mkdirSync(work, { recursive: true });
  const covers = [];
  for (const url of (job.covers || []).slice(0, 5)) { const d = await dataUri(url); if (d) covers.push(d); }
  const logo = await dataUri(job.logo_url || 'https://booksharekh.com/dist/img/logo/logo.png', 4 * 1024 * 1024);
  const background = await dataUri(job.background_url); // a website photo behind everything, tinted in brand colours
  const html = join(work, 'poster.html');
  writeFileSync(html, posterHtml({ ...job, covers, logo, background }), 'utf8');
  const chrome = CHROMES.find(c => !c.includes('/') || existsSync(c));
  let ok = false, err = '';
  for (const c of CHROMES) {
    if (c.includes('/') && !existsSync(c)) continue;
    const r = spawnSync(c, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--force-device-scale-factor=1',
      '--allow-file-access-from-files', '--default-background-color=00000000', `--window-size=${W},${H}`, '--virtual-time-budget=4000',
      `--screenshot=${resolve(outFile)}`, pathToFileURL(html).href], { encoding: 'utf8', timeout: 120000 });
    if (r.status === 0 && existsSync(outFile) && statSync(outFile).size > 10000) { ok = true; break; }
    err = (r.stderr || r.error?.message || '').slice(-300);
  }
  if (!ok) throw new Error(`poster screenshot failed (${chrome || 'no Chrome found'}): ${err}`);
  return { file: outFile, covers: covers.length, logo: Boolean(logo), background: Boolean(background) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [jobFile, out] = process.argv.slice(2);
  console.log(JSON.stringify(await renderPoster(JSON.parse(readFileSync(jobFile, 'utf8')), resolve(out))));
}
