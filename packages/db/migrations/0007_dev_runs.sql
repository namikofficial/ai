-- Local agentic dev pipeline tables (Slice 26).
--
-- The dev pipeline is the missing loop that turns the workbench from a
-- dashboard around external agents into an actual local coding agent:
--   goal -> context -> plan -> safe workspace -> edit -> check -> repair -> diff -> approve
--
-- These tables persist every run, the safe workspace it produced, the
-- structured edits, the allowlisted command attempts, the approval
-- decisions, and the unified patches the user can later apply.

CREATE TABLE IF NOT EXISTS dev_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  mode TEXT NOT NULL,
  approval_policy TEXT NOT NULL,
  approve_edits INTEGER NOT NULL DEFAULT 0,
  risk TEXT NOT NULL DEFAULT 'low',
  status TEXT NOT NULL DEFAULT 'queued',
  plan_json TEXT NOT NULL DEFAULT '{}',
  workspace_id TEXT,
  workspace_strategy TEXT,
  workspace_path TEXT,
  workspace_branch TEXT,
  checks_json TEXT NOT NULL DEFAULT '[]',
  repair_attempts INTEGER NOT NULL DEFAULT 0,
  max_repairs INTEGER NOT NULL DEFAULT 0,
  diff_summary TEXT NOT NULL DEFAULT '',
  diff_text TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  files_edited_json TEXT NOT NULL DEFAULT '[]',
  files_created_json TEXT NOT NULL DEFAULT '[]',
  error_message TEXT,
  applied_at TEXT,
  applied_files_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_dev_runs_session ON dev_runs(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dev_runs_project ON dev_runs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dev_runs_status ON dev_runs(status);

CREATE TABLE IF NOT EXISTS dev_edits (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,
  reason TEXT NOT NULL,
  old_text TEXT,
  new_text TEXT NOT NULL,
  change_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  risk TEXT NOT NULL DEFAULT 'low',
  blocked_reason TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES dev_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_dev_edits_run ON dev_edits(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_dev_edits_path ON dev_edits(path);

CREATE TABLE IF NOT EXISTS execution_workspaces (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  strategy TEXT NOT NULL,
  path TEXT NOT NULL,
  branch TEXT,
  is_git_worktree INTEGER NOT NULL DEFAULT 0,
  base_commit TEXT,
  original_root TEXT NOT NULL,
  cleaned_up INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES dev_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_execution_workspaces_run ON execution_workspaces(run_id);

CREATE TABLE IF NOT EXISTS execution_commands (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  workspace_id TEXT,
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  exit_code INTEGER,
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  blocked_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES dev_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_execution_commands_run ON execution_commands(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_execution_commands_status ON execution_commands(status);

CREATE TABLE IF NOT EXISTS execution_approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  policy TEXT NOT NULL,
  risk TEXT NOT NULL,
  requires_explicit INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  decided_at TEXT,
  decided_by TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES dev_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_execution_approvals_run ON execution_approvals(run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_execution_approvals_status ON execution_approvals(status);

CREATE TABLE IF NOT EXISTS patches (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'unified',
  path TEXT NOT NULL,
  diff_text TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  applied INTEGER NOT NULL DEFAULT 0,
  applied_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES dev_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_patches_run ON patches(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_patches_path ON patches(path);
