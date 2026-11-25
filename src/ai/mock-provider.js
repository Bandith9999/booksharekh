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
function promoScripts({ theme = '', kind, candidate_ids = [] }) {
  return {
    title: 'BookShareKH [DEMO]', kind: kind || 'education', background: 'dist/img/library-bg.jpg',
    concept: 'Hook with a question, one simple idea from a book, an everyday example, end with a question to the viewer. Calm minimal look.',
    design: { style: 'minimal', font: 'kdamthmor', body_font: 'battambang', palette: 'ocean' }, voice_style: 'calm, warm young Cambodian woman, thoughtful pace',
    cover_ids: candidate_ids.slice(0, 2),
    scenes: [
      { text: 'ចង់អានសៀវភៅល្អៗ?', voice: 'ចង់អានសៀវភៅល្អៗមែនទេ?', book: -1 },
      { text: 'អានមួយថ្ងៃ ១០ ទំព័រ', voice: 'សាកអានមួយថ្ងៃដប់ទំព័រ', book: 0 },
      { text: 'តើអ្នកនឹងចាប់ផ្តើមថ្ងៃណា?', voice: 'តើអ្នកនឹងចាប់ផ្តើមថ្ងៃណា?', book: 1 },
    ],
    caption: `[DEMO] ${clamp(theme, 80)}\nតើអ្នកអានប៉ុន្មានទំព័រក្នុងមួយថ្ងៃ?\n📖 booksharekh.com`, hashtags: ['#BookShareKH', '#សៀវភៅ', '#Books'],
  };
}

// Content Creator poster text (demo).
const posterText = ({ candidate_ids = [] } = {}) => ({ cover_ids: candidate_ids.slice(0, 2), kind: 'books',
  title: 'Poster [DEMO]', design: { layout: 'list', palette: 'cream', font: 'fasthand', body_font: 'kantumruy', decor: 'none' },
  heading: 'ស្នេហា និងទំនាក់ទំនង', quote: '', book_notes: ['រឿងស្នេហាដ៏ស្រទន់ ពោរពេញដោយអារម្មណ៍', 'រឿងដែលធ្វើឲ្យអ្នកគិតយូរ'],
  caption: '[DEMO] តើអ្នកនឹងអានសៀវភៅមួយណាមុន?\n📖 booksharekh.com', hashtags: ['#BookShareKH', '#សៀវភៅ', '#Reading'],
});

// Website Operations (demo): every book gets the last listed genre; reviews mentioning "buy now" are spam.
const opsAnswer = (m = {}) => (m.kind === 'genres'
  ? { items: (m.ids || []).map(id => ({ id, genre_ids: (m.genre_ids || []).slice(-1), confidence: 'high' })) }
  : { items: (m.ids || []).map(id => ({ id, label: (m.spam_ids || []).includes(id) ? 'spam' : 'ok' })) });

export const mockProvider = {
  name: 'mock',
  keyName: null,
  modelPattern: /^mock$/,

  async generate(env, req) {
    const responders = { manager: () => managerPlan(req.metadata || {}), video_creator: () => promoScripts(req.metadata || {}), content_creator: () => posterText(req.metadata || {}), website_ops: () => opsAnswer(req.metadata || {}),
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
