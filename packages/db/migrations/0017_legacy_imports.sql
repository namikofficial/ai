-- Auditable, duplicate-safe provenance for compatibility imports.

CREATE TABLE IF NOT EXISTS legacy_import_runs (
  id TEXT PRIMARY KEY,
  source_system TEXT NOT NULL,
  source_database TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  backup_path TEXT NOT NULL,
  status TEXT NOT NULL,
  report_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_legacy_import_runs_source
  ON legacy_import_runs(source_system, source_database, started_at);

CREATE TABLE IF NOT EXISTS legacy_import_items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  source_system TEXT NOT NULL,
  source_database TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  project_id TEXT,
  destination_type TEXT,
  destination_id TEXT,
  status TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES legacy_import_runs(id) ON DELETE CASCADE,
  UNIQUE(source_system, source_database, source_table, source_id, source_hash)
);

CREATE INDEX IF NOT EXISTS idx_legacy_import_items_run
  ON legacy_import_items(run_id, status);

CREATE INDEX IF NOT EXISTS idx_legacy_import_items_destination
  ON legacy_import_items(destination_type, destination_id);
