-- Trace replay, session branching, and prompt lab tables.

CREATE TABLE IF NOT EXISTS session_replays (
  id TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL,
  child_session_id TEXT NOT NULL,
  source_session_id TEXT,
  mode TEXT NOT NULL,
  request_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(parent_session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY(child_session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_replays_parent_created
  ON session_replays(parent_session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_replays_child
  ON session_replays(child_session_id);

CREATE TABLE IF NOT EXISTS prompt_lab_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  project_id TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  selected_profiles_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES agent_sessions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_prompt_lab_runs_session_created
  ON prompt_lab_runs(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prompt_lab_runs_project_created
  ON prompt_lab_runs(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS prompt_lab_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  profile_name TEXT NOT NULL,
  model_name TEXT NOT NULL,
  status TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  output_text TEXT,
  error TEXT,
  approx_cost REAL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES prompt_lab_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_prompt_lab_results_run
  ON prompt_lab_results(run_id, created_at ASC);
