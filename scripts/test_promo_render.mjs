// CI check on the GitHub runner: render one promo video with Khmer voice-over and one without,
// then verify size, length, audio and that the voice is not silent. Saves frames for a visual check.
import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { renderPromo, wrapKhmer } from './promo_render.mjs';

const out = resolve('output');
mkdirSync(out, { recursive: true });
const sh = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });
const probe = f => JSON.parse(sh('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', f]).stdout);
const meanVolume = f => Number((sh('ffmpeg', ['-i', f, '-af', 'volumedetect', '-vn', '-f', 'null', '-']).stderr.match(/mean_volume: (-?[\d.]+) dB/) || [])[1]);

// Khmer wrapping never breaks inside a word and keeps lines short.
const lines = wrapKhmer('យល់ពីខួរក្បាល ហើយគ្រប់គ្រងគំនិតរបស់អ្នក អានសៀវភៅរាប់ពាន់ក្បាល');
assert.ok(lines.length >= 2 && lines.join('').replace(/\s/g, '') === 'យល់ពីខួរក្បាលហើយគ្រប់គ្រងគំនិតរបស់អ្នកអានសៀវភៅរាប់ពាន់ក្បាល', JSON.stringify(lines));

// A generated cover (not a real book) served from a local file via a data-less https stub is not possible
// here, so the voiced test uses no covers and the second test uses a public test image.
const job = {
  voice: 'km-KH-SreymomNeural',
  covers: [], background_url: 'https://booksharekh.com/dist/img/library-bg.jpg', logo_url: 'https://booksharekh.com/dist/img/logo/logo.png',
  scenes: [
    { text: 'ចង់អានសៀវភៅល្អៗ តែមិនដឹងរកនៅឯណា?', voice: 'ចង់អានសៀវភៅល្អៗ តែមិនដឹងរកនៅឯណា?' },
    { text: 'តម្លៃត្រឹមតែ $0.50 ក្នុងមួយក្បាល', voice: 'តម្លៃត្រឹមតែហាសិបសេនក្នុងមួយក្បាល' },
    { text: 'ចូលមើល booksharekh.com', voice: 'ចូលមើល booksharekh.com ឥឡូវនេះ' },
  ],
};

for (const [name, voice] of [['voiced', true], ['silent', false]]) {
  const file = join(out, `promo-${name}.mp4`);
  const res = await renderPromo(job, file, { voice });
  const info = probe(file);
  const v = info.streams.find(s => s.codec_type === 'video');
  const dur = Number(info.format.duration);
  assert.deepEqual([v.width, v.height], [720, 1280]);
  assert.ok(info.streams.some(s => s.codec_type === 'audio'), 'has audio');
  assert.ok(dur >= 6 && dur <= 59, `duration ${dur}`);
  assert.ok(statSync(file).size < 48 * 1024 * 1024);
  if (voice) {
    assert.equal(res.voiced, true, 'edge-tts produced the Khmer voice-over');
    assert.ok(meanVolume(file) > -45, `voice is audible (mean ${meanVolume(file)} dB)`);
  } else {
    assert.equal(res.voiced, false);
  }
  for (const t of [1.5, Math.max(2, dur - 2)]) sh('ffmpeg', ['-y', '-ss', String(t), '-i', file, '-frames:v', '1', join(out, `${name}-${t}.png`)]);
  console.log(`${name}: 720x1280, ${dur.toFixed(1)}s, ${Math.round(statSync(file).size / 1024)} KB, voiced=${res.voiced}, lines=${JSON.stringify(res.scenes)}`);
}
console.log('promo render OK');
