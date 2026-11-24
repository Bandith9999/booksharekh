// Renders one BookShareKH promo video (9:16) from a job JSON. Runs on the GitHub runner and locally.
//   node scripts/promo_render.mjs <job.json> <out.mp4> [--no-voice]
// job: { scenes: [{ text, voice }], covers: [https urls], tts: "gemini", voice: "km-KH-SreymomNeural",
//        font, body_font, palette, background_url, logo_url }
// - Voice-over: Gemini text-to-speech (made by the AI Manager from the approved script, /job-voice);
//   if Gemini is not available, edge-tts; if neither works, the video is made without voice.
//   All scenes use the same voice, or none (a half-voiced video looks broken).
// - Khmer text is drawn by headless Chrome (correct Khmer shaping, the AI's font and colours) as
//   transparent PNG layers, then placed on the video by FFmpeg while its scene is spoken.
// - Khmer has no spaces between words: lines are broken at word boundaries with Intl.Segmenter('km').
// - Book covers are only the background visuals.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchImage } from './fetch_image.mjs';
import { FIT_SCRIPT, PALETTES, esc, screenshot } from './poster_render.mjs';
import { bodyFontOf, fontFaces, fontOf } from './khmer_fonts.mjs';

const W = 720, H = 1280, FPS = 30;
const FFMPEG = process.env.FFMPEG || 'ffmpeg', FFPROBE = process.env.FFPROBE || 'ffprobe', EDGE_TTS = process.env.EDGE_TTS || 'edge-tts';

const run = (cmd, args, timeout = 300000) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || r.error?.message || '').slice(-600)}`);
  return r.stdout;
};
const probeDuration = f => Number(run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], 60000).trim()) || 0;

// ---- text ----
const graphemes = s => [...new Intl.Segmenter('km', { granularity: 'grapheme' }).segment(s)].length;
// Wrap at word boundaries (Khmer dictionary segmentation) to at most `max` grapheme clusters per line.
// Pieces that may not be split: Khmer words (dictionary), Latin/number runs ("$0.50", "booksharekh.com")
// and punctuation, which sticks to the word before it ("ណា?", "ហើយ។").
const KM_RUN = /[ក-៿᧠-᧿]+|\s+|[^\sក-៿᧠-᧿]+/g;
// Punctuation and Khmer signs that belong to the word before them (។ ៕ ៖ ៗ ៘ ៙ ៚ ៜ …).
const PUNCT = /^[\p{P}\p{S}។-៚ៜ]+$/u;
export function khmerAtoms(text) {
  const atoms = [];
  const stick = p => { if (atoms.length && atoms.at(-1) !== ' ') atoms[atoms.length - 1] += p; else atoms.push(p); };
  for (const part of String(text).replace(/\s+/g, ' ').trim().match(KM_RUN) || []) {
    if (/^\s+$/.test(part)) atoms.push(' ');
    else if (/[ក-៿]/.test(part)) {
      for (const s of new Intl.Segmenter('km', { granularity: 'word' }).segment(part)) (PUNCT.test(s.segment) ? stick : x => atoms.push(x))(s.segment);
    } else if (PUNCT.test(part) && !/^\$/.test(part)) stick(part);
    else atoms.push(part);
  }
  return atoms;
}
export function wrapKhmer(text, max = 13) {
  const words = khmerAtoms(text);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (cur && graphemes((cur + w).trim()) > max) { lines.push(cur.trim()); cur = w.trimStart(); }
    else cur += w;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines.slice(0, 4);
}

// One scene's text as a transparent 720x1280 layer: a card near the top in the palette's colours.
export function sceneHtml({ lines, index, count, font, body_font, palette, last }) {
  const p = PALETTES[palette] || PALETTES.brand_night;
  const f = fontOf(font), bf = bodyFontOf(body_font);
  const dots = Array.from({ length: count }, (_, i) => `<i class="${i === index ? 'on' : ''}"></i>`).join('');
  return `<!doctype html><html lang="km"><head><meta charset="utf-8"><style>
${fontFaces([font, body_font])}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${W}px;height:${H}px;overflow:hidden;background:transparent}
.card{position:absolute;left:36px;right:36px;top:150px;padding:34px 34px 40px;border-radius:30px;
  background:${p.light ? `${p.bg1}f2` : `${p.bg2}d9`};border-top:8px solid ${p.a1};box-shadow:0 18px 50px rgba(0,0,0,.45);text-align:center}
.t{font-family:'${f.family}','Noto Sans Khmer',sans-serif;font-weight:700;font-size:${Math.round(66 * f.scale)}px;line-height:1.55;color:${p.ink};white-space:nowrap}
.t .l:nth-child(2n){color:${p.a1}}
.dots{margin-top:22px;display:flex;justify-content:center;gap:10px}.dots i{width:12px;height:12px;border-radius:50%;background:${p.ink};opacity:.3}.dots i.on{opacity:1;background:${p.a2}}
.cta{margin-top:20px}
.cta span{display:inline-block;font-family:'Poppins','${bf.family}',sans-serif;font-weight:800;font-size:38px;color:#fff;background:${p.a1};border-radius:50px;padding:10px 38px 14px;box-shadow:0 10px 24px rgba(0,0,0,.35)}
</style></head><body>
<div class="card"><div class="t" data-fit="${last ? 360 : 430}">${lines.map(l => `<div class="l">${esc(l)}</div>`).join('')}</div>
${last ? '<div class="cta"><span>booksharekh.com</span></div>' : ''}<div class="dots">${dots}</div></div>
${FIT_SCRIPT}
</body></html>`;
}
// Brand line at the bottom for the whole video.
function brandHtml(palette) {
  const p = PALETTES[palette] || PALETTES.brand_night;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fontFaces([])}
*{margin:0;padding:0}html,body{width:${W}px;height:${H}px;overflow:hidden;background:transparent}
.b{position:absolute;left:0;right:0;bottom:120px;text-align:center;font-family:'Poppins';text-shadow:0 3px 14px rgba(0,0,0,.6)}
.n{font-weight:800;font-size:46px;color:#fff}.n span{color:${p.a1}}.u{font-weight:600;font-size:30px;color:${p.a2};margin-top:4px}
</style></head><body><div class="b"><div class="n">BookShare<span>KH</span></div><div class="u">booksharekh.com</div></div></body></html>`;
}

// ---- media ----
async function downloadCover(url, file) {
  const img = await fetchImage(url); // through the AI Manager on the GitHub runner (site firewall)
  if (!img) return false;
  try {
    writeFileSync(file, img.bytes);
    run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file], 30000);
    return true;
  } catch { return false; }
}

// Gemini voice for scene i, made by the AI Manager from the approved script (only on the runner).
async function geminiVoice(i, file) {
  const { WORKER_URL, JOB_CALLBACK_SECRET, TASK_ID } = process.env;
  if (!WORKER_URL || !JOB_CALLBACK_SECRET || !TASK_ID) return false;
  try {
    const r = await fetch(`${WORKER_URL.replace(/\/+$/, '')}/job-voice/${encodeURIComponent(TASK_ID)}/${i}`, {
      headers: { Authorization: `Bearer ${JOB_CALLBACK_SECRET}`, 'User-Agent': 'BookShareKH-GitHub-Runner/1.0' }, signal: AbortSignal.timeout(120000) });
    if (!r.ok || !/audio\//.test(r.headers.get('content-type') || '')) { console.log(`gemini voice ${i}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`); return false; }
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    return statSync(file).size > 2000 && probeDuration(file) > 0.3;
  } catch (e) { console.log(`gemini voice ${i}: ${e.message}`); return false; }
}
function edgeVoice(text, voice, file) {
  const r = spawnSync(EDGE_TTS, ['--voice', voice, '--text', text, '--write-media', file], { encoding: 'utf8', timeout: 90000 });
  return r.status === 0 && existsSync(file) && statSync(file).size > 1000;
}

// All scenes with one engine: Gemini, else edge-tts, else none.
async function voiceOver(job, raw, work) {
  const edgeName = /^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/.test(job.voice || '') ? job.voice : 'km-KH-SreymomNeural';
  if (job.tts === 'gemini') {
    const files = [];
    for (let i = 0; i < raw.length; i++) { const f = join(work, `gvoice${i}.wav`); if (!await geminiVoice(i, f)) break; files.push(f); }
    if (files.length === raw.length) return { engine: 'gemini', files };
    console.log('Gemini voice not available: trying edge-tts');
  }
  const files = [];
  for (let i = 0; i < raw.length; i++) {
    const f = join(work, `voice${i}.mp3`);
    if (!edgeVoice(String(raw[i].voice || raw[i].text).slice(0, 400), edgeName, f)) break;
    files.push(f);
  }
  if (files.length === raw.length) return { engine: 'edge-tts', files };
  console.log('voice-over unavailable: rendering without voice');
  return { engine: null, files: [] };
}

export async function renderPromo(job, outFile, { voice: useVoice = true } = {}) {
  const work = join(dirname(outFile), 'promo-work');
  mkdirSync(work, { recursive: true });
  const raw = (job.scenes || []).filter(s => s?.text).slice(0, 6);
  if (!raw.length) throw new Error('No scenes');

  const vo = useVoice ? await voiceOver(job, raw, work) : { engine: null, files: [] };
  const voiced = Boolean(vo.engine);

  // Timeline: each scene lasts as long as its voice (+ a short pause), or a reading time without voice.
  let t = 0.3;
  const scenes = raw.map((s, i) => {
    const len = voiced ? probeDuration(vo.files[i]) + 0.45 : Math.min(Math.max(graphemes(s.text) * 0.11 + 1.6, 2.6), 5);
    const sc = { lines: wrapKhmer(s.text, 12), start: t, end: t + len, dur: len };
    t += len;
    return sc;
  });
  const total = Math.min(t + 1.2, 59);

  // Text layers (Chrome): one per scene + the brand line.
  const layers = scenes.map((s, i) => {
    const html = join(work, `scene${i}.html`), png = join(work, `scene${i}.png`);
    writeFileSync(html, sceneHtml({ lines: s.lines, index: i, count: scenes.length, font: job.font, body_font: job.body_font, palette: job.palette, last: i === scenes.length - 1 }), 'utf8');
    screenshot(html, png, W, H);
    return png;
  });
  const brandPng = join(work, 'brand.png');
  writeFileSync(join(work, 'brand.html'), brandHtml(job.palette), 'utf8');
  screenshot(join(work, 'brand.html'), brandPng, W, H);

  // Covers (visuals only): up to 3, fanned in the middle, sliding up one after another.
  const covers = [];
  for (const [i, url] of (job.covers || []).slice(0, 3).entries()) {
    const f = join(work, `cover${i}.img`);
    if (await downloadCover(url, f)) covers.push(f);
  }
  // Website images: a background photo chosen by the AI and the logo (both optional).
  const bgFile = join(work, 'background.img'), logoFile = join(work, 'logo.img');
  const hasBg = await downloadCover(job.background_url, bgFile);
  const hasLogo = await downloadCover(job.logo_url, logoFile);
  const pal = PALETTES[job.palette] || PALETTES.brand_night;
  const inputs = ['-f', 'lavfi', '-t', String(total), '-i', `color=c=0x${pal.bg2.slice(1)}:s=${W}x${H}:r=${FPS}`];
  let n = 1;
  const add = file => { inputs.push('-loop', '1', '-t', String(total), '-i', file); return n++; };
  const bgIdx = hasBg ? add(bgFile) : -1;
  const coverIdx = covers.map(add);
  const logoIdx = hasLogo ? add(logoFile) : -1;
  const layerIdx = layers.map(add);
  const brandIdx = add(brandPng);
  const parts = [];
  let base = '[0:v]';
  // Background: the website photo (lightly blurred, darkened, slow pan) or else the first cover, blurred.
  if (hasBg) {
    const BW = Math.round(W * 1.12 / 2) * 2, BH = Math.round(H * 1.12 / 2) * 2; // 12% larger for the slow pan
    parts.push(`[${bgIdx}:v]scale=${BW}:${BH}:force_original_aspect_ratio=increase,crop=${BW}:${BH},boxblur=4:1,eq=brightness=-0.30:saturation=0.9,` +
      `crop=${W}:${H}:x='(iw-${W})/2*(1-t/${total.toFixed(2)})':y='(ih-${H})/2',setsar=1[bgc]`);
  } else if (covers.length) {
    parts.push(`[${coverIdx[0]}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=30:2,eq=brightness=-0.32:saturation=0.8,setsar=1[bgc]`);
  }
  if (hasBg || covers.length) { parts.push(`${base}[bgc]overlay=0:0[b0]`); base = '[b0]'; }
  if (covers.length) {
    // Layout: side covers smaller and behind, centre cover in front (lower half, under the text card).
    const slots = covers.length === 1 ? [{ w: 330, x: (W - 330) / 2, y: 640, d: 0.2 }]
      : covers.length === 2 ? [{ w: 270, x: 80, y: 660, d: 0.2 }, { w: 270, x: W - 350, y: 660, d: 0.45 }]
        : [{ w: 220, x: 40, y: 690, d: 0.35 }, { w: 220, x: W - 260, y: 690, d: 0.55 }, { w: 290, x: (W - 290) / 2, y: 640, d: 0.15 }];
    const order = covers.length === 3 ? [1, 2, 0] : covers.map((_, i) => i); // centre slot uses the first cover
    slots.forEach((s, k) => {
      const h = Math.round(s.w * 1.5);
      parts.push(`[${coverIdx[order[k]]}:v]scale=${s.w}:${h}:force_original_aspect_ratio=decrease,pad=${s.w + 8}:${h + 8}:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1[c${k}]`);
      parts.push(`${base}[c${k}]overlay=x=${Math.round(s.x)}:y='${s.y}+720*max(0\\,1-max(0\\,t-${s.d})/0.6)'[b${k + 1}]`);
      base = `[b${k + 1}]`;
    });
  }
  // Logo: small, centred at the top, on a white rounded badge so it reads on any background.
  if (hasLogo) {
    parts.push(`[${logoIdx}:v]scale=78:78:force_original_aspect_ratio=decrease,pad=96:96:(ow-iw)/2:(oh-ih)/2:color=white@0.92,format=rgba,setsar=1[logo]`);
    parts.push(`${base}[logo]overlay=x=(W-w)/2:y=26[bl]`);
    base = '[bl]';
  }
  parts.push(`[${brandIdx}:v]format=rgba[brand]`, `${base}[brand]overlay=0:0[bb]`);
  base = '[bb]';
  // Scene text: fades in and out while its scene is spoken.
  scenes.forEach((s, i) => {
    const fadeOut = Math.max(s.start, s.end - 0.2).toFixed(2);
    parts.push(`[${layerIdx[i]}:v]format=rgba,fade=t=in:st=${s.start.toFixed(2)}:d=0.25:alpha=1,fade=t=out:st=${fadeOut}:d=0.2:alpha=1[s${i}]`);
    parts.push(`${base}[s${i}]overlay=0:0:enable='between(t,${s.start.toFixed(2)},${s.end.toFixed(2)})'[t${i}]`);
    base = `[t${i}]`;
  });
  parts.push(`${base}fade=t=in:st=0:d=0.3,fade=t=out:st=${(total - 0.4).toFixed(2)}:d=0.4,format=yuv420p[v]`);

  // Audio: each voice clip padded to its scene length, then concatenated; silence without voice.
  let audioInputs = [], audioMap;
  if (voiced) {
    const first = n; // audio inputs come after all image inputs
    vo.files.forEach(f => audioInputs.push('-i', f));
    const pads = scenes.map((s, i) => `[${first + i}:a]aresample=44100,aformat=channel_layouts=mono,apad=whole_dur=${s.dur.toFixed(3)},atrim=0:${s.dur.toFixed(3)}[a${i}]`);
    parts.push(`anullsrc=r=44100:cl=mono,atrim=0:0.3[a0s]`, ...pads,
      `[a0s]${scenes.map((_, i) => `[a${i}]`).join('')}concat=n=${scenes.length + 1}:v=0:a=1,loudnorm=I=-16:TP=-1.5,apad=whole_dur=${total.toFixed(3)},atrim=0:${total.toFixed(3)}[aout]`);
    audioMap = '[aout]';
  } else {
    audioInputs = ['-f', 'lavfi', '-t', String(total), '-i', 'anullsrc=r=44100:cl=stereo'];
    audioMap = `${n}:a`;
  }
  run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...inputs, ...audioInputs, '-filter_complex', parts.join(';'),
    '-map', '[v]', '-map', audioMap, '-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-t', total.toFixed(2), '-movflags', '+faststart', outFile]);
  return { file: outFile, seconds: total, voiced, voice_engine: vo.engine, covers: covers.length, background: hasBg, logo: hasLogo, font: job.font || 'kantumruy', scenes: scenes.map(s => s.lines) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [jobFile, out] = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const res = await renderPromo(JSON.parse(readFileSync(jobFile, 'utf8')), resolve(out), { voice: !process.argv.includes('--no-voice') });
  console.log(JSON.stringify(res));
}
