-- Separate, approval-gated lifecycle for deleting retained workflow workspaces.

CREATE TABLE IF NOT EXISTS workflow_artifact_cleanups (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'rejected', 'expired', 'failed')),
  target_path TEXT NOT NULL,
  target_hash TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  notes TEXT,
  error_summary TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_artifact_cleanups_execution
  ON workflow_artifact_cleanups(execution_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_workflow_artifact_cleanups_status
  ON workflow_artifact_cleanups(status, expires_at);
