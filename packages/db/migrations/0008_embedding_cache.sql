-- Embedding cache.
--
-- Many indexing runs and retrieval passes re-embed the same chunks
-- (unchanged files, repeated queries, retried asks). The previous
-- setup recomputed the full embedding batch every time. This table
-- memoises each (provider_id, model_name, dimension, content_hash)
-- pair, so a second embed is a single SQLite lookup.
--
-- The cache is intentionally provider-scoped and dimension-scoped:
-- changing the embedding model or its dimension invalidates the
-- previous vectors automatically because the UNIQUE key changes.
-- The cache is independent of the project: one workspace, one box,
-- one cache, shared across every project.

CREATE TABLE IF NOT EXISTS embedding_cache (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  model_name TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  embedding_blob BLOB NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  UNIQUE(provider_id, model_name, dimension, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_embedding_cache_lookup
  ON embedding_cache(provider_id, model_name, dimension, content_hash);

CREATE INDEX IF NOT EXISTS idx_embedding_cache_last_used
  ON embedding_cache(last_used_at);

CREATE TABLE IF NOT EXISTS embedding_cache_stats (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  model_name TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  misses INTEGER NOT NULL DEFAULT 0,
  bypassed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE(provider_id, model_name, dimension)
);
