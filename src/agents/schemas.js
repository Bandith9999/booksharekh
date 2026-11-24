// Structured output contracts, shared by every provider. Strict-mode compatible:
// every object lists all properties in `required` and sets additionalProperties: false.
export const AGENT_NAMES = ['manager', 'book_researcher', 'book_editor', 'content_creator', 'video_creator', 'laravel_developer', 'qa_reviewer', 'website_ops'];

export const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'steps', 'risks', 'needs_rights_verification'],
  properties: {
    summary: { type: 'string', minLength: 1, maxLength: 600 },
    steps: {
      type: 'array', minItems: 1, maxItems: 6,
      items: {
        type: 'object', additionalProperties: false, required: ['agent', 'objective'],
        properties: {
          agent: { type: 'string', enum: AGENT_NAMES.filter(n => n !== 'manager') },
          objective: { type: 'string', minLength: 1, maxLength: 300 },
        },
      },
    },
    risks: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 200 } },
    needs_rights_verification: { type: 'boolean' },
  },
};

// Book Researcher output (Phase 3). Facts carry sources; confidence is null unless evidence supports a value.
export const RESEARCH_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['agent', 'title', 'author', 'first_publication_year', 'language', 'isbn', 'metadata_source', 'sources', 'rights_status', 'confidence', 'ai_interpretation', 'status'],
  properties: {
    agent: { type: 'string', enum: ['book_researcher'] },
    title: { type: 'string', maxLength: 300 },
    author: { type: ['string', 'null'], maxLength: 200 },
    first_publication_year: { type: ['integer', 'null'] },
    language: { type: ['string', 'null'], maxLength: 50 },
    isbn: { type: ['string', 'null'], maxLength: 20 },
    metadata_source: { type: 'string', maxLength: 100 },
    sources: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 300 } },
    rights_status: { type: 'string', enum: ['requires_verification', 'public_domain_verified', 'licensed', 'restricted'] },
    confidence: { type: ['number', 'null'], minimum: 0, maximum: 1 },
    ai_interpretation: { type: 'string', maxLength: 1000 },
    status: { type: 'string', enum: ['awaiting_review'] },
  },
};

// QA Reviewer verdict (Phase 3). QA approval never replaces owner approval.
export const QA_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['agent', 'task_id', 'result', 'issues', 'human_approval_required'],
  properties: {
    agent: { type: 'string', enum: ['qa_reviewer'] },
    task_id: { type: 'string', maxLength: 64 },
    result: { type: 'string', enum: ['approved', 'requires_changes', 'rejected'] },
    issues: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 300 } },
    human_approval_required: { type: 'boolean' },
  },
};
