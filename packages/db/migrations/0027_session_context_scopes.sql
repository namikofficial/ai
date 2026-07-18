CREATE TABLE IF NOT EXISTS session_context_scopes (
  session_id TEXT PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  include_active_file INTEGER NOT NULL DEFAULT 1 CHECK (include_active_file IN (0, 1)),
  include_changed_files INTEGER NOT NULL DEFAULT 1 CHECK (include_changed_files IN (0, 1)),
  include_conversation INTEGER NOT NULL DEFAULT 1 CHECK (include_conversation IN (0, 1)),
  include_memory INTEGER NOT NULL DEFAULT 1 CHECK (include_memory IN (0, 1)),
  include_retrieval INTEGER NOT NULL DEFAULT 1 CHECK (include_retrieval IN (0, 1)),
  include_rules INTEGER NOT NULL DEFAULT 1 CHECK (include_rules IN (0, 1)),
  explicit_files_json TEXT NOT NULL DEFAULT '[]',
  excluded_paths_json TEXT NOT NULL DEFAULT '[]',
  token_budget INTEGER NOT NULL DEFAULT 8000 CHECK (token_budget BETWEEN 1000 AND 32000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO session_context_scopes (session_id, project_id, created_at, updated_at)
SELECT id, project_id, created_at, updated_at FROM agent_sessions;

CREATE TABLE IF NOT EXISTS session_context_consents (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('clipboard')),
  source_hash TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'denied')),
  purpose TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_context_consents_session
  ON session_context_consents(session_id, created_at DESC);
