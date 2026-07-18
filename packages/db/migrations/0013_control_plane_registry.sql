-- Canonical project registry foundation for the unified control plane.
-- Manifests remain versioned JSON contracts; SQLite owns approval and selection state.

CREATE TABLE IF NOT EXISTS project_manifests (
  project_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  manifest_json TEXT NOT NULL,
  approved_source TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_manifest_proposals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  manifest_json TEXT NOT NULL,
  source_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_manifest_proposals_project_status
  ON project_manifest_proposals (project_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS active_project_selection (
  singleton_id TEXT PRIMARY KEY CHECK (singleton_id = 'active'),
  project_id TEXT,
  source TEXT NOT NULL,
  pin_scope TEXT CHECK (pin_scope IS NULL OR pin_scope IN ('workspace', 'session', 'persistent')),
  selected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE SET NULL
);
