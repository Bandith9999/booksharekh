-- 0002: multi-agent foundation (Phase 2).
-- Additive only: creates new tables and indexes. Existing tables (memories, tasks,
-- telegram_updates, audit_log) and their rows are not modified.

-- Per-agent overrides. NULL provider/model = use the agent's tier from wrangler vars.
CREATE TABLE IF NOT EXISTS agents (
  name TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  provider TEXT CHECK (provider IS NULL OR provider IN ('anthropic', 'openai', 'google', 'mock')),
  model TEXT,
  max_attempts INTEGER CHECK (max_attempts IS NULL OR max_attempts BETWEEN 1 AND 5),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT
);
INSERT OR IGNORE INTO agents (name) VALUES
  ('manager'), ('book_researcher'), ('book_editor'), ('content_creator'),
  ('video_creator'), ('laravel_developer'), ('qa_reviewer');

-- Steps of a task, each owned by one agent. parent_agent_task_id allows nested sub-steps.
CREATE TABLE IF NOT EXISTS agent_tasks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  parent_agent_task_id TEXT REFERENCES agent_tasks(id),
  agent TEXT NOT NULL REFERENCES agents(name),
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending', 'awaiting_approval', 'queued', 'running', 'qa_review', 'revision_required',
     'completed', 'failed', 'cancelled', 'rejected')),
  input TEXT,
  output TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 5),
  idempotency_key TEXT NOT NULL UNIQUE,
  lease_until TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_task ON agent_tasks(task_id);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status);

CREATE TABLE IF NOT EXISTS task_dependencies (
  agent_task_id TEXT NOT NULL REFERENCES agent_tasks(id),
  depends_on_id TEXT NOT NULL REFERENCES agent_tasks(id),
  PRIMARY KEY (agent_task_id, depends_on_id),
  CHECK (agent_task_id <> depends_on_id)
);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_on ON task_dependencies(depends_on_id);

-- Owner approvals: bound to task, step, action type and the exact payload (SHA-256).
CREATE TABLE IF NOT EXISTS task_approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  agent_task_id TEXT REFERENCES agent_tasks(id),
  action_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN
    ('requested', 'approved', 'rejected', 'expired', 'revoked', 'executing', 'executed', 'failed')),
  requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  executed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_approvals_task ON task_approvals(task_id);
-- At most one open approval per step.
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_approvals_open ON task_approvals(agent_task_id)
  WHERE status IN ('requested', 'approved', 'executing');

-- Small structured outputs and references to external files (GitHub runs, later R2 keys).
CREATE TABLE IF NOT EXISTS task_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  agent_task_id TEXT REFERENCES agent_tasks(id),
  kind TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  uri TEXT,
  content TEXT CHECK (content IS NULL OR length(content) <= 100000),
  content_type TEXT,
  sha256 TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (task_id, kind, version)
);

-- One row per model call: provider, model, outcome, tokens, timing, prompt version.
CREATE TABLE IF NOT EXISTS agent_execution_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT REFERENCES tasks(id),
  agent_task_id TEXT REFERENCES agent_tasks(id),
  agent TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  attempt INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'error', 'refusal')),
  error_kind TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  prompt_version TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_execution_logs_task ON agent_execution_logs(task_id);
CREATE INDEX IF NOT EXISTS idx_execution_logs_created ON agent_execution_logs(created_at);

-- GitHub Actions dispatches: at most one per approval (approval_id UNIQUE).
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  agent_task_id TEXT REFERENCES agent_tasks(id),
  approval_id TEXT NOT NULL UNIQUE REFERENCES task_approvals(id),
  workflow TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('dispatching', 'dispatched', 'completed', 'failed', 'unknown')),
  attempts INTEGER NOT NULL DEFAULT 1,
  run_url TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_task ON workflow_runs(task_id);
