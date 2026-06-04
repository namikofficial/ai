-- Prompt trace records.

CREATE TABLE IF NOT EXISTS compiled_prompts (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  task_id TEXT,
  retrieval_query_id TEXT,
  context_pack_id TEXT,
  mode TEXT NOT NULL,
  role TEXT NOT NULL,
  messages_json TEXT NOT NULL,
  estimated_tokens INTEGER NOT NULL DEFAULT 0,
  included_context_json TEXT NOT NULL,
  omitted_context_json TEXT NOT NULL,
  safety_notes_json TEXT NOT NULL,
  output_schema_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_compiled_prompts_session_created
  ON compiled_prompts(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_compiled_prompts_retrieval_query
  ON compiled_prompts(retrieval_query_id, created_at DESC);
