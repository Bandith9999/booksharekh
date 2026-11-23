// CI check on the GitHub runner: render a poster with headless Chrome and verify the PNG.
import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { H, W, posterHtml, renderPoster } from './poster_render.mjs';

const out = resolve('output');
mkdirSync(out, { recursive: true });

// Text from the AI is escaped: no HTML or script can reach the page.
const html = posterHtml({ headline: '<script>x</script>', points: ['<b>a</b>'], cta: '"><img>' });
assert.ok(!html.includes('<script>x') && !html.includes('<b>a</b>') && !html.includes('"><img>'));

const file = join(out, 'poster.png');
const res = await renderPoster({
  headline: 'អានសៀវភៅល្អៗ គ្រប់ពេល គ្រប់ទីកន្លែង', subline: 'សៀវភៅច្រើនប្រភេទ នៅកន្លែងតែមួយ',
  points: ['តម្លៃ $0.50 ក្នុងមួយក្បាល', 'បញ្ចូលលុយតាម KHQR', 'សៀវភៅថ្មីរៀងរាល់សប្តាហ៍'], cta: 'ចូលមើលឥឡូវនេះ',
  covers: [], logo_url: 'https://booksharekh.com/dist/img/logo/logo.png',
}, file);
const info = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,codec_name', '-of', 'json', file], { encoding: 'utf8' }).stdout).streams[0];
assert.equal(info.codec_name, 'png');
assert.deepEqual([info.width, info.height], [W, H]);
assert.ok(statSync(file).size > 30000, 'not blank');
console.log(`poster: ${info.width}x${info.height}, ${Math.round(statSync(file).size / 1024)} KB, logo=${res.logo}`);
console.log('poster render OK');
