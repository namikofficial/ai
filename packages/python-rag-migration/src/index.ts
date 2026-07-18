import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type PythonRagParity =
  | "already_present"
  | "partially_present"
  | "absent"
  | "superior_in_python_rag"
  | "duplicate"
  | "safe_to_retire_later";

export interface PythonRagCapabilityMapping {
  capability: string;
  source: string;
  destination: string;
  parity: PythonRagParity;
  migration: "import" | "reference" | "regenerate" | "compatibility";
  notes: string;
}

export interface PythonRagInventoryReport {
  schemaVersion: 1;
  mode: "dry_run";
  generatedAt: string;
  source: {
    system: "python-rag";
    databasePath: string;
    databaseSizeBytes: number;
    integrity: string;
    migrations: string[];
    ragHome: string;
  };
  tables: Array<{
    name: string;
    present: boolean;
    rows: number;
    columns: string[];
    invalidJsonRows: number;
  }>;
  projects: Array<{
    sourceRepo: string;
    sourceRoot: string;
    destinationProjectId: string | null;
    status: "matched" | "unmatched" | "ambiguous";
  }>;
  handoffs: Array<{ sourceRepo: string; path: string; format: "markdown" }>;
  capabilities: PythonRagCapabilityMapping[];
  totals: { sourceRows: number; importableRows: number; referenceRows: number; regenerableRows: number };
  conflicts: Array<{ code: string; source: string; summary: string }>;
  warnings: string[];
  nextActions: string[];
}

export interface InventoryProject {
  id: string;
  name: string;
  path: string;
}

const CAPABILITIES: PythonRagCapabilityMapping[] = [
  {
    capability: "todos",
    source: "task_todos",
    destination: "agent_sessions + agent_tasks",
    parity: "partially_present",
    migration: "import",
    notes: "Map software-development todos to imported sessions/tasks with provenance.",
  },
  {
    capability: "decisions",
    source: "task_decisions",
    destination: "memory_entries",
    parity: "partially_present",
    migration: "import",
    notes: "Preserve rationale and source session as typed evidence.",
  },
  {
    capability: "command memory",
    source: "command_memory",
    destination: "memory_entries(command_worked)",
    parity: "superior_in_python_rag",
    migration: "import",
    notes: "Python stores command purpose and notes; Workbench must retain both.",
  },
  {
    capability: "error memory",
    source: "error_memory + test_failure_memory",
    destination: "memory_entries(error_fix/command_failed)",
    parity: "superior_in_python_rag",
    migration: "import",
    notes: "Preserve fingerprints, fixes and redacted evidence without copying secret output blindly.",
  },
  {
    capability: "durable project memory",
    source: "developer_memory + repo_memory",
    destination: "memory_entries + project facts",
    parity: "partially_present",
    migration: "import",
    notes: "Workbench owns the destination; provenance distinguishes generated summaries from user memory.",
  },
  {
    capability: "sessions and compaction",
    source: "task_sessions + session_compactions",
    destination: "agent_sessions + conversation/memory summaries",
    parity: "partially_present",
    migration: "import",
    notes: "Import summaries and references; do not fabricate missing message histories.",
  },
  {
    capability: "context packs",
    source: "context_packs",
    destination: "context_packs / memory references",
    parity: "superior_in_python_rag",
    migration: "import",
    notes: "Validated text becomes a canonical context pack item with source provenance and estimated token use.",
  },
  {
    capability: "handoffs",
    source: "projects/*/handoffs/*.md",
    destination: "agent_handoffs",
    parity: "partially_present",
    migration: "import",
    notes: "Import bounded, redacted Markdown with stable content hashes while retaining its source path and target.",
  },
  {
    capability: "retrieval diagnostics",
    source: "retrieval_runs + retrieval_outcomes",
    destination: "retrieval queries/results/feedback/misses",
    parity: "already_present",
    migration: "import",
    notes:
      "Import runs as canonical retrieval queries and outcomes as feedback/misses; regenerate indexes instead of copying vectors.",
  },
  {
    capability: "retrieval evaluation",
    source: "eval_cases + eval_runs",
    destination: "eval_cases + eval_runs",
    parity: "already_present",
    migration: "import",
    notes: "Import cases directly; preserve aggregate legacy run metrics as typed retrieval-evaluation memory.",
  },
  {
    capability: "task graphs and subtask outcomes",
    source: "task_runs + task_outcomes",
    destination: "plans + agent_tasks + execution outcomes",
    parity: "superior_in_python_rag",
    migration: "import",
    notes: "Validate documented TaskGraph nodes, dependencies, cycles and outcomes before canonical task-DAG import.",
  },
  {
    capability: "lessons",
    source: "task_lessons",
    destination: "lessons + memory candidates",
    parity: "already_present",
    migration: "import",
    notes: "Map documented lesson JSON only; invalid payloads become conflicts.",
  },
  {
    capability: "MCP interfaces",
    source: "Python MCP server",
    destination: "Workbench MCP server",
    parity: "duplicate",
    migration: "compatibility",
    notes: "Run both during parity; retire Python tools only after client-level acceptance tests.",
  },
  {
    capability: "chunks, symbols and vector index",
    source: "chunks/symbols/Qdrant",
    destination: "Workbench index metadata + optional Qdrant",
    parity: "safe_to_retire_later",
    migration: "regenerate",
    notes: "Indexes are regenerable and embedding dimensions may differ; never copy vectors or opaque caches.",
  },
];

const TABLE_JSON_COLUMNS: Record<string, string[]> = {
  task_sessions: ["relevant_files_json"],
  developer_memory: [],
  repo_memory: ["important_paths", "conventions", "changed_files_json", "changed_symbols_json"],
  context_packs: ["metadata_json"],
  session_compactions: ["extracted_json"],
  error_memory: ["stack_symbols_json", "file_paths_json"],
  test_failure_memory: ["stack_symbols_json", "file_paths_json"],
  execution_runs: ["agent_plan_json", "files_modified"],
  memory_candidates: ["evidence_json"],
  retrieval_runs: [
    "plan_json",
    "rewrites_json",
    "candidate_counts_json",
    "selected_files_json",
    "edit_scope_json",
    "missing_context_json",
    "timings_json",
    "warnings_json",
    "errors_json",
    "metadata_json",
  ],
  retrieval_outcomes: ["retrieved_files_json", "edited_files_json", "checks_run_json", "missed_files_json"],
  eval_cases: ["expected_files_json", "expected_symbols_json"],
  eval_runs: ["metrics_json"],
  task_runs: ["graph_json"],
  task_outcomes: [
    "retrieved_files_json",
    "edited_files_json",
    "missed_files_json",
    "useless_files_json",
    "checks_run_json",
  ],
  task_lessons: ["lesson_json"],
};

const TABLES = [
  "indexed_repos",
  "chunks",
  "facts",
  "file_summaries",
  "symbols",
  "semantic_lines",
  "file_dependencies",
  "package_summaries",
  "task_todos",
  "task_decisions",
  "command_memory",
  "error_memory",
  "task_sessions",
  "developer_memory",
  "repo_memory",
  "context_packs",
  "session_compactions",
  "test_failure_memory",
  "execution_runs",
  "memory_candidates",
  "retrieval_runs",
  "retrieval_outcomes",
  "eval_cases",
  "eval_runs",
  "task_runs",
  "task_outcomes",
  "task_lessons",
] as const;

const IMPORT_TABLES = new Set([
  "task_todos",
  "task_decisions",
  "command_memory",
  "error_memory",
  "task_sessions",
  "developer_memory",
  "repo_memory",
  "session_compactions",
  "test_failure_memory",
  "memory_candidates",
  "context_packs",
  "eval_cases",
  "eval_runs",
  "retrieval_runs",
  "retrieval_outcomes",
  "task_runs",
  "task_outcomes",
  "task_lessons",
]);
const REFERENCE_TABLES = new Set(["execution_runs"]);
const REGENERABLE_TABLES = new Set([
  "indexed_repos",
  "chunks",
  "facts",
  "file_summaries",
  "symbols",
  "semantic_lines",
  "file_dependencies",
  "package_summaries",
]);

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function tableNames(db: DatabaseSync): Set<string> {
  return new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all() as Array<{ name: string }>).map(
      (row) => row.name
    )
  );
}

function invalidJsonRows(db: DatabaseSync, table: string, columns: string[]): number {
  if (columns.length === 0) return 0;
  const actualColumns = new Set(
    (db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>).map((row) => row.name)
  );
  const available = columns.filter((column) => actualColumns.has(column));
  if (available.length === 0) return 0;
  const predicate = available
    .map((column) => `(${quoteIdentifier(column)} IS NOT NULL AND NOT json_valid(${quoteIdentifier(column)}))`)
    .join(" OR ");
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)} WHERE ${predicate}`).get() as {
    count: number;
  };
  return row.count;
}

async function findHandoffs(ragHome: string): Promise<Array<{ sourceRepo: string; path: string; format: "markdown" }>> {
  const projectsRoot = join(ragHome, "projects");
  const results: Array<{ sourceRepo: string; path: string; format: "markdown" }> = [];
  let scopes: Dirent[] = [];
  try {
    scopes = (await readdir(projectsRoot, { withFileTypes: true })) as Dirent[];
  } catch {
    return results;
  }
  for (const scope of scopes) {
    if (!scope.isDirectory()) continue;
    const handoffRoot = join(projectsRoot, scope.name, "handoffs");
    let entries: Dirent[] = [];
    try {
      entries = (await readdir(handoffRoot, { withFileTypes: true })) as Dirent[];
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push({ sourceRepo: scope.name, path: join(handoffRoot, entry.name), format: "markdown" });
      }
    }
  }
  return results.sort((left, right) => left.path.localeCompare(right.path));
}

export async function inventoryPythonRag(input: {
  databasePath: string;
  ragHome?: string;
  projects: InventoryProject[];
}): Promise<PythonRagInventoryReport> {
  const databasePath = resolve(input.databasePath);
  const sourceStat = await stat(databasePath);
  if (!sourceStat.isFile()) throw new Error(`Python RAG database is not a file: ${databasePath}`);
  const ragHome = resolve(input.ragHome ?? dirname(databasePath));
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrity =
      (db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string }).integrity_check ?? "unknown";
    const presentTables = tableNames(db);
    const tables = TABLES.map((name) => {
      if (!presentTables.has(name)) return { name, present: false, rows: 0, columns: [], invalidJsonRows: 0 };
      const columns = (db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as Array<{ name: string }>).map(
        (row) => row.name
      );
      const rows = (db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`).get() as { count: number })
        .count;
      return {
        name,
        present: true,
        rows,
        columns,
        invalidJsonRows: invalidJsonRows(db, name, TABLE_JSON_COLUMNS[name] ?? []),
      };
    });
    const migrations = presentTables.has("_schema_migrations")
      ? (db.prepare("SELECT id FROM _schema_migrations ORDER BY id").all() as Array<{ id: string }>).map(
          (row) => row.id
        )
      : [];
    const indexedRepos = presentTables.has("indexed_repos")
      ? (db.prepare("SELECT repo, root FROM indexed_repos ORDER BY repo").all() as Array<{
          repo: string;
          root: string;
        }>)
      : [];
    const conflicts: PythonRagInventoryReport["conflicts"] = [];
    const projects = indexedRepos.map((source) => {
      const matches = input.projects.filter(
        (project) => samePath(project.path, source.root) || project.name.toLowerCase() === source.repo.toLowerCase()
      );
      const status = matches.length === 1 ? "matched" : matches.length > 1 ? "ambiguous" : "unmatched";
      if (status !== "matched") {
        conflicts.push({
          code: status === "ambiguous" ? "ambiguous_project" : "unmatched_project",
          source: `indexed_repos:${source.repo}`,
          summary:
            status === "ambiguous"
              ? `Multiple Workbench projects match ${source.root}`
              : `No Workbench project matches ${source.root}`,
        });
      }
      return {
        sourceRepo: source.repo,
        sourceRoot: source.root,
        destinationProjectId: matches.length === 1 ? matches[0].id : null,
        status,
      } as const;
    });
    for (const table of tables) {
      if (table.invalidJsonRows > 0) {
        conflicts.push({
          code: "invalid_json",
          source: table.name,
          summary: `${table.invalidJsonRows} row(s) contain invalid documented JSON fields`,
        });
      }
    }
    const handoffs = await findHandoffs(ragHome);
    const sourceRows = tables.reduce((sum, table) => sum + table.rows, 0);
    const importableRows =
      tables.filter((table) => IMPORT_TABLES.has(table.name)).reduce((sum, table) => sum + table.rows, 0) +
      handoffs.length;
    const referenceRows = tables
      .filter((table) => REFERENCE_TABLES.has(table.name))
      .reduce((sum, table) => sum + table.rows, 0);
    const regenerableRows = tables
      .filter((table) => REGENERABLE_TABLES.has(table.name))
      .reduce((sum, table) => sum + table.rows, 0);
    const warnings = [
      ...(integrity === "ok" ? [] : [`Source SQLite integrity is ${integrity}`]),
      ...(handoffs.length > 0
        ? ["Legacy Markdown handoffs require compatibility parsing before canonical import."]
        : []),
      "Chunks, embeddings, FTS tables, Qdrant vectors and retrieval caches are intentionally excluded as regenerable data.",
      "Dry-run inventory performs no destination writes and does not execute Python code or deserialize opaque objects.",
    ];
    return {
      schemaVersion: 1,
      mode: "dry_run",
      generatedAt: new Date().toISOString(),
      source: {
        system: "python-rag",
        databasePath,
        databaseSizeBytes: sourceStat.size,
        integrity,
        migrations,
        ragHome,
      },
      tables,
      projects,
      handoffs,
      capabilities: CAPABILITIES,
      totals: { sourceRows, importableRows, referenceRows, regenerableRows },
      conflicts,
      warnings,
      nextActions: [
        "Resolve every unmatched or ambiguous project against the canonical registry.",
        "Back up Workbench SQLite before the first apply run.",
        "Review invalid JSON and legacy Markdown handoff conflicts.",
        "Run the importer in apply mode only after the dry-run report is accepted.",
        "Keep Python RAG and Workbench in compatibility mode until parity tests pass.",
      ],
    };
  } finally {
    db.close();
  }
}

export function pythonRagCapabilityMappings(): PythonRagCapabilityMapping[] {
  return CAPABILITIES.map((mapping) => ({ ...mapping }));
}
