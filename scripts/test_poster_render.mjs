// CI check on the GitHub runner: render a poster with headless Chrome and verify the PNG.
import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { H, W, posterHtml, renderPoster } from './poster_render.mjs';

const out = resolve('output');
mkdirSync(out, { recursive: true });

// Text from the AI is escaped: no HTML or script can reach the page.
const html = posterHtml({ heading: '<script>x</script>', quote: '<b>a</b>', books: [{ title: '"><img>', note: '<i>n</i>' }] });
assert.ok(!html.includes('<script>x') && !html.includes('<b>a</b>') && !html.includes('"><img>') && !html.includes('<i>n</i>'));
// No button and no website address on the poster (owner request 2026-11-25).
assert.ok(!/booksharekh.com|class="btn"/.test(posterHtml({ heading: 'x', quote: 'y' })));

const file = join(out, 'poster.png');
const res = await renderPoster({
  layout: 'quote', palette: 'cream', font: 'fasthand', body_font: 'hanuman', decor: 'sparkle',
  heading: 'សម្រាប់ថ្ងៃដែលអ្នកអស់កម្លាំង', quote: 'មិនចាំបាច់អានច្រើនទេ គ្រាន់តែមួយទំព័ររៀងរាល់ថ្ងៃ ក៏អ្នកកំពុងរីកចម្រើនដែរ',
  covers: [], logo_url: 'https://booksharekh.com/dist/img/logo/logo.png',
}, file);
const info = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,codec_name', '-of', 'json', file], { encoding: 'utf8' }).stdout).streams[0];
assert.equal(info.codec_name, 'png');
assert.deepEqual([info.width, info.height], [W, H]);
assert.ok(statSync(file).size > 30000, 'not blank');
console.log(`poster: ${info.width}x${info.height}, ${Math.round(statSync(file).size / 1024)} KB, logo=${res.logo}`);
console.log('poster render OK');
