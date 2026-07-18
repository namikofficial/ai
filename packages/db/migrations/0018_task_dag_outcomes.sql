-- Canonical task-DAG edges and structured task outcomes.

CREATE TABLE IF NOT EXISTS agent_task_dependencies (
  task_id TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'workbench',
  created_at TEXT NOT NULL,
  PRIMARY KEY(task_id, depends_on_task_id),
  FOREIGN KEY(task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY(depends_on_task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE,
  CHECK(task_id <> depends_on_task_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_task_dependencies_parent
  ON agent_task_dependencies(depends_on_task_id, task_id);

CREATE TABLE IF NOT EXISTS agent_task_outcomes (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT,
  status TEXT NOT NULL,
  passed INTEGER NOT NULL DEFAULT 0,
  retrieved_files_json TEXT NOT NULL DEFAULT '[]',
  edited_files_json TEXT NOT NULL DEFAULT '[]',
  missed_files_json TEXT NOT NULL DEFAULT '[]',
  useless_files_json TEXT NOT NULL DEFAULT '[]',
  checks_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'workbench',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_task_outcomes_task
  ON agent_task_outcomes(task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_task_outcomes_run
  ON agent_task_outcomes(run_id, created_at DESC);
