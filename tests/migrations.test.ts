import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { listMigrations, runMigrations } from "../packages/db/src/migrate.ts";

test("migrations list includes the complete control-plane baseline", () => {
  const migrations = listMigrations();
  const versions = migrations.map((entry) => entry.version);
  assert.ok(versions.includes("0001_init"));
  assert.ok(versions.includes("0002_observability"));
  assert.ok(versions.includes("0003_intelligence"));
  assert.ok(versions.includes("0004_prompt_traces"));
  assert.ok(versions.includes("0005_code_intelligence"));
  assert.ok(versions.includes("0006_trace_replay"));
  assert.ok(versions.includes("0007_dev_runs"));
  assert.ok(versions.includes("0008_embedding_cache"));
  assert.ok(versions.includes("0009_execution_command_evidence"));
  assert.ok(versions.includes("0010_check_run_evidence"));
  assert.ok(versions.includes("0011_memory_events"));
  assert.ok(versions.includes("0012_memory_graph"));
  assert.ok(versions.includes("0013_control_plane_registry"));
  assert.ok(versions.includes("0014_active_context"));
  assert.ok(versions.includes("0015_pin_anchors"));
  assert.ok(versions.includes("0016_normalized_events"));
  assert.ok(versions.includes("0017_legacy_imports"));
  assert.ok(versions.includes("0018_task_dag_outcomes"));
  assert.ok(versions.includes("0019_approval_context"));
  assert.ok(versions.includes("0020_workflow_executions"));
  assert.ok(versions.includes("0021_workflow_approvals"));
  assert.ok(versions.includes("0022_workflow_launches"));
  assert.ok(versions.includes("0023_workflow_background_jobs"));
  assert.ok(versions.includes("0024_workflow_definitions"));
  assert.ok(versions.includes("0025_workflow_step_executions"));
  assert.ok(versions.includes("0026_workflow_recoveries"));
  assert.ok(versions.includes("0027_session_context_scopes"));
});

test("migrations apply cleanly and create all expected tables", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ai-mig-"));
  const dbPath = join(dir, "ai.db");
  const db = new DatabaseSync(dbPath);
  try {
    const result = runMigrations(db);
    assert.equal(result.applied.length, 27);
    assert.equal(result.skipped.length, 0);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
      name: string;
    }>;
    const tableNames = tables.map((row) => row.name);
    assert.ok(tableNames.includes("chunk_path_boosts"), "chunk_path_boosts table must exist");
    assert.ok(tableNames.includes("retrieval_path_feedback"), "retrieval_path_feedback table must exist");
    assert.ok(tableNames.includes("retrieval_query_rewrites_used"), "retrieval_query_rewrites_used table must exist");
    assert.ok(tableNames.includes("context_pack_dependencies"), "context_pack_dependencies table must exist");
    assert.ok(tableNames.includes("code_symbols"), "code_symbols table must exist");
    assert.ok(tableNames.includes("code_edges"), "code_edges table must exist");
    assert.ok(tableNames.includes("code_symbol_chunks"), "code_symbol_chunks table must exist");
    assert.ok(tableNames.includes("project_context_graphs"), "project_context_graphs table must exist");
    assert.ok(tableNames.includes("embedding_cache"), "embedding_cache table must exist");
    assert.ok(tableNames.includes("embedding_cache_stats"), "embedding_cache_stats table must exist");
    assert.ok(tableNames.includes("session_replays"), "session_replays table must exist");
    assert.ok(tableNames.includes("prompt_lab_runs"), "prompt_lab_runs table must exist");
    assert.ok(tableNames.includes("prompt_lab_results"), "prompt_lab_results table must exist");
    assert.ok(tableNames.includes("project_manifests"), "project_manifests table must exist");
    assert.ok(tableNames.includes("project_manifest_proposals"), "project_manifest_proposals table must exist");
    assert.ok(tableNames.includes("active_project_selection"), "active_project_selection table must exist");
    assert.ok(tableNames.includes("desktop_observations"), "desktop_observations table must exist");
    assert.ok(tableNames.includes("active_context_state"), "active_context_state table must exist");
    assert.ok(tableNames.includes("legacy_import_runs"), "legacy_import_runs table must exist");
    assert.ok(tableNames.includes("legacy_import_items"), "legacy_import_items table must exist");
    assert.ok(tableNames.includes("agent_task_dependencies"), "agent_task_dependencies table must exist");
    assert.ok(tableNames.includes("agent_task_outcomes"), "agent_task_outcomes table must exist");
    assert.ok(tableNames.includes("workflow_executions"), "workflow_executions table must exist");
    assert.ok(tableNames.includes("workflow_approvals"), "workflow_approvals table must exist");
    assert.ok(tableNames.includes("workflow_launches"), "workflow_launches table must exist");
    assert.ok(tableNames.includes("workflow_background_jobs"), "workflow_background_jobs table must exist");
    assert.ok(tableNames.includes("workflow_definitions"), "workflow_definitions table must exist");
    assert.ok(tableNames.includes("workflow_step_executions"), "workflow_step_executions table must exist");
    assert.ok(tableNames.includes("workflow_recoveries"), "workflow_recoveries table must exist");
    assert.ok(tableNames.includes("session_context_scopes"), "session_context_scopes table must exist");
    assert.ok(tableNames.includes("session_context_consents"), "session_context_consents table must exist");

    const workspaceColumns = db.prepare("PRAGMA table_info(execution_workspaces)").all() as Array<{ name: string }>;
    assert.ok(workspaceColumns.some((column) => column.name === "original_branch"));
    const approvalColumns = db.prepare("PRAGMA table_info(execution_approvals)").all() as Array<{ name: string }>;
    assert.ok(approvalColumns.some((column) => column.name === "context_hash"));

    const eventColumns = db.prepare("PRAGMA table_info(agent_events)").all() as Array<{ name: string }>;
    const eventColumnNames = eventColumns.map((column) => column.name);
    for (const name of [
      "run_id",
      "schema_version",
      "source_service",
      "severity",
      "summary",
      "correlation_id",
      "causation_id",
    ]) {
      assert.ok(eventColumnNames.includes(name), `agent_events.${name} must exist`);
    }

    const executionCommandColumns = db.prepare("PRAGMA table_info(execution_commands)").all() as Array<{
      name: string;
    }>;
    const executionCommandNames = executionCommandColumns.map((c) => c.name);
    assert.ok(
      executionCommandNames.includes("parsed_errors_json"),
      "execution_commands.parsed_errors_json column must exist"
    );
    assert.ok(
      executionCommandNames.includes("affected_files_json"),
      "execution_commands.affected_files_json column must exist"
    );

    const checkRunColumns = db.prepare("PRAGMA table_info(check_runs)").all() as Array<{
      name: string;
    }>;
    const checkRunNames = checkRunColumns.map((c) => c.name);
    assert.ok(checkRunNames.includes("duration_ms"), "check_runs.duration_ms column must exist");
    assert.ok(checkRunNames.includes("parsed_errors_json"), "check_runs.parsed_errors_json column must exist");
    assert.ok(checkRunNames.includes("affected_files_json"), "check_runs.affected_files_json column must exist");

    const ragChunksColumns = db.prepare("PRAGMA table_info(rag_chunks)").all() as Array<{
      name: string;
    }>;
    const ragChunksNames = ragChunksColumns.map((c) => c.name);
    assert.ok(ragChunksNames.includes("embedding_model"), "rag_chunks.embedding_model column must exist");
    assert.ok(ragChunksNames.includes("embedding_dim"), "rag_chunks.embedding_dim column must exist");
    assert.ok(ragChunksNames.includes("embedding_provider"), "rag_chunks.embedding_provider column must exist");
  } finally {
    db.close();
  }
});

test("migrations are idempotent: second run skips all", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ai-mig-2-"));
  const dbPath = join(dir, "ai.db");
  const db = new DatabaseSync(dbPath);
  try {
    const first = runMigrations(db);
    assert.ok(first.applied.length >= 8);
    const second = runMigrations(db);
    assert.equal(second.applied.length, 0);
    assert.equal(second.skipped.length, first.applied.length);
  } finally {
    db.close();
  }
});
