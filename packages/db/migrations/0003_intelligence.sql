-- 0003_intelligence.sql: embedding metadata, path boosts, retrieval feedback.

ALTER TABLE rag_chunks ADD COLUMN embedding_model TEXT;
ALTER TABLE rag_chunks ADD COLUMN embedding_dim INTEGER;
ALTER TABLE rag_chunks ADD COLUMN embedding_provider TEXT;

CREATE INDEX IF NOT EXISTS idx_rag_chunks_embedding_model ON rag_chunks(embedding_model);

CREATE TABLE IF NOT EXISTS chunk_path_boosts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 0.5,
  source TEXT NOT NULL DEFAULT 'reflection',
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, path)
);

CREATE INDEX IF NOT EXISTS idx_chunk_path_boosts_project ON chunk_path_boosts(project_id);

CREATE TABLE IF NOT EXISTS retrieval_path_feedback (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  retrieval_query_id TEXT,
  path TEXT NOT NULL,
  rating TEXT NOT NULL CHECK (rating IN ('good', 'bad', 'missed')),
  weight REAL NOT NULL DEFAULT 0.5,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_retrieval_path_feedback_project ON retrieval_path_feedback(project_id);
CREATE INDEX IF NOT EXISTS idx_retrieval_path_feedback_query ON retrieval_path_feedback(retrieval_query_id);

CREATE TABLE IF NOT EXISTS retrieval_query_rewrites_used (
  id TEXT PRIMARY KEY,
  retrieval_query_id TEXT NOT NULL,
  rewrite_id TEXT NOT NULL,
  result_count INTEGER NOT NULL DEFAULT 0,
  selected_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_retrieval_query_rewrites_used_query ON retrieval_query_rewrites_used(retrieval_query_id);

CREATE TABLE IF NOT EXISTS context_pack_dependencies (
  id TEXT PRIMARY KEY,
  context_pack_id TEXT NOT NULL,
  depends_on_pack_id TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(context_pack_id, depends_on_pack_id)
);
