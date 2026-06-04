-- Code intelligence graph tables.

CREATE TABLE IF NOT EXISTS code_symbols (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  path TEXT NOT NULL,
  language TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  signature TEXT,
  doc TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_code_symbols_project_path
  ON code_symbols(project_id, path, kind);
CREATE INDEX IF NOT EXISTS idx_code_symbols_file
  ON code_symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_code_symbols_name
  ON code_symbols(project_id, name);

CREATE TABLE IF NOT EXISTS code_edges (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  from_symbol_id TEXT NOT NULL,
  to_symbol_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_code_edges_project_from
  ON code_edges(project_id, from_symbol_id);
CREATE INDEX IF NOT EXISTS idx_code_edges_project_to
  ON code_edges(project_id, to_symbol_id);

CREATE TABLE IF NOT EXISTS code_symbol_chunks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  symbol_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  overlap_lines INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, symbol_id, chunk_id)
);

CREATE INDEX IF NOT EXISTS idx_code_symbol_chunks_symbol
  ON code_symbol_chunks(project_id, symbol_id);
CREATE INDEX IF NOT EXISTS idx_code_symbol_chunks_chunk
  ON code_symbol_chunks(project_id, chunk_id);

CREATE TABLE IF NOT EXISTS project_context_graphs (
  project_id TEXT PRIMARY KEY,
  summary_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
