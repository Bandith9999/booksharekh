// Posters: the owner's topic, topic book search, and designs that change from poster to poster.
import test from 'node:test';
import assert from 'node:assert/strict';
import { drain, makeEnv, mockFetch, msg, routes, telegram } from './harness.mjs';
import { POSTER_DESIGN, pickDesign, topicKeywords } from '../src/marketing/poster.js';

const SITE = 'https://booksharekh.com';
const book = (id, title) => ({ id, title, author: 'A', cover_url: `${SITE}/covers/${id}.jpg` });

test('topic keywords: filler words dropped, plurals trimmed', () => {
  assert.deepEqual(topicKeywords('design about the 5 books of the parenting for parents'), ['parenting', 'parent']);
  assert.deepEqual(topicKeywords('poster'), []);
});

test('designs: valid, never the same palette or font as the last poster; the layout follows the content', () => {
  const last = { layout: 'list', palette: 'cream', font: 'fasthand', decor: 'none' };
  const d = pickDesign({ layout: 'list', palette: 'cream', font: 'fasthand', decor: 'tape' }, [last]);
  assert.equal(d.layout, 'list', 'a list of books may follow a list of books');
  assert.notEqual(d.palette, 'cream'); assert.notEqual(d.font, 'fasthand');
  for (const k of Object.keys(POSTER_DESIGN)) assert.ok(POSTER_DESIGN[k].includes(d[k]), k);
  assert.equal(pickDesign({ layout: 'nope', palette: 'x' }, [], { kind: 'motivation' }).layout, 'quote');
  assert.equal(pickDesign({ layout: 'nope' }, [], { kind: 'books' }).layout, 'list');
});

test('no price talk outside website posters; the website comes up only 1 time in 10', async () => {
  const { POSTER_THEMES, posterFacts } = await import('../src/marketing/poster.js');
  assert.equal(POSTER_THEMES.filter(t => t.kind === 'website').length, 1);
  assert.ok(POSTER_THEMES.length >= 10);
  assert.doesNotMatch(posterFacts({ kind: 'books' }).join('\n'), /\$0\.50|KHQR/);
  assert.doesNotMatch(posterFacts({ topic: '3 books about love' }).join('\n'), /\$0\.50/);
  assert.match(posterFacts({ kind: 'website' }).join('\n'), /\$0\.50/);
  assert.match(posterFacts({ topic: 'why our website is cheap' }).join('\n'), /\$0\.50/);
});

test('/poster <topic>: the topic reaches the AI and the site is searched for matching books first', async () => {
  const e = makeEnv({ LARAVEL_API_URL: SITE, LARAVEL_API_TOKEN: 'bsk_ai_x' });
  const searched = [];
  mockFetch([routes.telegram,
    [/\/api\/ai\/books\/search/, url => { searched.push(new URL(url).searchParams.get('q')); return Response.json({ data: [book(9, 'Parenting with Love')] }); }],
    [/\/api\/ai\/(books\?|users\/activity)/, url => Response.json(url.includes('activity') ? { total_users: 5 } : { data: [book(1, 'Emma'), book(2, 'Dracula')] })]]);
  await telegram(e, msg('/marketing poster about 5 parenting books for parents'));
  const input = JSON.parse(e.DB.db.prepare("SELECT input FROM agent_tasks WHERE action='write_poster'").get().input);
  assert.equal(input.topic, '5 parenting books for parents');
  assert.ok(searched.includes('parenting'));
  assert.deepEqual(input.candidates.map(c => [c.id, c.kind]).slice(0, 2), [[9, 'match'], [1, 'popular']]);
  await drain(e);
  const art = JSON.parse(e.DB.db.prepare("SELECT content FROM task_artifacts WHERE kind='poster'").get().content);
  assert.equal(art.posters[0].topic, '5 parenting books for parents');
  assert.ok(POSTER_DESIGN.layout.includes(art.posters[0].design.layout));
});
