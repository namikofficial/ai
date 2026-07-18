ALTER TABLE workflow_executions ADD COLUMN recovery_workflow_ids_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE workflow_executions ADD COLUMN recovery_of_execution_id TEXT;

CREATE TABLE IF NOT EXISTS workflow_recoveries (
  original_execution_id TEXT NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
  recovery_execution_id TEXT NOT NULL UNIQUE REFERENCES workflow_executions(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  PRIMARY KEY (original_execution_id, recovery_execution_id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_recoveries_original
  ON workflow_recoveries(original_execution_id, requested_at DESC);
