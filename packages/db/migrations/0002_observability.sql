-- Observability foundation.
-- Adds durable, reviewable tables for retrieval, memory, models, context, agents, evals, and skills.
-- No business logic changes here. This migration only adds tables, indexes, and pragmas.

PRAGMA foreign_keys = ON;

-- ── Conversation replay ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS conversation_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT,
  role TEXT NOT NULL,
  agent TEXT,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}',
  token_count INTEGER NOT NULL DEFAULT 0,
  parent_message_id TEXT,
  ts TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversation_messages_session_ts
  ON conversation_messages(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_project
  ON conversation_messages(project_id);

-- ── Retrieval pipeline ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS retrieval_queries (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  task_id TEXT,
  project_id TEXT NOT NULL,
  original_query TEXT NOT NULL,
  intent TEXT NOT NULL,
  mode TEXT NOT NULL,
  depth TEXT NOT NULL,
  rewritten_query TEXT,
  analysis_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_retrieval_queries_session
  ON retrieval_queries(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_retrieval_queries_project
  ON retrieval_queries(project_id, created_at);

CREATE TABLE IF NOT EXISTS retrieval_rewrites (
  id TEXT PRIMARY KEY,
  retrieval_query_id TEXT NOT NULL,
  variant TEXT NOT NULL,
  terms_json TEXT NOT NULL,
  path_hints_json TEXT NOT NULL,
  symbol_hints_json TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY(retrieval_query_id) REFERENCES retrieval_queries(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_retrieval_rewrites_query
  ON retrieval_rewrites(retrieval_query_id);

CREATE TABLE IF NOT EXISTS retrieval_results (
  id TEXT PRIMARY KEY,
  retrieval_query_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  source TEXT NOT NULL,
  base_score REAL NOT NULL,
  rerank_score REAL NOT NULL DEFAULT 0,
  final_score REAL NOT NULL,
  included INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(retrieval_query_id) REFERENCES retrieval_queries(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_retrieval_results_query
  ON retrieval_results(retrieval_query_id, final_score DESC);
CREATE INDEX IF NOT EXISTS idx_retrieval_results_chunk
  ON retrieval_results(chunk_id);

CREATE TABLE IF NOT EXISTS retrieval_selected_context (
  id TEXT PRIMARY KEY,
  retrieval_query_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  token_count INTEGER NOT NULL,
  excerpt TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(retrieval_query_id) REFERENCES retrieval_queries(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_retrieval_selected_context_query
  ON retrieval_selected_context(retrieval_query_id, rank);

CREATE TABLE IF NOT EXISTS retrieval_feedback (
  id TEXT PRIMARY KEY,
  retrieval_query_id TEXT NOT NULL,
  chunk_id TEXT,
  rating TEXT NOT NULL,
  missed_path TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(retrieval_query_id) REFERENCES retrieval_queries(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_retrieval_feedback_query
  ON retrieval_feedback(retrieval_query_id);

CREATE TABLE IF NOT EXISTS retrieval_misses (
  id TEXT PRIMARY KEY,
  retrieval_query_id TEXT NOT NULL,
  missed_path TEXT NOT NULL,
  confidence REAL NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(retrieval_query_id) REFERENCES retrieval_queries(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_retrieval_misses_query
  ON retrieval_misses(retrieval_query_id);

-- ── Model registry, health, and calls ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS model_providers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  base_url TEXT,
  api_key_env TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_profiles (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  role TEXT NOT NULL,
  model_name TEXT NOT NULL,
  display_name TEXT,
  context_window INTEGER NOT NULL DEFAULT 8192,
  max_output_tokens INTEGER NOT NULL DEFAULT 1024,
  local_only INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  fallback_profile_id TEXT,
  quality_score REAL NOT NULL DEFAULT 0.5,
  latency_score REAL NOT NULL DEFAULT 0.5,
  cost_score REAL NOT NULL DEFAULT 0.5,
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(provider_id) REFERENCES model_providers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_model_profiles_role
  ON model_profiles(role, enabled);
CREATE INDEX IF NOT EXISTS idx_model_profiles_provider
  ON model_profiles(provider_id);

CREATE TABLE IF NOT EXISTS model_routes (
  id TEXT PRIMARY KEY,
  task_pattern TEXT NOT NULL,
  mode TEXT NOT NULL,
  selected_profile_id TEXT NOT NULL,
  fallback_profile_id TEXT,
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(selected_profile_id) REFERENCES model_profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_model_routes_task_mode
  ON model_routes(task_pattern, mode);

CREATE TABLE IF NOT EXISTS model_health_checks (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  profile_id TEXT,
  status TEXT NOT NULL,
  latency_ms INTEGER,
  detail TEXT,
  checked_at TEXT NOT NULL,
  FOREIGN KEY(provider_id) REFERENCES model_providers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_model_health_provider_ts
  ON model_health_checks(provider_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS model_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  task_id TEXT,
  retrieval_query_id TEXT,
  profile_id TEXT NOT NULL,
  role TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT,
  request_json TEXT NOT NULL DEFAULT '{}',
  response_json TEXT NOT NULL DEFAULT '{}',
  ts TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(profile_id) REFERENCES model_profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_model_calls_session_ts
  ON model_calls(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_model_calls_profile_ts
  ON model_calls(profile_id, ts);

-- ── Context packs ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS context_packs (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  task_id TEXT,
  project_id TEXT,
  retrieval_query_id TEXT,
  budget_tokens INTEGER NOT NULL DEFAULT 4096,
  used_tokens INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_context_packs_session
  ON context_packs(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_context_packs_project
  ON context_packs(project_id, created_at);

CREATE TABLE IF NOT EXISTS context_pack_items (
  id TEXT PRIMARY KEY,
  context_pack_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_id TEXT,
  rank INTEGER NOT NULL,
  token_count INTEGER NOT NULL,
  excerpt TEXT NOT NULL,
  included INTEGER NOT NULL DEFAULT 1,
  omission_reason TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(context_pack_id) REFERENCES context_packs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_context_pack_items_pack
  ON context_pack_items(context_pack_id, rank);

CREATE TABLE IF NOT EXISTS context_budget_events (
  id TEXT PRIMARY KEY,
  context_pack_id TEXT NOT NULL,
  delta_tokens INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(context_pack_id) REFERENCES context_packs(id) ON DELETE CASCADE
);

-- ── Memory candidates, accepted memory, facts ─────────────────────────────

CREATE TABLE IF NOT EXISTS memory_candidates (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  session_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0.5,
  scope TEXT NOT NULL DEFAULT 'project',
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_at TEXT,
  reviewer_notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_candidates_status
  ON memory_candidates(status, created_at);
CREATE INDEX IF NOT EXISTS idx_memory_candidates_project
  ON memory_candidates(project_id, status);

CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  candidate_id TEXT,
  project_id TEXT,
  scope TEXT NOT NULL DEFAULT 'project',
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0.5,
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  use_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(candidate_id) REFERENCES memory_candidates(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_entries_project_pinned
  ON memory_entries(project_id, pinned, archived);
CREATE INDEX IF NOT EXISTS idx_memory_entries_scope
  ON memory_entries(scope, archived);

CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'fact',
  confidence REAL NOT NULL DEFAULT 0.5,
  source_kind TEXT NOT NULL DEFAULT 'extraction',
  status TEXT NOT NULL DEFAULT 'fresh',
  last_verified_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_facts_project_key
  ON facts(project_id, key);
CREATE INDEX IF NOT EXISTS idx_facts_status
  ON facts(status);

CREATE TABLE IF NOT EXISTS fact_sources (
  id TEXT PRIMARY KEY,
  fact_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  excerpt TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(fact_id) REFERENCES facts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fact_sources_fact
  ON fact_sources(fact_id);

CREATE TABLE IF NOT EXISTS project_rules (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_rules_project_pinned
  ON project_rules(project_id, pinned);

-- ── Agent runs, messages, handoffs ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  task_id TEXT,
  project_id TEXT,
  agent TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  input_json TEXT NOT NULL DEFAULT '{}',
  output_json TEXT NOT NULL DEFAULT '{}',
  model_role TEXT,
  risk TEXT NOT NULL DEFAULT 'low',
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_session_ts
  ON agent_runs(session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_agent_runs_project_ts
  ON agent_runs(project_id, started_at);

CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  agent_run_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}',
  ts TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(agent_run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_run_ts
  ON agent_messages(agent_run_id, ts);

CREATE TABLE IF NOT EXISTS agent_handoffs (
  id TEXT PRIMARY KEY,
  from_agent_run_id TEXT,
  to_agent TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  context_pack_id TEXT,
  session_id TEXT,
  task_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_handoffs_session
  ON agent_handoffs(session_id, created_at);

-- ── Evaluation ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS eval_cases (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  question TEXT NOT NULL,
  expected_files_json TEXT NOT NULL DEFAULT '[]',
  expected_answer_contains TEXT,
  difficulty TEXT NOT NULL DEFAULT 'standard',
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_eval_cases_project
  ON eval_cases(project_id);

CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  session_id TEXT,
  project_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  passed INTEGER NOT NULL DEFAULT 0,
  score REAL NOT NULL DEFAULT 0,
  notes TEXT,
  FOREIGN KEY(case_id) REFERENCES eval_cases(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_eval_runs_case
  ON eval_runs(case_id, started_at DESC);

CREATE TABLE IF NOT EXISTS answer_evaluations (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  retrieval_query_id TEXT,
  groundedness REAL NOT NULL DEFAULT 0,
  citation_coverage REAL NOT NULL DEFAULT 0,
  contradiction REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_answer_evaluations_session
  ON answer_evaluations(session_id, created_at);

CREATE TABLE IF NOT EXISTS retrieval_evaluations (
  id TEXT PRIMARY KEY,
  retrieval_query_id TEXT NOT NULL,
  hit_at_k REAL NOT NULL DEFAULT 0,
  mrr REAL NOT NULL DEFAULT 0,
  precision REAL NOT NULL DEFAULT 0,
  recall REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(retrieval_query_id) REFERENCES retrieval_queries(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_retrieval_evaluations_query
  ON retrieval_evaluations(retrieval_query_id);

CREATE TABLE IF NOT EXISTS session_outcomes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_outcomes_session
  ON session_outcomes(session_id, created_at);

-- ── Skills ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS skill_candidates (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  title TEXT NOT NULL,
  trigger_terms_json TEXT NOT NULL DEFAULT '[]',
  applicable_projects_json TEXT NOT NULL DEFAULT '[]',
  steps_json TEXT NOT NULL DEFAULT '[]',
  required_context_json TEXT NOT NULL DEFAULT '[]',
  commands_json TEXT NOT NULL DEFAULT '[]',
  safety_notes TEXT,
  validation_json TEXT NOT NULL DEFAULT '[]',
  example_session_id TEXT,
  source_kind TEXT NOT NULL DEFAULT 'reflection',
  confidence REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_skill_candidates_status
  ON skill_candidates(status, created_at);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  candidate_id TEXT,
  title TEXT NOT NULL,
  trigger_terms_json TEXT NOT NULL DEFAULT '[]',
  applicable_projects_json TEXT NOT NULL DEFAULT '[]',
  steps_json TEXT NOT NULL DEFAULT '[]',
  required_context_json TEXT NOT NULL DEFAULT '[]',
  commands_json TEXT NOT NULL DEFAULT '[]',
  safety_notes TEXT,
  validation_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(candidate_id) REFERENCES skill_candidates(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_skills_status
  ON skills(status, updated_at);

CREATE TABLE IF NOT EXISTS skill_usage (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  session_id TEXT,
  applied INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(skill_id) REFERENCES skills(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_skill_usage_skill
  ON skill_usage(skill_id, created_at);
