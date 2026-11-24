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

// Video Creator promo script about the website (demo text; a real provider writes the Khmer copy).
function promoScripts({ theme = '' }) {
  return {
    title: 'BookShareKH [DEMO]', background: 'dist/img/library-bg.jpg',
    design: { font: 'kdamthmor', body_font: 'battambang', palette: 'ocean' }, voice_style: 'warm, upbeat young Cambodian woman, medium pace',
    scenes: [
      { text: 'ចង់អានសៀវភៅល្អៗ?', voice: 'ចង់អានសៀវភៅល្អៗមែនទេ?' },
      { text: 'តម្លៃត្រឹមតែ $0.50', voice: 'តម្លៃត្រឹមតែហាសិបសេនក្នុងមួយក្បាល' },
      { text: 'ចូលមើល booksharekh.com', voice: 'ចូលមើល booksharekh.com ឥឡូវនេះ' },
    ],
    caption: `[DEMO] ${clamp(theme, 80)}\nអានសៀវភៅលើ BookShareKH\n📖 booksharekh.com`, hashtags: ['#BookShareKH', '#សៀវភៅ', '#Books'],
  };
}

// Content Creator poster text (demo).
const posterText = ({ candidate_ids = [] } = {}) => ({ cover_ids: candidate_ids.slice(0, 5),
  title: 'Poster [DEMO]', design: { layout: 'fan', palette: 'brand_night', font: 'koulen', body_font: 'kantumruy', decor: 'glow' }, background: 'dist/img/library-bg.jpg',
  kicker: '', headline: 'អានសៀវភៅល្អៗ គ្រប់ពេល', highlight: 'សៀវភៅល្អៗ', subline: 'សៀវភៅច្រើនប្រភេទ នៅកន្លែងតែមួយ', book_notes: [],
  points: ['តម្លៃ $0.50', 'បញ្ចូលលុយតាម KHQR'], cta: 'ចូលមើលឥឡូវនេះ',
  caption: '[DEMO] អានសៀវភៅលើ BookShareKH\n📖 booksharekh.com', hashtags: ['#BookShareKH', '#សៀវភៅ', '#Reading'],
});

export const mockProvider = {
  name: 'mock',
  keyName: null,
  modelPattern: /^mock$/,

  async generate(env, req) {
    const responders = { manager: () => managerPlan(req.metadata || {}), video_creator: () => promoScripts(req.metadata || {}), content_creator: () => posterText(req.metadata || {}),
      qa_reviewer: () => ({ agent: 'qa_reviewer', task_id: String(req.metadata?.task_id || ''), result: 'approved', issues: [], human_approval_required: true }) };
    if (!responders[req.agent]) throw new AIError(`mock provider has no responder for agent ${req.agent}`, { kind: 'config', provider: 'mock' });
    const content = JSON.stringify(responders[req.agent]());
    return makeResponse({
      provider: 'mock', model: 'mock', content,
      structuredOutput: req.responseSchema ? parseStructured(content, req.responseSchema, 'mock') : undefined,
    });
  },

  async checkModel() { return { ok: true, status: 200, detail: '', hint: '' }; },
};
