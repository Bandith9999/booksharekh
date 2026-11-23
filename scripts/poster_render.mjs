// Renders one BookShareKH poster (1080x1350, Facebook / Instagram 4:5) from a job JSON, in the website's
// style: logo, colours (coral #f27f6b, lime #b6d433, teal #264653, navy #1f2a44, light #f5f7fa),
// Poppins for Latin text and Noto Sans Khmer for Khmer. HTML → PNG with headless Chrome.
//   node scripts/poster_render.mjs <job.json> <out.png>
// job: { headline, subline, points: [..], cta, covers: [https urls], logo_url }
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FONTS = join(ROOT, 'assets', 'fonts');
export const W = 1080, H = 1350;

const CHROMES = [process.env.CHROME, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const font = (family, file, weight) => `@font-face{font-family:'${family}';src:url('${pathToFileURL(join(FONTS, file)).href}') format('truetype');font-weight:${weight};}`;

async function dataUri(url, maxBytes = 8 * 1024 * 1024) {
  if (!/^https:\/\//.test(url || '')) return null;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'BookShareKH-GitHub-Runner/1.0' }, signal: AbortSignal.timeout(25000) });
    const type = r.headers.get('content-type') || '';
    if (!r.ok || !/^image\/(png|jpe?g|webp|gif)/.test(type)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > maxBytes) return null;
    return `data:${type.split(';')[0]};base64,${buf.toString('base64')}`;
  } catch { return null; }
}

export function posterHtml({ headline, subline, points = [], cta, covers = [], logo }) {
  const coverImgs = covers.slice(0, 3);
  // Fanned covers: centre in front, sides behind and tilted.
  const pos = coverImgs.length === 3 ? [['-215px', '-7deg', 0.86, 1], ['215px', '7deg', 0.86, 1], ['0px', '0deg', 1, 2]]
    : coverImgs.length === 2 ? [['-130px', '-5deg', 0.95, 1], ['130px', '5deg', 0.95, 2]] : [['0px', '0deg', 1, 1]];
  const order = coverImgs.length === 3 ? [1, 2, 0] : coverImgs.map((_, i) => i);
  const coverHtml = pos.map(([x, rot, scale, z], k) => coverImgs[order[k]]
    ? `<img class="cover" style="transform:translateX(${x}) rotate(${rot}) scale(${scale});z-index:${z}" src="${coverImgs[order[k]]}">` : '').join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${font('Poppins', 'Poppins-Regular.ttf', 400)}${font('Poppins', 'Poppins-SemiBold.ttf', 600)}${font('Poppins', 'Poppins-Bold.ttf', 700)}${font('Poppins', 'Poppins-ExtraBold.ttf', 800)}
${font('Noto Sans Khmer', 'NotoSansKhmer-Regular.ttf', 400)}${font('Noto Sans Khmer', 'NotoSansKhmer-Bold.ttf', 700)}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${W}px;height:${H}px;overflow:hidden}
body{font-family:'Poppins','Noto Sans Khmer',sans-serif;background:#f5f7fa;color:#1f2a44;position:relative}
.blob{position:absolute;border-radius:50%;filter:blur(2px)}
.b1{width:520px;height:520px;background:#f27f6b;opacity:.16;top:-190px;right:-170px}
.b2{width:420px;height:420px;background:#b6d433;opacity:.22;top:520px;left:-210px}
.top{position:absolute;top:54px;left:64px;right:64px;display:flex;align-items:center;gap:18px}
.top img{width:84px;height:84px;object-fit:contain}
.brand{font-weight:800;font-size:44px;color:#264653;letter-spacing:-.5px}
.brand span{color:#f27f6b}
.url{margin-left:auto;font-weight:600;font-size:26px;color:#264653;background:#fff;border-radius:40px;padding:10px 24px;box-shadow:0 6px 18px rgba(31,42,68,.08)}
.text{position:absolute;top:186px;left:64px;right:64px}
h1{font-family:'Noto Sans Khmer','Poppins',sans-serif;font-weight:700;font-size:70px;line-height:1.45;color:#1f2a44}
h1 .mark{background:linear-gradient(transparent 62%,rgba(182,212,51,.55) 62%);padding:0 6px}
.sub{font-family:'Noto Sans Khmer','Poppins',sans-serif;font-size:34px;line-height:1.6;color:#4a5568;margin-top:14px}
.panel{position:absolute;left:44px;right:44px;bottom:44px;height:710px;border-radius:44px;background:linear-gradient(150deg,#264653 0%,#1f2a44 100%);overflow:hidden}
.panel:before{content:'';position:absolute;width:360px;height:360px;border-radius:50%;background:#b6d433;opacity:.12;right:-90px;top:-120px}
.covers{position:absolute;left:0;right:0;top:46px;height:330px;display:flex;justify-content:center;align-items:flex-start}
.cover{position:absolute;height:310px;width:auto;max-width:230px;border-radius:12px;border:6px solid #fff;box-shadow:0 18px 40px rgba(0,0,0,.35);object-fit:cover}
.points{position:absolute;left:56px;right:56px;top:404px;display:flex;flex-wrap:wrap;gap:14px;justify-content:center}
.pt{font-family:'Noto Sans Khmer','Poppins',sans-serif;font-size:27px;font-weight:700;color:#1f2a44;background:#b6d433;border-radius:40px;padding:8px 24px 10px}
.cta{position:absolute;left:56px;right:56px;bottom:40px;display:flex;align-items:center;justify-content:space-between;gap:20px}
.btn{font-family:'Noto Sans Khmer','Poppins',sans-serif;font-weight:700;font-size:34px;color:#fff;background:#f27f6b;border-radius:50px;padding:14px 38px 18px;box-shadow:0 10px 24px rgba(242,127,107,.45)}
.site{font-weight:700;font-size:34px;color:#fff;letter-spacing:.3px}
</style></head><body>
<div class="blob b1"></div><div class="blob b2"></div>
<div class="top">${logo ? `<img src="${logo}">` : ''}<div class="brand">BookShare<span>KH</span></div><div class="url">booksharekh.com</div></div>
<div class="text"><h1><span class="mark">${esc(headline)}</span></h1>${subline ? `<p class="sub">${esc(subline)}</p>` : ''}</div>
<div class="panel"><div class="covers">${coverHtml}</div>
<div class="points">${points.slice(0, 3).map(p => `<div class="pt">✓ ${esc(p)}</div>`).join('')}</div>
<div class="cta"><div class="btn">${esc(cta || 'ចូលមើលឥឡូវនេះ')}</div><div class="site">booksharekh.com</div></div></div>
</body></html>`;
}

export async function renderPoster(job, outFile) {
  const work = join(dirname(outFile), 'poster-work');
  mkdirSync(work, { recursive: true });
  const covers = [];
  for (const url of (job.covers || []).slice(0, 3)) { const d = await dataUri(url); if (d) covers.push(d); }
  const logo = await dataUri(job.logo_url || 'https://booksharekh.com/dist/img/logo/logo.png', 4 * 1024 * 1024);
  const html = join(work, 'poster.html');
  writeFileSync(html, posterHtml({ ...job, covers, logo }), 'utf8');
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
  return { file: outFile, covers: covers.length, logo: Boolean(logo) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [jobFile, out] = process.argv.slice(2);
  console.log(JSON.stringify(await renderPoster(JSON.parse(readFileSync(jobFile, 'utf8')), resolve(out))));
}
