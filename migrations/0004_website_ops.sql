-- 0004: Website Operations agent (weekly website inspection, owner-approved corrections).
-- Additive only.
INSERT OR IGNORE INTO agents (name) VALUES ('website_ops');

-- One row per distinct problem. fingerprint = kind + record + proposed change, so the same
-- proposal is never sent twice and a rejected one is not repeated unless the evidence changes.
CREATE TABLE IF NOT EXISTS ops_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  area TEXT NOT NULL,                 -- books | genres | authors | categories | files | reviews | media | requests | health | dev
  ref TEXT,                           -- record reference, e.g. book:12
  line TEXT NOT NULL,                 -- one-line description for Telegram (deterministic)
  op TEXT,                            -- JSON change for /api/ai/ops/apply, or NULL (report only)
  risk TEXT NOT NULL DEFAULT 'low' CHECK (risk IN ('low', 'medium', 'high')),
  safe INTEGER NOT NULL DEFAULT 0,    -- 1 = may be approved in the "safe batch" (never destructive)
  source TEXT NOT NULL DEFAULT 'rule' CHECK (source IN ('rule', 'ai')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN
    ('open', 'approved', 'executing', 'applied', 'failed', 'rejected', 'revise', 'resolved', 'stale', 'rolled_back', 'assigned')),
  run_id INTEGER,                     -- run that first found it
  last_run_id INTEGER,                -- last run that still saw it
  batch_id TEXT,                      -- approval id used for /apply (rollback key)
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  first_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TEXT,
  applied_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ops_findings_status ON ops_findings(status, area);
CREATE INDEX IF NOT EXISTS idx_ops_findings_batch ON ops_findings(batch_id);

CREATE TABLE IF NOT EXISTS ops_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger TEXT NOT NULL,              -- schedule | manual
  task_id TEXT,                       -- tasks row used for AI call logging and budgets
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  books_checked INTEGER NOT NULL DEFAULT 0,
  rule_checks INTEGER NOT NULL DEFAULT 0,  -- records checked by code (no AI)
  ai_items INTEGER NOT NULL DEFAULT 0,     -- records sent to an AI
  ai_cached INTEGER NOT NULL DEFAULT 0,    -- records answered from the AI cache
  new_findings INTEGER NOT NULL DEFAULT 0,
  summary TEXT,                       -- JSON counts shown in the weekly message
  error TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT
);

-- Cached AI answers and link checks, keyed by record; reused while the record's fingerprint is unchanged.
CREATE TABLE IF NOT EXISTS ops_cache (
  key TEXT PRIMARY KEY,               -- e.g. genre:12, review:55, yt:dQw4w9WgXcQ
  fingerprint TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
