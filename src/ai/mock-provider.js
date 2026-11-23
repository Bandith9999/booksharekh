// Deterministic provider for demos and tests (AI_DEFAULT_PROVIDER=mock). Never calls the network.
import { clamp } from '../helpers.js';
import { AIError } from './errors.js';
import { makeResponse } from './provider-interface.js';
import { parseStructured } from './schema.js';

function managerPlan({ taskType, request }) {
  const video = taskType === 'video_demo';
  const step = taskType === 'website_code_change'
    ? { agent: 'laravel_developer', objective: 'Change the website code on a branch and open a pull request for review' }
    : { agent: video ? 'video_creator' : 'book_researcher', objective: video ? 'Render an 8-second sample-card video in GitHub Actions' : 'Write a short text report in GitHub Actions' };
  return {
    summary: `[DEMO: mock AI provider] ${clamp(request, 200)}`,
    steps: [step],
    risks: ['No book files, website updates or social posts will be performed.'],
    needs_rights_verification: false,
  };
}

// Video Creator promo scripts (demo text; a real provider writes the Khmer copy).
function promoScripts({ books = [] }) {
  return { videos: books.map(b => ({
    book_id: b.id, hook: 'សៀវភៅល្អៗ សម្រាប់អ្នក', lines: [clamp(b.title, 60), 'អានឥឡូវនេះ'],
    caption: `[DEMO] ${clamp(b.title, 100)}\nអានលើ BookShareKH\n📖 booksharekh.com`, hashtags: ['#BookShareKH', '#សៀវភៅ', '#Books'],
  })) };
}

export const mockProvider = {
  name: 'mock',
  keyName: null,
  modelPattern: /^mock$/,

  async generate(env, req) {
    const responders = { manager: () => managerPlan(req.metadata || {}), video_creator: () => promoScripts(req.metadata || {}) };
    if (!responders[req.agent]) throw new AIError(`mock provider has no responder for agent ${req.agent}`, { kind: 'config', provider: 'mock' });
    const content = JSON.stringify(responders[req.agent]());
    return makeResponse({
      provider: 'mock', model: 'mock', content,
      structuredOutput: req.responseSchema ? parseStructured(content, req.responseSchema, 'mock') : undefined,
    });
  },

  async checkModel() { return { ok: true, status: 200, detail: '', hint: '' }; },
};
