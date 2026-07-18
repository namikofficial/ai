CREATE TABLE IF NOT EXISTS workflow_step_executions (
  execution_id TEXT NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  workflow_id TEXT,
  state TEXT NOT NULL,
  command_json TEXT,
  attempts_json TEXT NOT NULL DEFAULT '[]',
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  error_code TEXT,
  error_summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (execution_id, step_id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_step_executions_state
  ON workflow_step_executions(execution_id, state, updated_at);
