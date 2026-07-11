-- Validation and learning memory events.
--
-- Every AI-generated patch runs a validation pipeline (format -> lint ->
-- typecheck -> test -> semgrep -> osv -> playwright). Each result is stored
-- here as a durable, queryable memory event so the local agent improves over
-- time. This is the SQLite-authoritative "memory_events" table described in
-- the knowledge-stack plan; it is intentionally separate from the
-- candidate/entry/fact memory tables.

CREATE TABLE IF NOT EXISTS memory_events (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  session_id TEXT,
  type TEXT NOT NULL,
  command TEXT,
  status TEXT,
  summary TEXT,
  source_ref TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_events_project ON memory_events (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_events_type ON memory_events (type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_events_session ON memory_events (session_id, created_at DESC);
