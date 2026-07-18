import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { DatabaseSync as SourceDatabase } from "node:sqlite";
import { createWorkbenchBackup } from "../../project-registry/src/index.ts";
import { redactSecrets } from "../../safety/src/index.ts";
import { type InventoryProject, inventoryPythonRag, type PythonRagInventoryReport } from "./index.ts";
import { parsePythonRagTaskGraph } from "./task-graph.ts";

type SourceRow = Record<string, unknown>;

export interface PythonRagImportReport {
  schemaVersion: 1;
  mode: "apply";
  runId: string;
  generatedAt: string;
  sourceDatabase: string;
  sourceFingerprint: string;
  backup: { path: string; createdAt: string; integrity: string; migrations: string[] };
  inventory: PythonRagInventoryReport;
  totals: { imported: number; duplicate: number; conflicted: number; deferred: number };
  items: Array<{
    source: string;
    status: "imported" | "duplicate" | "conflict" | "deferred";
    destinationType: string | null;
    destinationId: string | null;
    summary: string;
  }>;
  rollback: { restoreFrom: string; instructions: string[] };
}

interface ImportSpec {
  table: string;
  idColumn: string;
  destinationType:
    | "agent_session"
    | "agent_task"
    | "context_pack"
    | "eval_case"
    | "lesson"
    | "memory_candidate"
    | "memory_entry"
    | "retrieval_outcome"
    | "retrieval_query"
    | "task_graph"
    | "task_outcome";
}

const IMPORT_SPECS: ImportSpec[] = [
  { table: "task_sessions", idColumn: "session_id", destinationType: "agent_session" },
  { table: "task_todos", idColumn: "todo_id", destinationType: "agent_task" },
  { table: "task_decisions", idColumn: "decision_id", destinationType: "memory_entry" },
  { table: "command_memory", idColumn: "command_id", destinationType: "memory_entry" },
  { table: "error_memory", idColumn: "error_id", destinationType: "memory_entry" },
  { table: "test_failure_memory", idColumn: "failure_id", destinationType: "memory_entry" },
  { table: "developer_memory", idColumn: "memory_id", destinationType: "memory_entry" },
  { table: "repo_memory", idColumn: "repo", destinationType: "memory_entry" },
  { table: "session_compactions", idColumn: "compaction_id", destinationType: "memory_entry" },
  { table: "memory_candidates", idColumn: "id", destinationType: "memory_candidate" },
  { table: "context_packs", idColumn: "pack_id", destinationType: "context_pack" },
  { table: "eval_cases", idColumn: "case_id", destinationType: "eval_case" },
  { table: "eval_runs", idColumn: "id", destinationType: "memory_entry" },
  { table: "retrieval_runs", idColumn: "id", destinationType: "retrieval_query" },
  { table: "retrieval_outcomes", idColumn: "outcome_id", destinationType: "retrieval_outcome" },
  { table: "task_runs", idColumn: "run_id", destinationType: "task_graph" },
  { table: "task_outcomes", idColumn: "outcome_id", destinationType: "task_outcome" },
  { table: "task_lessons", idColumn: "lesson_id", destinationType: "lesson" },
];

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${stableHash(value).slice(0, 24)}`;
}

function legacyTaskId(sourceDatabase: string, runId: string, subtaskId: string): string {
  return stableId("legacy_task", { sourceDatabase, runId, subtaskId });
}

function parseJsonObject(value: unknown, field: string): Record<string, unknown> {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${field} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseJsonStrings(value: unknown, field: string): string[] {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be a JSON array of strings`);
  }
  return parsed as string[];
}

function tokenEstimate(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function text(row: SourceRow, key: string, fallback = ""): string {
  const value = row[key];
  return value == null ? fallback : String(value);
}

function optionalText(row: SourceRow, key: string): string | null {
  const value = row[key];
  return value == null || value === "" ? null : String(value);
}

function sourceTimestamp(value: unknown, fallback: string): string {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value * 1000).toISOString();
  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString();
  }
  return fallback;
}

function redacted(value: string): string {
  return redactSecrets(value).text;
}

function sourceTables(db: SourceDatabase): Set<string> {
  return new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (row) => row.name
    )
  );
}

function projectMap(report: PythonRagInventoryReport): Map<string, string> {
  return new Map(
    report.projects
      .filter((project) => project.status === "matched" && project.destinationProjectId)
      .map((project) => [project.sourceRepo, project.destinationProjectId as string])
  );
}

function taskStatus(value: string): "queued" | "running" | "completed" | "failed" | "blocked" {
  const status = value.toLowerCase();
  if (["done", "complete", "completed", "closed", "resolved"].includes(status)) return "completed";
  if (["active", "in_progress", "running", "started"].includes(status)) return "running";
  if (status === "blocked" || status === "waiting") return "blocked";
  if (["failed", "error", "cancelled"].includes(status)) return "failed";
  return "queued";
}

function evidence(sourceDatabase: string, spec: ImportSpec, sourceId: string, sourceHash: string): string {
  return JSON.stringify([
    {
      kind: "legacy_import",
      ref: `python-rag:${spec.table}:${sourceId}`,
      sourceDatabase,
      sourceHash,
    },
  ]);
}

function ensureTodoSession(
  db: DatabaseSync,
  sourceDatabase: string,
  repo: string,
  projectId: string,
  now: string
): string {
  const id = stableId("legacy_sess", { sourceDatabase, repo, kind: "todos" });
  db.prepare(
    `INSERT OR IGNORE INTO agent_sessions (
      id, project_id, title, user_goal, mode, status, source, started_at, finished_at,
      duration_ms, active_task_id, model_profile, final_summary, error_message, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    projectId,
    "Imported Python RAG todos",
    "Preserve legacy software-development todos during compatibility migration",
    "migration",
    "paused",
    "python-rag-import",
    now,
    null,
    null,
    null,
    null,
    null,
    null,
    now,
    now
  );
  return id;
}

function memoryFields(
  spec: ImportSpec,
  row: SourceRow
): { kind: string; title: string; body: string; confidence: number } {
  if (spec.table === "task_decisions") {
    return {
      kind: "decision",
      title: text(row, "title", "Imported decision"),
      body: [text(row, "detail"), optionalText(row, "rationale")].filter(Boolean).join("\n\nRationale: "),
      confidence: 0.9,
    };
  }
  if (spec.table === "command_memory") {
    return {
      kind: "command_worked",
      title: text(row, "purpose", "Imported command"),
      body: [text(row, "command"), optionalText(row, "notes")].filter(Boolean).join("\n\n"),
      confidence: 0.8,
    };
  }
  if (spec.table === "error_memory" || spec.table === "test_failure_memory") {
    return {
      kind: optionalText(row, "fix_text") ? "error_fix" : "command_failed",
      title: text(row, "normalized_error", text(row, "error_text", "Imported failure")).slice(0, 240),
      body: [
        text(row, "error_text", text(row, "output_text")),
        optionalText(row, "fix_text"),
        optionalText(row, "notes"),
      ]
        .filter(Boolean)
        .join("\n\n"),
      confidence: optionalText(row, "fix_text") ? 0.85 : 0.65,
    };
  }
  if (spec.table === "developer_memory") {
    return {
      kind: text(row, "kind", "project_memory"),
      title: text(row, "subject", "Imported developer memory"),
      body: text(row, "value"),
      confidence: 0.85,
    };
  }
  if (spec.table === "repo_memory") {
    return {
      kind: "project_summary",
      title: "Imported repository memory",
      body: [text(row, "summary"), optionalText(row, "architecture")].filter(Boolean).join("\n\nArchitecture:\n"),
      confidence: typeof row.freshness_score === "number" ? row.freshness_score : 0.7,
    };
  }
  if (spec.table === "eval_runs") {
    const metrics = parseJsonObject(row.metrics_json ?? "{}", "eval_runs.metrics_json");
    return {
      kind: "retrieval_evaluation",
      title: `Imported retrieval evaluation ${text(row, "id")}`,
      body: JSON.stringify(
        {
          caseCount: typeof row.case_count === "number" ? row.case_count : 0,
          metrics,
        },
        null,
        2
      ),
      confidence: 1,
    };
  }
  return {
    kind: "session_summary",
    title: `Imported session compaction ${text(row, "session_id")}`,
    body: text(row, "summary"),
    confidence: 0.8,
  };
}

function insertDestination(input: {
  db: DatabaseSync;
  spec: ImportSpec;
  row: SourceRow;
  sourceId: string;
  sourceHash: string;
  sourceDatabase: string;
  projectId: string | null;
  now: string;
}): string {
  const { db, spec, row, sourceId, sourceHash, sourceDatabase, projectId, now } = input;
  const destinationId = stableId(`legacy_${spec.destinationType}`, {
    sourceDatabase,
    table: spec.table,
    sourceId,
    sourceHash,
  });
  const createdAt = sourceTimestamp(row.created_at, now);
  const updatedAt = sourceTimestamp(row.updated_at, createdAt);
  if (spec.destinationType === "agent_session") {
    db.prepare(
      `INSERT INTO agent_sessions (
        id, project_id, title, user_goal, mode, status, source, started_at, finished_at,
        duration_ms, active_task_id, model_profile, final_summary, error_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      destinationId,
      projectId,
      redacted(text(row, "query", "Imported Python RAG session")).slice(0, 240),
      redacted(text(row, "query", "Imported Python RAG session")),
      text(row, "mode", "migration"),
      "completed",
      "python-rag-import",
      createdAt,
      updatedAt,
      null,
      null,
      null,
      redacted(text(row, "output_text")),
      null,
      createdAt,
      updatedAt
    );
  } else if (spec.destinationType === "agent_task") {
    if (!projectId) throw new Error("todo requires a matched project");
    const repo = text(row, "repo");
    const sessionId = ensureTodoSession(db, sourceDatabase, repo, projectId, now);
    db.prepare(
      `INSERT INTO agent_tasks (
        id, session_id, parent_task_id, title, description, type, status, priority, risk,
        expected_files_json, actual_files_json, checks_json, result_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      destinationId,
      sessionId,
      null,
      redacted(text(row, "title", "Imported todo")),
      redacted(text(row, "detail")),
      "implementation",
      taskStatus(text(row, "status", "open")),
      0,
      "medium",
      "[]",
      "[]",
      "[]",
      JSON.stringify({ legacySource: `python-rag:${spec.table}:${sourceId}`, sourceHash }),
      createdAt,
      updatedAt
    );
  } else if (spec.destinationType === "context_pack") {
    const content = redacted(text(row, "content"));
    const metadata = parseJsonObject(row.metadata_json ?? "{}", "context_packs.metadata_json");
    const usedTokens = tokenEstimate(content);
    const budgetTokens = Math.max(
      usedTokens,
      typeof metadata.token_ceiling === "number" && Number.isFinite(metadata.token_ceiling)
        ? Math.trunc(metadata.token_ceiling)
        : usedTokens
    );
    db.prepare(
      `INSERT INTO context_packs (
        id, session_id, task_id, project_id, retrieval_query_id,
        budget_tokens, used_tokens, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      destinationId,
      null,
      null,
      projectId,
      null,
      budgetTokens,
      usedTokens,
      `python-rag:${text(row, "name", sourceId)}:${text(row, "agent_target", "generic")}`,
      createdAt
    );
    db.prepare(
      `INSERT INTO context_pack_items (
        id, context_pack_id, kind, source_id, rank, token_count, excerpt,
        included, omission_reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      stableId("legacy_context_item", { destinationId, sourceHash }),
      destinationId,
      "previous_session",
      `python-rag:context_packs:${sourceId}`,
      0,
      usedTokens,
      content,
      1,
      null,
      createdAt
    );
  } else if (spec.destinationType === "eval_case") {
    const expectedFiles = parseJsonStrings(row.expected_files_json ?? "[]", "eval_cases.expected_files_json");
    const expectedSymbols = parseJsonStrings(row.expected_symbols_json ?? "[]", "eval_cases.expected_symbols_json");
    db.prepare(
      `INSERT INTO eval_cases (
        id, project_id, question, expected_files_json, expected_answer_contains,
        difficulty, tags_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      destinationId,
      projectId,
      redacted(text(row, "query")),
      JSON.stringify(expectedFiles),
      null,
      "standard",
      JSON.stringify([
        "python-rag",
        `mode:${text(row, "mode", "deep")}`,
        ...expectedSymbols.map((item) => `symbol:${item}`),
      ]),
      createdAt,
      updatedAt
    );
  } else if (spec.destinationType === "retrieval_query") {
    if (!projectId) throw new Error("retrieval run requires a matched project");
    const rewrites = parseJsonStrings(row.rewrites_json ?? "[]", "retrieval_runs.rewrites_json");
    const analysis = {
      legacySource: `python-rag:retrieval_runs:${sourceId}`,
      sourceHash,
      branch: optionalText(row, "branch"),
      plan: parseJsonObject(row.plan_json ?? "{}", "retrieval_runs.plan_json"),
      rewrites,
      candidateCounts: parseJsonObject(row.candidate_counts_json ?? "{}", "retrieval_runs.candidate_counts_json"),
      selectedFiles: parseJsonStrings(row.selected_files_json ?? "[]", "retrieval_runs.selected_files_json"),
      editScope: parseJsonObject(row.edit_scope_json ?? "{}", "retrieval_runs.edit_scope_json"),
      missingContext: parseJsonObject(row.missing_context_json ?? "{}", "retrieval_runs.missing_context_json"),
      packedContextTokenEstimate:
        typeof row.packed_context_token_estimate === "number" ? row.packed_context_token_estimate : 0,
      timings: parseJsonObject(row.timings_json ?? "{}", "retrieval_runs.timings_json"),
      warnings: parseJsonStrings(row.warnings_json ?? "[]", "retrieval_runs.warnings_json"),
      errors: parseJsonStrings(row.errors_json ?? "[]", "retrieval_runs.errors_json"),
      metadata: parseJsonObject(row.metadata_json ?? "{}", "retrieval_runs.metadata_json"),
    };
    db.prepare(
      `INSERT INTO retrieval_queries (
        id, session_id, task_id, project_id, original_query, intent, mode, depth,
        rewritten_query, analysis_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      destinationId,
      null,
      null,
      projectId,
      redacted(text(row, "query")),
      text(row, "intent", "legacy"),
      text(row, "mode", "deep"),
      text(row, "mode", "deep") === "deep" ? "deep" : "standard",
      typeof rewrites[0] === "string" ? redacted(rewrites[0]) : null,
      redacted(JSON.stringify(analysis)),
      createdAt
    );
  } else if (spec.destinationType === "retrieval_outcome") {
    const legacyRunId = optionalText(row, "run_id");
    if (!legacyRunId) throw new Error("retrieval outcome has no source run_id");
    const importedRun = db
      .prepare(
        `SELECT destination_id FROM legacy_import_items
         WHERE source_system = 'python-rag' AND source_database = ? AND source_table = 'retrieval_runs'
           AND source_id = ? AND status = 'imported'
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(sourceDatabase, legacyRunId) as { destination_id: string | null } | undefined;
    if (!importedRun?.destination_id) throw new Error(`retrieval run ${legacyRunId} was not imported`);
    const missedFiles = parseJsonStrings(row.missed_files_json ?? "[]", "retrieval_outcomes.missed_files_json");
    const outcome = {
      task: redacted(text(row, "task")),
      retrievedFiles: parseJsonStrings(row.retrieved_files_json ?? "[]", "retrieval_outcomes.retrieved_files_json"),
      editedFiles: parseJsonStrings(row.edited_files_json ?? "[]", "retrieval_outcomes.edited_files_json"),
      checksRun: parseJsonStrings(row.checks_run_json ?? "[]", "retrieval_outcomes.checks_run_json"),
      missedFiles,
      passed: Number(row.passed ?? 0) === 1,
      notes: optionalText(row, "notes"),
      legacySource: `python-rag:retrieval_outcomes:${sourceId}`,
    };
    db.prepare(
      `INSERT INTO retrieval_feedback (
        id, retrieval_query_id, chunk_id, rating, missed_path, notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      destinationId,
      importedRun.destination_id,
      null,
      outcome.passed ? "good" : "bad",
      missedFiles[0] ?? null,
      redacted(JSON.stringify(outcome)),
      createdAt
    );
    for (const [index, path] of missedFiles.entries()) {
      db.prepare(
        `INSERT INTO retrieval_misses (
          id, retrieval_query_id, missed_path, confidence, notes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        stableId("legacy_retrieval_miss", { destinationId, index, path }),
        importedRun.destination_id,
        path,
        outcome.passed ? 0.25 : 0.75,
        "Imported Python RAG retrieval outcome",
        createdAt
      );
    }
  } else if (spec.destinationType === "task_graph") {
    if (!projectId) throw new Error("task graph requires a matched project");
    const parsed = parsePythonRagTaskGraph(row.graph_json);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const graph = parsed.value;
    const rowRepo = optionalText(row, "repo");
    if (rowRepo && graph.repo && rowRepo !== graph.repo)
      throw new Error("task graph repo does not match task_runs.repo");
    const rowTask = text(row, "task");
    if (rowTask && graph.task !== rowTask) throw new Error("task graph task does not match task_runs.task");
    const activeTaskId = graph.currentSubtaskId ? legacyTaskId(sourceDatabase, sourceId, graph.currentSubtaskId) : null;
    const graphStatus = text(row, "status", "active");
    const completed = ["done", "completed", "failed", "cancelled"].includes(graphStatus);
    db.prepare(
      `INSERT INTO agent_sessions (
        id, project_id, title, user_goal, mode, status, source, started_at, finished_at,
        duration_ms, active_task_id, model_profile, final_summary, error_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      destinationId,
      projectId,
      redacted(graph.task).slice(0, 240),
      redacted(graph.task),
      graph.mode,
      graphStatus === "failed" ? "failed" : completed ? "completed" : "paused",
      "python-rag-task-graph-import",
      sourceTimestamp(graph.createdAt ?? row.created_at, createdAt),
      completed ? sourceTimestamp(row.finished_at ?? row.updated_at, updatedAt) : null,
      null,
      activeTaskId,
      null,
      graph.summary ? redacted(graph.summary) : null,
      graphStatus === "failed" ? "Imported legacy task graph failed" : null,
      createdAt,
      updatedAt
    );
    for (const subtask of graph.subtasks) {
      const taskId = legacyTaskId(sourceDatabase, sourceId, subtask.id);
      db.prepare(
        `INSERT INTO agent_tasks (
          id, session_id, parent_task_id, title, description, type, status, priority, risk,
          expected_files_json, actual_files_json, checks_json, result_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        taskId,
        destinationId,
        null,
        redacted(subtask.title),
        redacted(subtask.description),
        subtask.type,
        taskStatus(subtask.status),
        0,
        subtask.riskLevel,
        JSON.stringify(subtask.expectedFiles),
        "[]",
        JSON.stringify(subtask.successCheck ? [subtask.successCheck] : []),
        JSON.stringify({
          legacySubtaskId: subtask.id,
          retrievalQuery: redacted(subtask.retrievalQuery),
          attempts: subtask.attempts,
          lastError: subtask.lastError ? redacted(subtask.lastError) : null,
        }),
        sourceTimestamp(subtask.createdAt, createdAt),
        sourceTimestamp(subtask.updatedAt, updatedAt)
      );
    }
    for (const subtask of graph.subtasks) {
      for (const dependency of subtask.dependsOn) {
        db.prepare(
          `INSERT INTO agent_task_dependencies (task_id, depends_on_task_id, source, created_at)
           VALUES (?, ?, ?, ?)`
        ).run(
          legacyTaskId(sourceDatabase, sourceId, subtask.id),
          legacyTaskId(sourceDatabase, sourceId, dependency),
          "python-rag-import",
          createdAt
        );
      }
    }
  } else if (spec.destinationType === "task_outcome") {
    const legacyRunId = optionalText(row, "run_id");
    if (!legacyRunId) throw new Error("task outcome has no source run_id");
    const taskId = legacyTaskId(sourceDatabase, legacyRunId, text(row, "subtask_id"));
    const taskExists = db.prepare("SELECT 1 AS found FROM agent_tasks WHERE id = ?").get(taskId) as
      | { found: number }
      | undefined;
    if (!taskExists)
      throw new Error(`task graph ${legacyRunId} or subtask ${text(row, "subtask_id")} was not imported`);
    db.prepare(
      `INSERT INTO agent_task_outcomes (
        id, task_id, run_id, status, passed, retrieved_files_json, edited_files_json,
        missed_files_json, useless_files_json, checks_json, notes, attempt, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      destinationId,
      taskId,
      legacyRunId,
      text(row, "status", "failed"),
      Number(row.passed ?? 0) === 1 ? 1 : 0,
      JSON.stringify(parseJsonStrings(row.retrieved_files_json ?? "[]", "task_outcomes.retrieved_files_json")),
      JSON.stringify(parseJsonStrings(row.edited_files_json ?? "[]", "task_outcomes.edited_files_json")),
      JSON.stringify(parseJsonStrings(row.missed_files_json ?? "[]", "task_outcomes.missed_files_json")),
      JSON.stringify(parseJsonStrings(row.useless_files_json ?? "[]", "task_outcomes.useless_files_json")),
      JSON.stringify(parseJsonStrings(row.checks_run_json ?? "[]", "task_outcomes.checks_run_json")),
      optionalText(row, "notes") ? redacted(text(row, "notes")) : null,
      typeof row.attempt === "number" ? Math.max(0, Math.trunc(row.attempt)) : 0,
      "python-rag-import",
      createdAt,
      updatedAt
    );
  } else if (spec.destinationType === "memory_candidate") {
    const status = text(row, "status", "pending");
    db.prepare(
      `INSERT INTO memory_candidates (
        id, project_id, session_id, kind, title, body, evidence_json, confidence, scope,
        status, reviewed_at, reviewer_notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      destinationId,
      projectId,
      null,
      text(row, "kind", "legacy_candidate"),
      `Imported ${text(row, "kind", "memory")} candidate`,
      redacted(text(row, "content")),
      evidence(sourceDatabase, spec, sourceId, sourceHash),
      typeof row.confidence === "number" ? row.confidence : 0.5,
      projectId ? "project" : "global",
      ["accepted", "rejected", "pending"].includes(status) ? status : "pending",
      row.reviewed_at == null ? null : sourceTimestamp(row.reviewed_at, now),
      null,
      createdAt,
      updatedAt
    );
  } else if (spec.destinationType === "lesson") {
    const lesson = JSON.parse(text(row, "lesson_json", "{}")) as Record<string, unknown>;
    db.prepare(
      `INSERT INTO lessons (id, project_id, session_id, title, body, tags_json, importance, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      destinationId,
      projectId,
      null,
      redacted(String(lesson.title ?? text(row, "lesson_kind", "Imported lesson"))),
      redacted(String(lesson.body ?? lesson.lesson ?? text(row, "lesson_json"))),
      JSON.stringify(["python-rag", text(row, "lesson_kind", "legacy")]),
      3,
      createdAt,
      createdAt
    );
  } else {
    const fields = memoryFields(spec, row);
    db.prepare(
      `INSERT INTO memory_entries (
        id, candidate_id, project_id, scope, kind, title, body, evidence_json, confidence,
        pinned, archived, last_used_at, use_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      destinationId,
      null,
      projectId,
      projectId ? "project" : "global",
      fields.kind,
      redacted(fields.title),
      redacted(fields.body),
      evidence(sourceDatabase, spec, sourceId, sourceHash),
      Math.max(0, Math.min(1, fields.confidence)),
      0,
      0,
      row.last_used_at == null ? null : sourceTimestamp(row.last_used_at, now),
      0,
      createdAt,
      updatedAt
    );
  }
  return destinationId;
}

export async function applyPythonRagMigration(input: {
  destination: DatabaseSync;
  databasePath: string;
  ragHome?: string;
  projects: InventoryProject[];
  backupPath: string;
}): Promise<PythonRagImportReport> {
  const sourceDatabase = resolve(input.databasePath);
  const inventory = await inventoryPythonRag({
    databasePath: sourceDatabase,
    ragHome: input.ragHome,
    projects: input.projects,
  });
  if (inventory.source.integrity !== "ok") {
    throw new Error(`Refusing import because source integrity is ${inventory.source.integrity}`);
  }
  const sourceFingerprint = await fileHash(sourceDatabase);
  const backup = await createWorkbenchBackup(input.destination, input.backupPath);
  const runId = stableId("legacy_import", { sourceDatabase, sourceFingerprint, startedAt: Date.now() });
  const generatedAt = new Date().toISOString();
  const map = projectMap(inventory);
  const source = new SourceDatabase(sourceDatabase, { readOnly: true });
  const present = sourceTables(source);
  const items: PythonRagImportReport["items"] = [];
  let imported = 0;
  let duplicate = 0;
  let conflicted = 0;
  try {
    input.destination.exec("BEGIN IMMEDIATE");
    input.destination
      .prepare(
        `INSERT INTO legacy_import_runs (
          id, source_system, source_database, source_fingerprint, backup_path, status,
          report_json, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(runId, "python-rag", sourceDatabase, sourceFingerprint, backup.path, "running", "{}", generatedAt, null);
    for (const spec of IMPORT_SPECS) {
      if (!present.has(spec.table)) continue;
      const rows = source.prepare(`SELECT * FROM "${spec.table}"`).all() as SourceRow[];
      for (const row of rows) {
        const sourceId = text(row, spec.idColumn);
        const sourceHash = stableHash(row);
        const sourceRef = `${spec.table}:${sourceId}`;
        const existing = input.destination
          .prepare(
            `SELECT destination_type, destination_id, status, error_message FROM legacy_import_items
             WHERE source_system = ? AND source_database = ? AND source_table = ? AND source_id = ? AND source_hash = ?`
          )
          .get("python-rag", sourceDatabase, spec.table, sourceId, sourceHash) as
          | {
              destination_type: string | null;
              destination_id: string | null;
              status: string;
              error_message: string | null;
            }
          | undefined;
        if (existing) {
          const remainsConflict = existing.status === "conflict";
          if (remainsConflict) conflicted += 1;
          else duplicate += 1;
          items.push({
            source: sourceRef,
            status: remainsConflict ? "conflict" : "duplicate",
            destinationType: existing.destination_type,
            destinationId: existing.destination_id,
            summary: remainsConflict
              ? (existing.error_message ?? "Previously recorded import conflict remains unresolved")
              : "Identical source row was already imported",
          });
          continue;
        }
        const repo = optionalText(row, "repo");
        const projectId = repo ? (map.get(repo) ?? null) : null;
        if (repo && !projectId) {
          conflicted += 1;
          const itemId = stableId("legacy_item", { runId, sourceRef, sourceHash });
          input.destination
            .prepare(
              `INSERT INTO legacy_import_items (
                id, run_id, source_system, source_database, source_table, source_id, source_hash,
                project_id, destination_type, destination_id, status, error_message, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              itemId,
              runId,
              "python-rag",
              sourceDatabase,
              spec.table,
              sourceId,
              sourceHash,
              null,
              null,
              null,
              "conflict",
              `No canonical project matches source repo ${repo}`,
              generatedAt
            );
          items.push({
            source: sourceRef,
            status: "conflict",
            destinationType: null,
            destinationId: null,
            summary: `No canonical project matches source repo ${repo}`,
          });
          continue;
        }
        try {
          input.destination.exec("SAVEPOINT legacy_import_row");
          const destinationId = insertDestination({
            db: input.destination,
            spec,
            row,
            sourceId,
            sourceHash,
            sourceDatabase,
            projectId,
            now: generatedAt,
          });
          const itemId = stableId("legacy_item", { runId, sourceRef, sourceHash });
          input.destination
            .prepare(
              `INSERT INTO legacy_import_items (
                id, run_id, source_system, source_database, source_table, source_id, source_hash,
                project_id, destination_type, destination_id, status, error_message, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              itemId,
              runId,
              "python-rag",
              sourceDatabase,
              spec.table,
              sourceId,
              sourceHash,
              projectId,
              spec.destinationType,
              destinationId,
              "imported",
              null,
              generatedAt
            );
          input.destination.exec("RELEASE SAVEPOINT legacy_import_row");
          imported += 1;
          items.push({
            source: sourceRef,
            status: "imported",
            destinationType: spec.destinationType,
            destinationId,
            summary: "Imported with legacy provenance",
          });
        } catch (error) {
          input.destination.exec("ROLLBACK TO SAVEPOINT legacy_import_row");
          input.destination.exec("RELEASE SAVEPOINT legacy_import_row");
          conflicted += 1;
          const summary = error instanceof Error ? error.message : String(error);
          const itemId = stableId("legacy_item", { runId, sourceRef, sourceHash });
          input.destination
            .prepare(
              `INSERT INTO legacy_import_items (
                id, run_id, source_system, source_database, source_table, source_id, source_hash,
                project_id, destination_type, destination_id, status, error_message, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              itemId,
              runId,
              "python-rag",
              sourceDatabase,
              spec.table,
              sourceId,
              sourceHash,
              projectId,
              null,
              null,
              "conflict",
              summary,
              generatedAt
            );
          items.push({
            source: sourceRef,
            status: "conflict",
            destinationType: null,
            destinationId: null,
            summary,
          });
        }
      }
    }
    for (const handoff of inventory.handoffs) {
      const sourceId = handoff.path;
      const sourceRef = `handoffs_markdown:${sourceId}`;
      const projectId = map.get(handoff.sourceRepo) ?? null;
      const fileInfo = await stat(handoff.path);
      if (!fileInfo.isFile()) continue;
      const content = fileInfo.size <= 2_000_000 ? await readFile(handoff.path, "utf8") : null;
      const sourceHash = stableHash({ content, size: fileInfo.size });
      const existing = input.destination
        .prepare(
          `SELECT destination_type, destination_id, status, error_message FROM legacy_import_items
           WHERE source_system = ? AND source_database = ? AND source_table = ? AND source_id = ? AND source_hash = ?`
        )
        .get("python-rag", sourceDatabase, "handoffs_markdown", sourceId, sourceHash) as
        | {
            destination_type: string | null;
            destination_id: string | null;
            status: string;
            error_message: string | null;
          }
        | undefined;
      if (existing) {
        const remainsConflict = existing.status === "conflict";
        if (remainsConflict) conflicted += 1;
        else duplicate += 1;
        items.push({
          source: sourceRef,
          status: remainsConflict ? "conflict" : "duplicate",
          destinationType: existing.destination_type,
          destinationId: existing.destination_id,
          summary: remainsConflict
            ? (existing.error_message ?? "Previously recorded handoff conflict remains unresolved")
            : "Identical handoff was already imported",
        });
        continue;
      }
      const conflict = !projectId
        ? `No canonical project matches handoff scope ${handoff.sourceRepo}`
        : content == null
          ? `Handoff exceeds the 2000000 byte safety limit: ${handoff.path}`
          : null;
      const itemId = stableId("legacy_item", { runId, sourceRef, sourceHash });
      if (conflict) {
        conflicted += 1;
        input.destination
          .prepare(
            `INSERT INTO legacy_import_items (
              id, run_id, source_system, source_database, source_table, source_id, source_hash,
              project_id, destination_type, destination_id, status, error_message, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            itemId,
            runId,
            "python-rag",
            sourceDatabase,
            "handoffs_markdown",
            sourceId,
            sourceHash,
            projectId,
            null,
            null,
            "conflict",
            conflict,
            generatedAt
          );
        items.push({
          source: sourceRef,
          status: "conflict",
          destinationType: null,
          destinationId: null,
          summary: conflict,
        });
        continue;
      }
      const safeContent = redacted(content as string);
      const legacyTarget =
        safeContent
          .match(/^## Target agent\s*\n([^\n]+)/m)?.[1]
          ?.trim()
          .toLowerCase() ?? "generic";
      const target = legacyTarget === "codex" || legacyTarget === "opencode" ? legacyTarget : "manual";
      const destinationId = stableId("legacy_handoff", { sourceDatabase, sourceId, sourceHash });
      const createdAt = new Date(fileInfo.mtimeMs).toISOString();
      input.destination.exec("SAVEPOINT legacy_handoff_row");
      try {
        input.destination
          .prepare(
            `INSERT INTO handoffs (
              id, session_id, task_id, project_id, target, prompt, selected_context_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            destinationId,
            null,
            null,
            projectId,
            target,
            safeContent,
            JSON.stringify({
              filesToInspect: [],
              filesLikelyToEdit: [],
              checksToRun: [],
              constraints: ["Imported read-only from Python RAG compatibility storage"],
              legacyTarget,
              legacySourcePath: handoff.path,
              sourceHash,
            }),
            createdAt,
            createdAt
          );
        input.destination
          .prepare(
            `INSERT INTO legacy_import_items (
              id, run_id, source_system, source_database, source_table, source_id, source_hash,
              project_id, destination_type, destination_id, status, error_message, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            itemId,
            runId,
            "python-rag",
            sourceDatabase,
            "handoffs_markdown",
            sourceId,
            sourceHash,
            projectId,
            "handoff",
            destinationId,
            "imported",
            null,
            generatedAt
          );
        input.destination.exec("RELEASE SAVEPOINT legacy_handoff_row");
        imported += 1;
        items.push({
          source: sourceRef,
          status: "imported",
          destinationType: "handoff",
          destinationId,
          summary: `Imported ${basename(handoff.path)} with legacy provenance`,
        });
      } catch (error) {
        input.destination.exec("ROLLBACK TO SAVEPOINT legacy_handoff_row");
        input.destination.exec("RELEASE SAVEPOINT legacy_handoff_row");
        throw error;
      }
    }
    const deferred = inventory.totals.referenceRows + inventory.totals.regenerableRows;
    const report: PythonRagImportReport = {
      schemaVersion: 1,
      mode: "apply",
      runId,
      generatedAt,
      sourceDatabase,
      sourceFingerprint,
      backup,
      inventory,
      totals: { imported, duplicate, conflicted, deferred },
      items,
      rollback: {
        restoreFrom: backup.path,
        instructions: [
          "Stop Workbench services before restoring the SQLite file.",
          "Keep the current database as a forensic copy.",
          "Restore the validated backup atomically, restart Workbench, and run ai diagnose.",
        ],
      },
    };
    input.destination
      .prepare("UPDATE legacy_import_runs SET status = ?, report_json = ?, finished_at = ? WHERE id = ?")
      .run(
        conflicted > 0 ? "completed_with_conflicts" : "completed",
        JSON.stringify(report),
        new Date().toISOString(),
        runId
      );
    input.destination.exec("COMMIT");
    return report;
  } catch (error) {
    input.destination.exec("ROLLBACK");
    throw error;
  } finally {
    source.close();
  }
}
