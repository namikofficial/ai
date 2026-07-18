export type PythonRagSubtaskStatus = "pending" | "ready" | "running" | "blocked" | "done" | "failed" | "skipped";
export type PythonRagSubtaskType = "research" | "edit" | "test" | "docs" | "refactor" | "debug" | "cleanup";

export interface PythonRagSubtask {
  id: string;
  title: string;
  description: string;
  type: PythonRagSubtaskType;
  status: PythonRagSubtaskStatus;
  dependsOn: string[];
  retrievalQuery: string;
  expectedFiles: string[];
  successCheck: string;
  riskLevel: "low" | "medium" | "high";
  createdAt: number | null;
  updatedAt: number | null;
  attempts: number;
  lastError: string | null;
}

export interface PythonRagTaskGraph {
  taskId: string;
  task: string;
  repo: string | null;
  mode: string;
  maxSubtasks: number;
  subtasks: PythonRagSubtask[];
  createdAt: number | null;
  updatedAt: number | null;
  currentSubtaskId: string | null;
  runId: string | null;
  summary: string | null;
}

export type PythonRagTaskGraphParseResult = { ok: true; value: PythonRagTaskGraph } | { ok: false; errors: string[] };

const STATUSES = new Set<PythonRagSubtaskStatus>([
  "pending",
  "ready",
  "running",
  "blocked",
  "done",
  "failed",
  "skipped",
]);
const TYPES = new Set<PythonRagSubtaskType>(["research", "edit", "test", "docs", "refactor", "debug", "cleanup"]);

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(value: unknown, path: string, errors: string[]): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${path} must be a non-empty string`);
    return "";
  }
  return value;
}

function optionalString(value: unknown, path: string, errors: string[]): string | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    errors.push(`${path} must be a string or null`);
    return null;
  }
  return value;
}

function strings(value: unknown, path: string, errors: string[]): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    errors.push(`${path} must be an array of strings`);
    return [];
  }
  return [...new Set(value as string[])];
}

function finiteNumber(value: unknown, path: string, errors: string[], fallback: number): number {
  if (value == null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(`${path} must be a finite number`);
    return fallback;
  }
  return value;
}

function findCycle(subtasks: PythonRagSubtask[]): string[] | null {
  const dependencies = new Map(subtasks.map((subtask) => [subtask.id, subtask.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      return [...path.slice(start), id];
    }
    if (visited.has(id)) return null;
    visiting.add(id);
    path.push(id);
    for (const dependency of dependencies.get(id) ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    path.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  };
  for (const subtask of subtasks) {
    const cycle = visit(subtask.id);
    if (cycle) return cycle;
  }
  return null;
}

export function parsePythonRagTaskGraph(value: unknown): PythonRagTaskGraphParseResult {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch (error) {
      return {
        ok: false,
        errors: [`graph_json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
  }
  const root = object(parsed);
  if (!root) return { ok: false, errors: ["task graph must be an object"] };
  const errors: string[] = [];
  const taskId = requiredString(root.task_id, "task_id", errors);
  const task = requiredString(root.task, "task", errors);
  const repo = optionalString(root.repo, "repo", errors);
  const mode = typeof root.mode === "string" && root.mode.length > 0 ? root.mode : "auto";
  const maxSubtasks = Math.trunc(finiteNumber(root.max_subtasks, "max_subtasks", errors, 8));
  if (maxSubtasks < 1 || maxSubtasks > 256) errors.push("max_subtasks must be between 1 and 256");
  if (!Array.isArray(root.subtasks)) errors.push("subtasks must be an array");
  const rawSubtasks = Array.isArray(root.subtasks) ? root.subtasks : [];
  if (rawSubtasks.length > 256) errors.push("subtasks exceeds the 256 item safety limit");
  if (rawSubtasks.length > maxSubtasks) errors.push("subtasks exceeds max_subtasks");
  const subtasks: PythonRagSubtask[] = [];
  for (const [index, raw] of rawSubtasks.entries()) {
    const item = object(raw);
    if (!item) {
      errors.push(`subtasks[${index}] must be an object`);
      continue;
    }
    const status = item.status;
    const type = item.type;
    if (typeof status !== "string" || !STATUSES.has(status as PythonRagSubtaskStatus)) {
      errors.push(`subtasks[${index}].status is unsupported`);
    }
    if (typeof type !== "string" || !TYPES.has(type as PythonRagSubtaskType)) {
      errors.push(`subtasks[${index}].type is unsupported`);
    }
    const risk = typeof item.risk_level === "string" ? item.risk_level : "medium";
    if (!["low", "medium", "high"].includes(risk)) errors.push(`subtasks[${index}].risk_level is unsupported`);
    subtasks.push({
      id: requiredString(item.id, `subtasks[${index}].id`, errors),
      title: requiredString(item.title, `subtasks[${index}].title`, errors),
      description: typeof item.description === "string" ? item.description : "",
      type: TYPES.has(type as PythonRagSubtaskType) ? (type as PythonRagSubtaskType) : "research",
      status: STATUSES.has(status as PythonRagSubtaskStatus) ? (status as PythonRagSubtaskStatus) : "pending",
      dependsOn: strings(item.depends_on ?? [], `subtasks[${index}].depends_on`, errors),
      retrievalQuery: typeof item.retrieval_query === "string" ? item.retrieval_query : "",
      expectedFiles: strings(item.expected_files ?? [], `subtasks[${index}].expected_files`, errors),
      successCheck: typeof item.success_check === "string" ? item.success_check : "",
      riskLevel: ["low", "medium", "high"].includes(risk) ? (risk as "low" | "medium" | "high") : "medium",
      createdAt:
        item.created_at == null ? null : finiteNumber(item.created_at, `subtasks[${index}].created_at`, errors, 0),
      updatedAt:
        item.updated_at == null ? null : finiteNumber(item.updated_at, `subtasks[${index}].updated_at`, errors, 0),
      attempts: Math.max(0, Math.trunc(finiteNumber(item.attempts, `subtasks[${index}].attempts`, errors, 0))),
      lastError: optionalString(item.last_error, `subtasks[${index}].last_error`, errors),
    });
  }
  const ids = new Set<string>();
  for (const subtask of subtasks) {
    if (ids.has(subtask.id)) errors.push(`duplicate subtask id: ${subtask.id}`);
    ids.add(subtask.id);
  }
  for (const subtask of subtasks) {
    for (const dependency of subtask.dependsOn) {
      if (dependency === subtask.id) errors.push(`subtask ${subtask.id} cannot depend on itself`);
      else if (!ids.has(dependency)) errors.push(`subtask ${subtask.id} has unknown dependency ${dependency}`);
    }
  }
  const cycle = findCycle(subtasks);
  if (cycle) errors.push(`task graph contains a dependency cycle: ${cycle.join(" -> ")}`);
  const currentSubtaskId = optionalString(root.current_subtask_id, "current_subtask_id", errors);
  if (currentSubtaskId && !ids.has(currentSubtaskId)) errors.push("current_subtask_id does not reference a subtask");
  const createdAt = root.created_at == null ? null : finiteNumber(root.created_at, "created_at", errors, 0);
  const updatedAt = root.updated_at == null ? null : finiteNumber(root.updated_at, "updated_at", errors, 0);
  const runId = optionalString(root.run_id, "run_id", errors);
  const summary = optionalString(root.summary, "summary", errors);
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      taskId,
      task,
      repo,
      mode,
      maxSubtasks,
      subtasks,
      createdAt,
      updatedAt,
      currentSubtaskId,
      runId,
      summary,
    },
  };
}
