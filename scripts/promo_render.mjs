// Renders one BookShareKH promo video (9:16) from a job JSON. Runs on the GitHub runner and locally.
//   node scripts/promo_render.mjs <job.json> <out.mp4> [--no-voice]
// job: { scenes: [{ text, voice }], covers: [https urls], voice: "km-KH-SreymomNeural" }
// - Khmer voice-over per scene with edge-tts (if installed); each scene's text stays on screen while it is spoken.
// - Khmer has no spaces between words: lines are wrapped at word boundaries with Intl.Segmenter('km').
// - Fonts come from assets/fonts (Noto Sans Khmer), so the runner and a local check render the same.
// - Book covers are only the background visuals; the message is about the website.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchImage } from './fetch_image.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FONTS = join(ROOT, 'assets', 'fonts');
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
export function wrapKhmer(text, max = 13) {
  const words = [...new Intl.Segmenter('km', { granularity: 'word' }).segment(String(text).replace(/\s+/g, ' ').trim())].map(s => s.segment);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (cur && graphemes((cur + w).trim()) > max) { lines.push(cur.trim()); cur = w.trimStart(); }
    else cur += w;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines.slice(0, 4);
}
// Neutralise ASS override blocks and escapes in untrusted text.
const assText = s => String(s).replace(/\\/g, '/').replace(/[{}]/g, m => (m === '{' ? '(' : ')'));
const ts = t => { const cs = Math.max(0, Math.round(t * 100)); const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, s = Math.floor(cs / 100) % 60; return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`; };

function assFile(scenes, total) {
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Scene,Noto Sans Khmer,62,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,3,22,0,8,40,40,140,1
Style: Brand,Noto Sans Khmer,50,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,4,2,2,40,40,150,1
Style: Url,Noto Sans Khmer,42,&H0000D7FF,&H0000D7FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,3,2,2,40,40,92,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const ev = scenes.map(s => `Dialogue: 1,${ts(s.start)},${ts(s.end)},Scene,,0,0,0,,{\\fad(180,120)}${s.lines.map(assText).join('\\N')}`);
  ev.push(`Dialogue: 0,${ts(0)},${ts(total)},Brand,,0,0,0,,BookShareKH`);
  ev.push(`Dialogue: 0,${ts(0)},${ts(total)},Url,,0,0,0,,booksharekh.com`);
  return head + ev.join('\n') + '\n';
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

function speak(text, voice, file) {
  const r = spawnSync(EDGE_TTS, ['--voice', voice, '--text', text, '--write-media', file], { encoding: 'utf8', timeout: 90000 });
  return r.status === 0 && existsSync(file) && statSync(file).size > 1000;
}

export async function renderPromo(job, outFile, { voice: useVoice = true } = {}) {
  const work = join(dirname(outFile), 'promo-work');
  mkdirSync(work, { recursive: true });
  const raw = (job.scenes || []).filter(s => s?.text).slice(0, 6);
  if (!raw.length) throw new Error('No scenes');

  // Voice-over: all scenes or none (a half-voiced video looks broken).
  const voiceName = /^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/.test(job.voice || '') ? job.voice : 'km-KH-SreymomNeural';
  let voiced = useVoice;
  const audio = [];
  if (voiced) {
    for (let i = 0; i < raw.length && voiced; i++) {
      const f = join(work, `voice${i}.mp3`);
      if (speak(String(raw[i].voice || raw[i].text).slice(0, 400), voiceName, f)) audio.push(f); else voiced = false;
    }
    if (!voiced) console.log('voice-over unavailable: rendering without voice');
  }

  // Timeline: each scene lasts as long as its voice (+ a short pause), or a reading time without voice.
  let t = 0.3;
  const scenes = raw.map((s, i) => {
    const len = voiced ? probeDuration(audio[i]) + 0.45 : Math.min(Math.max(graphemes(s.text) * 0.11 + 1.6, 2.6), 5);
    const sc = { lines: wrapKhmer(s.text), start: t, end: t + len, dur: len };
    t += len;
    return sc;
  });
  const total = Math.min(t + 1.2, 59);
  writeFileSync(join(work, 'promo.ass'), assFile(scenes, total), 'utf8');

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
  const inputs = ['-f', 'lavfi', '-t', String(total), '-i', `color=c=0x0f172a:s=${W}x${H}:r=${FPS}`];
  let n = 1;
  const bgIdx = hasBg ? n++ : -1;
  if (hasBg) inputs.push('-loop', '1', '-t', String(total), '-i', bgFile);
  const coverIdx = covers.map(() => n++);
  for (const c of covers) inputs.push('-loop', '1', '-t', String(total), '-i', c);
  const logoIdx = hasLogo ? n++ : -1;
  if (hasLogo) inputs.push('-loop', '1', '-t', String(total), '-i', logoFile);
  const parts = [];
  let base = '[0:v]';
  // Background: the website photo (lightly blurred, darkened, slow zoom-in) or else the first cover, blurred.
  if (hasBg) {
    const BW = Math.round(W * 1.12 / 2) * 2, BH = Math.round(H * 1.12 / 2) * 2; // 12% larger for the slow pan
    parts.push(`[${bgIdx}:v]scale=${BW}:${BH}:force_original_aspect_ratio=increase,crop=${BW}:${BH},boxblur=4:1,eq=brightness=-0.30:saturation=0.9,` +
      `crop=${W}:${H}:x='(iw-${W})/2*(1-t/${total.toFixed(2)})':y='(ih-${H})/2',setsar=1[bgc]`);
  } else if (covers.length) {
    parts.push(`[${coverIdx[0]}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=30:2,eq=brightness=-0.32:saturation=0.8,setsar=1[bgc]`);
  }
  if (hasBg || covers.length) { parts.push(`${base}[bgc]overlay=0:0[b0]`); base = '[b0]'; }
  if (covers.length) {
    // Layout: side covers smaller and behind, centre cover in front.
    const slots = covers.length === 1 ? [{ w: 360, x: (W - 360) / 2, y: 480, d: 0.2 }]
      : covers.length === 2 ? [{ w: 280, x: 70, y: 520, d: 0.2 }, { w: 280, x: W - 350, y: 520, d: 0.45 }]
        : [{ w: 240, x: 28, y: 550, d: 0.35 }, { w: 240, x: W - 268, y: 550, d: 0.55 }, { w: 320, x: (W - 320) / 2, y: 490, d: 0.15 }];
    const order = covers.length === 3 ? [1, 2, 0] : covers.map((_, i) => i); // centre slot uses the first cover
    slots.forEach((s, k) => {
      const inIdx = coverIdx[order[k]];
      const h = Math.round(s.w * 1.5);
      parts.push(`[${inIdx}:v]scale=${s.w}:${h}:force_original_aspect_ratio=decrease,pad=${s.w + 8}:${h + 8}:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1[c${k}]`);
      // Slide up from below over 0.6 s, starting at d seconds.
      parts.push(`${base}[c${k}]overlay=x=${Math.round(s.x)}:y='${s.y}+720*max(0\\,1-max(0\\,t-${s.d})/0.6)'[b${k + 1}]`);
      base = `[b${k + 1}]`;
    });
  }
  // Logo: small, centred at the top, on a white rounded badge so it reads on any background.
  if (hasLogo) {
    parts.push(`[${logoIdx}:v]scale=78:78:force_original_aspect_ratio=decrease,pad=96:96:(ow-iw)/2:(oh-ih)/2:color=white@0.92,format=rgba,setsar=1[logo]`);
    parts.push(`${base}[logo]overlay=x=(W-w)/2:y=10[bl]`);
    base = '[bl]';
  }
  const assPath = join(work, 'promo.ass').replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:');
  const fontsDir = FONTS.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:');
  parts.push(`${base}subtitles='${assPath}':fontsdir='${fontsDir}',fade=t=in:st=0:d=0.3,fade=t=out:st=${(total - 0.4).toFixed(2)}:d=0.4,format=yuv420p[v]`);

  // Audio: each voice clip padded to its scene length, then concatenated; silence without voice.
  let audioInputs = [], audioMap;
  if (voiced) {
    const first = n; // audio inputs come after all image inputs
    audio.forEach(f => audioInputs.push('-i', f));
    const pads = scenes.map((s, i) => `[${first + i}:a]aresample=44100,apad=whole_dur=${s.dur.toFixed(3)},atrim=0:${s.dur.toFixed(3)}[a${i}]`);
    parts.push(`anullsrc=r=44100:cl=mono,atrim=0:0.3[a0s]`, ...pads,
      `[a0s]${scenes.map((_, i) => `[a${i}]`).join('')}concat=n=${scenes.length + 1}:v=0:a=1,apad=whole_dur=${total.toFixed(3)},atrim=0:${total.toFixed(3)}[aout]`);
    audioMap = '[aout]';
  } else {
    audioInputs = ['-f', 'lavfi', '-t', String(total), '-i', 'anullsrc=r=44100:cl=stereo'];
    audioMap = `${n}:a`;
  }
  run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...inputs, ...audioInputs, '-filter_complex', parts.join(';'),
    '-map', '[v]', '-map', audioMap, '-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
    '-c:a', 'aac', '-b:a', '128k', '-t', total.toFixed(2), '-movflags', '+faststart', outFile]);
  return { file: outFile, seconds: total, voiced, covers: covers.length, background: hasBg, logo: hasLogo, scenes: scenes.map(s => s.lines) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [jobFile, out] = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const res = await renderPromo(JSON.parse(readFileSync(jobFile, 'utf8')), resolve(out), { voice: !process.argv.includes('--no-voice') });
  console.log(JSON.stringify(res));
}
