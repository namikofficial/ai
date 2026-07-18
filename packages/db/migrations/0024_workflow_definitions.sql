CREATE TABLE IF NOT EXISTS workflow_definitions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('manifest', 'manual', 'import')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_definitions_project_updated
  ON workflow_definitions(project_id, updated_at DESC);
