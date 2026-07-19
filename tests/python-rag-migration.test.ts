import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createStore, initializeStore } from "../packages/db/src/store.ts";
import { restoreWorkbenchBackup, validateWorkbenchBackup } from "../packages/project-registry/src/index.ts";
import { applyPythonRagMigration } from "../packages/python-rag-migration/src/apply.ts";
import { inventoryPythonRag, pythonRagCapabilityMappings } from "../packages/python-rag-migration/src/index.ts";
import { parsePythonRagTaskGraph } from "../packages/python-rag-migration/src/task-graph.ts";

test("Python RAG migration dry run inventories documented data without destination or source writes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-python-rag-migration-"));
  const sourcePath = join(workspace, "rag.sqlite3");
  const matchedRoot = join(workspace, "matched-project");
  await mkdir(matchedRoot, { recursive: true });
  const source = new DatabaseSync(sourcePath);
  source.exec(`
    CREATE TABLE _schema_migrations (id TEXT PRIMARY KEY, applied_at REAL NOT NULL);
    INSERT INTO _schema_migrations VALUES ('006_task_orchestration.sql', 1);
    CREATE TABLE indexed_repos (repo TEXT PRIMARY KEY, root TEXT NOT NULL, last_indexed REAL NOT NULL);
    INSERT INTO indexed_repos VALUES ('matched', '${matchedRoot.replaceAll("'", "''")}', 1);
    INSERT INTO indexed_repos VALUES ('missing', '${join(workspace, "missing").replaceAll("'", "''")}', 1);
    CREATE TABLE task_todos (
      todo_id INTEGER PRIMARY KEY, repo TEXT, title TEXT NOT NULL, detail TEXT, status TEXT,
      source_session_id TEXT, created_at REAL, updated_at REAL
    );
    INSERT INTO task_todos VALUES (1, 'matched', 'Finish migration', 'Preserve provenance', 'open', NULL, 1, 1);
    CREATE TABLE context_packs (
      pack_id INTEGER PRIMARY KEY, repo TEXT, name TEXT, agent_target TEXT, source TEXT,
      content TEXT, metadata_json TEXT, created_at REAL, updated_at REAL
    );
    INSERT INTO context_packs VALUES (1, 'matched', 'pack', 'generic', 'generated', 'text', '{}', 1, 1);
    CREATE TABLE execution_runs (
      id TEXT PRIMARY KEY, session_id TEXT, repo TEXT, target TEXT NOT NULL, profile_id TEXT,
      intent TEXT, mode TEXT, risk_level TEXT, query TEXT NOT NULL, prompt_hash TEXT,
      agent_plan_json TEXT NOT NULL, status TEXT NOT NULL, stdout TEXT, stderr TEXT,
      exit_code INTEGER, duration_ms INTEGER, files_modified TEXT NOT NULL,
      started_at REAL, finished_at REAL
    );
    INSERT INTO execution_runs VALUES (
      'execution-1', 'session-1', 'matched', 'codex', 'coding', 'implement', 'edit', 'medium',
      'change importer', 'prompt-hash', '{"steps":["edit"]}', 'completed', 'done', NULL,
      0, 100, '["src/migrate.ts"]', 1, 2
    );
    CREATE TABLE task_runs (
      run_id TEXT PRIMARY KEY, repo TEXT, task TEXT, task_fingerprint TEXT, mode TEXT,
      max_subtasks INTEGER, graph_json TEXT, status TEXT, current_subtask_id TEXT,
      created_at REAL, updated_at REAL, finished_at REAL
    );
    INSERT INTO task_runs VALUES ('run-1', 'matched', 'task', 'hash', 'auto', 8, '{bad json', 'active', NULL, 1, 1, NULL);
    CREATE TABLE task_outcomes (
      outcome_id INTEGER PRIMARY KEY, run_id TEXT, repo TEXT, task_id TEXT, task TEXT,
      task_fingerprint TEXT, subtask_id TEXT, subtask_title TEXT, subtask_type TEXT, status TEXT,
      retrieved_files_json TEXT, edited_files_json TEXT, missed_files_json TEXT, useless_files_json TEXT,
      checks_run_json TEXT, passed INTEGER, notes TEXT, attempt INTEGER, created_at REAL, updated_at REAL
    );
    CREATE TABLE retrieval_runs (
      id TEXT PRIMARY KEY, repo TEXT, branch TEXT, mode TEXT, intent TEXT, query TEXT,
      plan_json TEXT, rewrites_json TEXT, candidate_counts_json TEXT, selected_files_json TEXT,
      edit_scope_json TEXT, missing_context_json TEXT, packed_context_token_estimate INTEGER,
      timings_json TEXT, warnings_json TEXT, errors_json TEXT, metadata_json TEXT, created_at REAL
    );
    CREATE TABLE retrieval_outcomes (
      outcome_id INTEGER PRIMARY KEY, run_id TEXT, repo TEXT, task TEXT, task_fingerprint TEXT,
      retrieved_files_json TEXT, edited_files_json TEXT, checks_run_json TEXT, passed INTEGER,
      notes TEXT, missed_files_json TEXT, created_at REAL
    );
    CREATE TABLE eval_cases (
      case_id INTEGER PRIMARY KEY, repo TEXT, query TEXT, mode TEXT, expected_files_json TEXT,
      expected_symbols_json TEXT, notes TEXT, created_at REAL, updated_at REAL
    );
    INSERT INTO eval_cases VALUES (1, 'matched', 'find migration code', 'deep', '["src/migrate.ts"]', '["migrate"]', 'fixture', 1, 1);
    CREATE TABLE eval_runs (
      id TEXT PRIMARY KEY, repo TEXT, case_count INTEGER, metrics_json TEXT, created_at REAL
    );
    INSERT INTO eval_runs VALUES ('eval-1', 'matched', 1, '{"mrr":1}', 1);
    CREATE TABLE task_lessons (
      lesson_id INTEGER PRIMARY KEY, repo TEXT, run_id TEXT, task_id TEXT,
      lesson_kind TEXT, lesson_json TEXT, created_at REAL
    );
    INSERT INTO task_lessons VALUES (1, 'matched', 'run-1', 'task-1', 'practice', '{"title":"Keep provenance","body":"Use stable source hashes"}', 1);
    INSERT INTO task_lessons VALUES (2, 'matched', 'run-1', 'task-1', 'invalid', '{bad json', 1);
  `);
  const validGraph = {
    task_id: "task-2",
    task: "Implement migration",
    repo: "matched",
    mode: "auto",
    max_subtasks: 2,
    subtasks: [
      {
        id: "inspect",
        title: "Inspect schemas",
        description: "Map both stores",
        type: "research",
        status: "done",
        depends_on: [],
        retrieval_query: "schemas",
        expected_files: ["storage.py"],
        success_check: "mapping reviewed",
        risk_level: "low",
        created_at: 1,
        updated_at: 2,
        attempts: 1,
        last_error: null,
      },
      {
        id: "import",
        title: "Import data",
        description: "Preserve provenance",
        type: "edit",
        status: "running",
        depends_on: ["inspect"],
        retrieval_query: "importer",
        expected_files: ["apply.ts"],
        success_check: "tests pass",
        risk_level: "medium",
        created_at: 2,
        updated_at: 3,
        attempts: 1,
        last_error: null,
      },
    ],
    created_at: 1,
    updated_at: 3,
    current_subtask_id: "import",
    run_id: "run-2",
    summary: null,
  };
  source
    .prepare("INSERT INTO task_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      "run-2",
      "matched",
      "Implement migration",
      "hash-2",
      "auto",
      2,
      JSON.stringify(validGraph),
      "active",
      "import",
      1,
      3,
      null
    );
  source
    .prepare("INSERT INTO task_outcomes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      1,
      "run-2",
      "matched",
      "task-2",
      "Implement migration",
      "hash-2",
      "inspect",
      "Inspect schemas",
      "research",
      "done",
      '["storage.py"]',
      "[]",
      "[]",
      "[]",
      '["mapping reviewed"]',
      1,
      "Mapped",
      1,
      2,
      2
    );
  source
    .prepare("INSERT INTO retrieval_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      "retrieval-1",
      "matched",
      "main",
      "deep",
      "code",
      "find migration",
      "{}",
      '["migration"]',
      '{"fts":1}',
      '["src/migrate.ts"]',
      "{}",
      "{}",
      64,
      '{"total":1}',
      "[]",
      "[]",
      "{}",
      1
    );
  source
    .prepare("INSERT INTO retrieval_outcomes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      1,
      "retrieval-1",
      "matched",
      "find migration",
      "hash",
      '["src/migrate.ts"]',
      "[]",
      '["test"]',
      1,
      "good",
      "[]",
      2
    );
  source.close();
  const handoffRoot = join(workspace, "projects", "matched", "handoffs");
  await mkdir(handoffRoot, { recursive: true });
  await writeFile(join(handoffRoot, "20260101-handoff.md"), "# Handoff\n\n## Target agent\ncodex\n", "utf8");
  const before = await stat(sourcePath);

  try {
    const report = await inventoryPythonRag({
      databasePath: sourcePath,
      ragHome: workspace,
      projects: [{ id: "project-1", name: "Canonical", path: matchedRoot }],
    });
    const after = await stat(sourcePath);
    assert.equal(report.mode, "dry_run");
    assert.equal(report.source.integrity, "ok");
    assert.deepEqual(report.source.migrations, ["006_task_orchestration.sql"]);
    assert.equal(
      report.projects.find((project) => project.sourceRepo === "matched")?.destinationProjectId,
      "project-1"
    );
    assert.equal(report.projects.find((project) => project.sourceRepo === "missing")?.status, "unmatched");
    assert.equal(report.handoffs.length, 1);
    assert.equal(report.tables.find((table) => table.name === "task_todos")?.rows, 1);
    assert.equal(report.tables.find((table) => table.name === "task_runs")?.invalidJsonRows, 1);
    assert.ok(report.conflicts.some((conflict) => conflict.code === "unmatched_project"));
    assert.ok(report.conflicts.some((conflict) => conflict.code === "invalid_json"));
    assert.ok(report.totals.importableRows >= 1);
    assert.equal(report.totals.referenceRows, 1);
    assert.equal(report.totals.regenerableRows, 2);
    assert.equal(after.mtimeMs, before.mtimeMs, "read-only inventory must not modify the Python database");

    const store = createStore(initializeStore(join(workspace, "workbench.db")));
    const project = store.createProject({ path: matchedRoot, name: "Canonical" });
    const firstBackup = join(workspace, "backups", "before-first.db");
    const firstImport = await applyPythonRagMigration({
      destination: store.db,
      databasePath: sourcePath,
      ragHome: workspace,
      projects: [{ id: project.id, name: project.name, path: project.path }],
      backupPath: firstBackup,
    });
    assert.equal(firstImport.backup.integrity, "ok");
    assert.equal(validateWorkbenchBackup(firstBackup).integrity, "ok");
    assert.equal(firstImport.totals.imported, 10);
    assert.equal(firstImport.totals.conflicted, 2);
    assert.equal(firstImport.totals.deferred, 3);
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM agent_tasks").get() as { count: number }).count, 3);
    assert.equal(
      (store.db.prepare("SELECT COUNT(*) AS count FROM agent_task_dependencies").get() as { count: number }).count,
      1
    );
    assert.equal(
      (store.db.prepare("SELECT COUNT(*) AS count FROM agent_task_outcomes").get() as { count: number }).count,
      1
    );
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM context_packs").get() as { count: number }).count, 1);
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM handoffs").get() as { count: number }).count, 1);
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM eval_cases").get() as { count: number }).count, 1);
    assert.equal(
      (store.db.prepare("SELECT COUNT(*) AS count FROM retrieval_queries").get() as { count: number }).count,
      1
    );
    assert.equal(
      (store.db.prepare("SELECT COUNT(*) AS count FROM retrieval_feedback").get() as { count: number }).count,
      1
    );
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM lessons").get() as { count: number }).count, 1);
    assert.equal(
      (
        store.db.prepare("SELECT COUNT(*) AS count FROM legacy_import_items WHERE status = 'imported'").get() as {
          count: number;
        }
      ).count,
      10
    );
    const executionProvenance = store.db
      .prepare(
        `SELECT project_id, destination_type, destination_id, status, error_message
         FROM legacy_import_items WHERE source_table = 'execution_runs' AND source_id = 'execution-1'`
      )
      .get() as {
      project_id: string | null;
      destination_type: string | null;
      destination_id: string | null;
      status: string;
      error_message: string | null;
    };
    assert.equal(executionProvenance.project_id, project.id);
    assert.equal(executionProvenance.destination_type, null);
    assert.equal(executionProvenance.destination_id, null);
    assert.equal(executionProvenance.status, "deferred");
    assert.match(executionProvenance.error_message ?? "", /provenance only/);

    const restoredPath = join(workspace, "restored-workbench.db");
    const displaced = createStore(initializeStore(restoredPath));
    displaced.createProject({ path: join(workspace, "displaced"), name: "Displaced" });
    displaced.db.close();
    const preRestorePath = join(workspace, "backups", "displaced.db");
    const restore = await restoreWorkbenchBackup({
      backupPath: firstBackup,
      destination: restoredPath,
      preRestoreBackupPath: preRestorePath,
    });
    assert.equal(restore.restored.integrity, "ok");
    assert.equal(restore.preRestoreBackup?.path, preRestorePath);
    assert.equal(validateWorkbenchBackup(preRestorePath).integrity, "ok");
    const backupLink = join(workspace, "backup-link.db");
    await symlink(firstBackup, backupLink);
    await assert.rejects(
      restoreWorkbenchBackup({ backupPath: backupLink, destination: join(workspace, "unsafe-restore.db") }),
      /non-symlink/
    );
    const restored = createStore(initializeStore(restoredPath));
    assert.equal(
      (restored.db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check,
      "ok"
    );
    assert.equal((restored.db.prepare("SELECT COUNT(*) AS count FROM projects").get() as { count: number }).count, 1);
    assert.equal(
      (restored.db.prepare("SELECT COUNT(*) AS count FROM legacy_import_items").get() as { count: number }).count,
      0
    );
    restored.db.close();

    const secondImport = await applyPythonRagMigration({
      destination: store.db,
      databasePath: sourcePath,
      ragHome: workspace,
      projects: [{ id: project.id, name: project.name, path: project.path }],
      backupPath: join(workspace, "backups", "before-second.db"),
    });
    assert.equal(secondImport.totals.imported, 0);
    assert.equal(secondImport.totals.duplicate, 10);
    assert.equal(secondImport.totals.conflicted, 2);
    assert.equal(secondImport.totals.deferred, 3);
    assert.equal(secondImport.items.find((item) => item.source === "execution_runs:execution-1")?.status, "deferred");
    assert.equal(
      (
        store.db
          .prepare("SELECT COUNT(*) AS count FROM legacy_import_items WHERE source_table = 'execution_runs'")
          .get() as {
          count: number;
        }
      ).count,
      1
    );
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM agent_tasks").get() as { count: number }).count, 3);
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM handoffs").get() as { count: number }).count, 1);
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM lessons").get() as { count: number }).count, 1);
    assert.equal((await stat(sourcePath)).mtimeMs, before.mtimeMs, "apply must keep the legacy database read-only");
    store.db.close();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Python RAG parity map covers every required legacy capability", () => {
  const mappings = pythonRagCapabilityMappings();
  const names = mappings.map((mapping) => mapping.capability);
  for (const capability of [
    "todos",
    "decisions",
    "command memory",
    "error memory",
    "durable project memory",
    "sessions and compaction",
    "context packs",
    "handoffs",
    "retrieval diagnostics",
    "retrieval evaluation",
    "historical execution runs",
    "task graphs and subtask outcomes",
    "lessons",
    "MCP interfaces",
  ]) {
    assert.ok(names.includes(capability), `missing parity mapping for ${capability}`);
  }
});

test("Python RAG task graph parser rejects missing dependencies and cycles", () => {
  const missing = parsePythonRagTaskGraph({
    task_id: "task",
    task: "Task",
    max_subtasks: 1,
    subtasks: [
      { id: "one", title: "One", type: "edit", status: "pending", depends_on: ["missing"], expected_files: [] },
    ],
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.ok(missing.errors.some((error) => error.includes("unknown dependency")));

  const cycle = parsePythonRagTaskGraph({
    task_id: "task",
    task: "Task",
    max_subtasks: 2,
    subtasks: [
      { id: "one", title: "One", type: "edit", status: "pending", depends_on: ["two"], expected_files: [] },
      { id: "two", title: "Two", type: "test", status: "pending", depends_on: ["one"], expected_files: [] },
    ],
  });
  assert.equal(cycle.ok, false);
  if (!cycle.ok) assert.ok(cycle.errors.some((error) => error.includes("dependency cycle")));
});
