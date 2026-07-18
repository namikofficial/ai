-- Durable executions for approved project-manifest workflows.

CREATE TABLE IF NOT EXISTS workflow_executions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  session_id TEXT,
  task_id TEXT,
  run_id TEXT,
  state TEXT NOT NULL,
  current_step_id TEXT,
  step_states_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT,
  finished_at TEXT,
  approval_id TEXT,
  exit_code INTEGER,
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  error_code TEXT,
  error_summary TEXT,
  command_json TEXT NOT NULL,
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  origin_json TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workflow_executions_project
  ON workflow_executions(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_executions_workflow
  ON workflow_executions(workflow_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_executions_state
  ON workflow_executions(state, updated_at DESC);
