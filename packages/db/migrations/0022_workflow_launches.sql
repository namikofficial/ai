-- Durable desktop launch handoff for interactive terminal and tmux workflows.

CREATE TABLE IF NOT EXISTS workflow_launches (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  session_id TEXT,
  task_id TEXT,
  mode TEXT NOT NULL,
  state TEXT NOT NULL,
  command_json TEXT NOT NULL,
  environment_json TEXT NOT NULL,
  tmux_session TEXT,
  token_hash TEXT,
  authorization_expires_at TEXT,
  launcher_instance_id TEXT,
  launcher_pid INTEGER,
  started_at TEXT,
  finished_at TEXT,
  exit_code INTEGER,
  origin_json TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(execution_id) REFERENCES workflow_executions(id) ON DELETE CASCADE,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workflow_launches_project_state
  ON workflow_launches(project_id, state, created_at DESC);
