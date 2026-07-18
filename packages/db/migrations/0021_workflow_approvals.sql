-- Scoped approvals for mutating project-manifest workflows.

CREATE TABLE IF NOT EXISTS workflow_approvals (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL UNIQUE,
  workflow_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  mutation TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  branch TEXT,
  base_commit TEXT,
  reason TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(execution_id) REFERENCES workflow_executions(id) ON DELETE CASCADE,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workflow_approvals_project_status
  ON workflow_approvals(project_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_approvals_context
  ON workflow_approvals(workflow_id, context_hash, status);
