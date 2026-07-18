CREATE TABLE IF NOT EXISTS workflow_background_jobs (
  execution_id TEXT PRIMARY KEY REFERENCES workflow_executions(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  worker_instance_id TEXT,
  process_pid INTEGER,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_background_jobs_state
  ON workflow_background_jobs(state, updated_at);
