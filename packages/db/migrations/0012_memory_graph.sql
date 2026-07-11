-- Memory graph upgrade (Mem0/Graphiti-style, SQLite-authoritative).
--
-- Adds temporal validity windows to facts and introduces a lightweight
-- entity/relation graph. The graph stays local; Graphiti/Mem0 remain
-- optional adapters behind a flag and must never become the source of truth.

-- Temporal validity for facts. A fact is valid for [valid_at, invalid_at).
-- NULL bounds mean open-ended. Contradiction detection compares proposals
-- against facts whose window contains "now".
ALTER TABLE facts ADD COLUMN valid_at TEXT;
ALTER TABLE facts ADD COLUMN invalid_at TEXT;

CREATE TABLE IF NOT EXISTS memory_graph_nodes (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  entity TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'entity',
  label TEXT NOT NULL,
  value TEXT,
  valid_at TEXT,
  invalid_at TEXT,
  source_kind TEXT NOT NULL DEFAULT 'reflection',
  source_ref TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_graph_edges (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  valid_at TEXT,
  invalid_at TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL,
  FOREIGN KEY (source_node_id) REFERENCES memory_graph_nodes (id) ON DELETE CASCADE,
  FOREIGN KEY (target_node_id) REFERENCES memory_graph_nodes (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_graph_nodes_project ON memory_graph_nodes (project_id, entity);
CREATE INDEX IF NOT EXISTS idx_graph_edges_project ON memory_graph_edges (project_id, relation);
CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON memory_graph_edges (source_node_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON memory_graph_edges (target_node_id);
