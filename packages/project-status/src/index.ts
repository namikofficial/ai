import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ActiveWork,
  GitStatus,
  PackageManager,
  ProjectManifest,
  ProjectStatus,
  RecommendedAction,
  RuntimeHealth,
  UnifiedState,
} from "../../contracts/src/index.ts";
import { CONTROL_PLANE_SCHEMA_VERSION } from "../../contracts/src/index.ts";
import type { createStore } from "../../db/src/store.ts";
import { atomicWriteJson, defaultRegistryCachePath } from "../../project-registry/src/index.ts";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CommandRunner {
  run(binary: string, args: string[], options: { cwd: string; timeoutMs: number }): Promise<CommandResult>;
}

export const processCommandRunner: CommandRunner = {
  run(binary, args, options) {
    return new Promise((resolve) => {
      const child = spawn(binary, args, {
        cwd: options.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const finish = (exitCode: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode, stdout, stderr, timedOut });
      };
      child.on("error", (error) => {
        stderr = stderr || error.message;
        finish(127);
      });
      // `exit` may fire before the stdio streams have been fully drained. Waiting
      // for `close` keeps short-lived commands such as Git status/log from
      // intermittently returning an empty or truncated payload.
      child.once("close", (code) => finish(typeof code === "number" ? code : 1));
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 1_000);
      }, options.timeoutMs);
    });
  },
};

export function emptyGitStatus(): GitStatus {
  return {
    branch: null,
    head: null,
    detached: false,
    unborn: false,
    modified: 0,
    staged: 0,
    untracked: 0,
    deleted: 0,
    renamed: 0,
    conflicts: 0,
    stashes: 0,
    ahead: 0,
    behind: 0,
    dirty: false,
  };
}

function countTracked(status: GitStatus, xy: string, renamed: boolean): void {
  const index = xy[0] ?? ".";
  const worktree = xy[1] ?? ".";
  if (index !== ".") status.staged += 1;
  if (index === "M" || worktree === "M" || index === "T" || worktree === "T") status.modified += 1;
  if (index === "D" || worktree === "D") status.deleted += 1;
  if (renamed || index === "R" || worktree === "R" || index === "C" || worktree === "C") status.renamed += 1;
}

/** Parse `git status --porcelain=v2 --branch --show-stash`. */
export function parseGitPorcelainV2(output: string): GitStatus {
  const status = emptyGitStatus();
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    if (line.startsWith("# branch.head ")) {
      const head = line.slice(14);
      status.detached = head === "(detached)";
      status.branch = status.detached ? null : head;
    } else if (line.startsWith("# branch.oid ")) {
      const oid = line.slice(13);
      status.unborn = oid === "(initial)";
      status.head = status.unborn ? null : oid;
    } else if (line.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
      if (match) {
        status.ahead = Number(match[1]);
        status.behind = Number(match[2]);
      }
    } else if (line.startsWith("# stash ")) {
      status.stashes = Number(line.slice(8)) || 0;
    } else if (line.startsWith("1 ")) {
      countTracked(status, line.slice(2, 4), false);
    } else if (line.startsWith("2 ")) {
      countTracked(status, line.slice(2, 4), true);
    } else if (line.startsWith("u ")) {
      status.conflicts += 1;
    } else if (line.startsWith("? ")) {
      status.untracked += 1;
    }
  }
  status.dirty =
    status.modified + status.staged + status.untracked + status.deleted + status.renamed + status.conflicts > 0;
  return status;
}

export interface GitStatusResult {
  state: UnifiedState;
  status: GitStatus | null;
  error: string | null;
}

export async function collectGitStatus(
  projectPath: string,
  runner: CommandRunner = processCommandRunner
): Promise<GitStatusResult> {
  const result = await runner.run(
    "git",
    ["status", "--porcelain=v2", "--branch", "--show-stash", "--untracked-files=normal"],
    { cwd: projectPath, timeoutMs: 5_000 }
  );
  if (result.exitCode !== 0) {
    const detail = result.timedOut ? "Git status timed out" : result.stderr.trim() || "Not a Git repository";
    return { state: result.timedOut ? "stale" : "unknown", status: null, error: detail };
  }
  return { state: "ready", status: parseGitPorcelainV2(result.stdout), error: null };
}

/** Parse NUL-delimited porcelain-v1 output without breaking paths containing spaces. */
export function parseGitChangedPaths(output: string): string[] {
  const records = output.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (path) paths.push(path);
    if (status.includes("R") || status.includes("C")) index += 1;
  }
  return [...new Set(paths)];
}

export async function collectGitChangedPaths(
  projectPath: string,
  runner: CommandRunner = processCommandRunner
): Promise<{ paths: string[]; error: string | null }> {
  const result = await runner.run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=normal"], {
    cwd: projectPath,
    timeoutMs: 5_000,
  });
  if (result.exitCode !== 0) {
    return {
      paths: [],
      error: result.timedOut ? "Git changed-file query timed out" : result.stderr.trim() || "Git unavailable",
    };
  }
  return { paths: parseGitChangedPaths(result.stdout), error: null };
}

export interface ComposeServiceStatus {
  id: string;
  name: string;
  state: UnifiedState;
  detail: string | null;
}

export interface ComposeStatusResult {
  state: UnifiedState;
  services: ComposeServiceStatus[];
  error: string | null;
}

interface ComposePsRow {
  Service?: unknown;
  Name?: unknown;
  State?: unknown;
  Status?: unknown;
  Health?: unknown;
}

function parseComposeRows(output: string): ComposePsRow[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? (parsed as ComposePsRow[]) : [parsed as ComposePsRow];
  } catch {
    return trimmed
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line) as ComposePsRow;
        } catch {
          return null;
        }
      })
      .filter((row): row is ComposePsRow => row !== null);
  }
}

function composeServiceState(row: ComposePsRow | undefined): { state: UnifiedState; detail: string | null } {
  if (!row) return { state: "offline", detail: "stopped" };
  const processState = String(row.State ?? "").toLowerCase();
  const health = String(row.Health ?? "").toLowerCase();
  const detail = String(row.Status ?? row.State ?? "").trim() || null;
  if (health === "unhealthy") return { state: "failed", detail: detail ?? "unhealthy" };
  if (health === "starting") return { state: "starting", detail: detail ?? "health check starting" };
  if (processState === "running" && (!health || health === "healthy")) return { state: "ready", detail };
  if (processState === "restarting" || processState === "created") return { state: "starting", detail };
  if (processState === "exited" || processState === "dead" || processState === "paused") {
    return { state: "offline", detail };
  }
  return { state: "unknown", detail };
}

/** Discover only actual Compose services; volumes and other top-level keys never enter this list. */
export async function collectComposeStatus(
  projectPath: string,
  runner: CommandRunner = processCommandRunner,
  composeFiles: string[] = [],
  profiles: string[] = []
): Promise<ComposeStatusResult> {
  const commonArgs = [
    "compose",
    ...composeFiles.flatMap((file) => ["--file", file]),
    ...profiles.flatMap((profile) => ["--profile", profile]),
  ];
  const config = await runner.run("docker", [...commonArgs, "config", "--services"], {
    cwd: projectPath,
    timeoutMs: 8_000,
  });
  if (config.exitCode !== 0) {
    const message = config.timedOut ? "Compose discovery timed out" : config.stderr.trim() || "Compose unavailable";
    const lowered = message.toLowerCase();
    const state: UnifiedState = lowered.includes("no configuration file") ? "unknown" : "offline";
    return { state, services: [], error: message };
  }
  const names = [
    ...new Set(
      config.stdout
        .split("\n")
        .map((name) => name.trim())
        .filter(Boolean)
    ),
  ];
  if (names.length === 0) return { state: "ready", services: [], error: null };
  const ps = await runner.run("docker", [...commonArgs, "ps", "--all", "--format", "json"], {
    cwd: projectPath,
    timeoutMs: 8_000,
  });
  if (ps.exitCode !== 0) {
    return {
      state: "offline",
      services: names.map((name) => ({ id: name, name, state: "unknown", detail: "Docker unavailable" })),
      error: ps.timedOut ? "Compose status timed out" : ps.stderr.trim() || "Docker daemon unavailable",
    };
  }
  const rows = parseComposeRows(ps.stdout);
  const services = names.map((name) => {
    const row = rows.find((candidate) => String(candidate.Service ?? candidate.Name ?? "") === name);
    return { id: name, name, ...composeServiceState(row) };
  });
  const state: UnifiedState = services.some((service) => service.state === "failed")
    ? "failed"
    : services.some((service) => service.state === "starting")
      ? "starting"
      : services.every((service) => service.state === "ready")
        ? "ready"
        : "offline";
  return { state, services, error: null };
}

const PACKAGE_MARKERS: ReadonlyArray<readonly [PackageManager, readonly string[]]> = [
  ["pnpm", ["pnpm-lock.yaml", "pnpm-workspace.yaml"]],
  ["yarn", ["yarn.lock"]],
  ["bun", ["bun.lock", "bun.lockb"]],
  ["npm", ["package-lock.json", "npm-shrinkwrap.json", "package.json"]],
  ["cargo", ["Cargo.lock", "Cargo.toml"]],
  ["uv", ["uv.lock"]],
  ["poetry", ["poetry.lock"]],
  ["gradle", ["gradlew", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"]],
  ["maven", ["mvnw", "pom.xml"]],
  ["go", ["go.work", "go.mod"]],
  ["just", ["justfile", "Justfile"]],
  ["make", ["Makefile", "makefile"]],
];

export async function detectPackageManager(
  projectPath: string,
  explicit: PackageManager = "unknown"
): Promise<PackageManager> {
  if (explicit !== "unknown") return explicit;
  for (const [manager, markers] of PACKAGE_MARKERS) {
    for (const marker of markers) {
      try {
        await access(join(projectPath, marker));
        return manager;
      } catch {
        // Try the next marker without scanning the repository.
      }
    }
  }
  return "unknown";
}

export function recommendedActionsFromManifest(
  manifest: ProjectManifest,
  now = new Date().toISOString()
): RecommendedAction[] {
  return Object.entries(manifest.commands)
    .map(([key, command], index): RecommendedAction => {
      const rejectedEnvironmentRef = command.environmentRefs.find(
        (reference) => !(manifest.secretRefs ?? []).includes(reference)
      );
      const disabledReason = rejectedEnvironmentRef
        ? `Environment references are not approved: ${rejectedEnvironmentRef}`
        : command.requiresCapabilities.length > 0
          ? `Requires capabilities: ${command.requiresCapabilities.join(", ")}`
          : null;
      return {
        schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
        id: `action:${manifest.id}:${key}`,
        createdAt: now,
        updatedAt: now,
        origin: { source: "workbench", instanceId: null, legacyRef: command.id },
        capabilities: command.requiresCapabilities,
        projectId: manifest.id,
        label: command.name,
        description: command.description,
        category: command.category,
        state: disabledReason ? "waiting" : "ready",
        workflowId: command.id,
        deepLink: null,
        disabledReason,
        priority: index,
        mutation: command.mutation,
        approvalRequired: command.mutation !== "read_only",
      };
    })
    .sort((left, right) => left.priority - right.priority || left.label.localeCompare(right.label));
}

type Store = ReturnType<typeof createStore>;

function unifiedRunState(status: string): UnifiedState {
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (status === "blocked") return "blocked";
  if (status === "awaiting_approval") return "waiting";
  if (["approved", "applied", "completed"].includes(status)) return "completed";
  if (status === "queued") return "starting";
  return "running";
}

function buildActiveWork(store: Store, projectId: string, branch: string | null, now: string): ActiveWork | null {
  const sessions = store
    .listSessions(100)
    .filter((session) => session.projectId === projectId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const activeSession = sessions.find((session) => ["queued", "running", "paused"].includes(session.status));
  const runs = store.dev.listRuns({ projectId, limit: 20 });
  const activeRun = runs.find(
    (run) => !["approved", "applied", "completed", "failed", "cancelled"].includes(run.status)
  );
  const latestRun =
    activeRun ?? (activeSession ? runs.find((run) => run.sessionId === activeSession.id) : runs[0]) ?? null;
  const workflowExecutions = store.workflows.list(projectId, 20);
  const workflowRecord =
    workflowExecutions.find((record) => !["completed", "failed", "cancelled"].includes(record.execution.state)) ??
    workflowExecutions.find(
      (record) =>
        ["failed", "blocked", "cancelled"].includes(record.execution.state) &&
        record.execution.recoveryWorkflowIds.length > 0
    ) ??
    null;
  const session = activeSession ?? (latestRun ? store.getSession(latestRun.sessionId) : null);
  const task = session?.activeTaskId
    ? store.getTask(session.activeTaskId)
    : session
      ? store.getCurrentTask(session.id)
      : null;
  if (!session && !latestRun && !task && !workflowRecord) return null;
  const tasks = session ? store.listTasks(session.id, 100) : [];
  const runApproval = latestRun
    ? (store.execution.listApprovals(latestRun.id).find((candidate) => candidate.status === "pending") ?? null)
    : null;
  const workflowApproval = workflowRecord ? store.workflows.getApprovalForExecution(workflowRecord.execution.id) : null;
  const workflowIsPrimary =
    workflowRecord !== null &&
    (!latestRun || workflowRecord.execution.updatedAt.localeCompare(latestRun.updatedAt) >= 0) &&
    (!session || workflowRecord.execution.updatedAt.localeCompare(session.updatedAt) >= 0);
  const approval = workflowApproval?.status === "pending" ? workflowApproval : runApproval;
  const completed = tasks.filter((candidate) => candidate.status === "completed").length;
  const blocker =
    workflowIsPrimary && ["failed", "blocked"].includes(workflowRecord.execution.state)
      ? {
          code: workflowRecord.execution.errorCode ?? "workflow_blocked",
          summary:
            workflowRecord.execution.errorSummary ?? `Workflow ${workflowRecord.execution.workflowId} is blocked`,
        }
      : task?.status === "blocked"
        ? { code: "task_blocked", summary: task.title }
        : latestRun?.status === "blocked"
          ? { code: "run_blocked", summary: latestRun.errorMessage ?? "Development run is blocked" }
          : null;
  const state = blocker
    ? "blocked"
    : workflowIsPrimary
      ? workflowRecord.execution.state
      : latestRun
        ? unifiedRunState(latestRun.status)
        : task?.status === "failed"
          ? "failed"
          : session?.status === "paused"
            ? "waiting"
            : session?.status === "completed"
              ? "completed"
              : "running";
  return {
    schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
    id: `active-work:${projectId}`,
    createdAt: session?.createdAt ?? latestRun?.createdAt ?? workflowRecord?.execution.createdAt ?? now,
    updatedAt:
      [session?.updatedAt, latestRun?.updatedAt, workflowRecord?.execution.updatedAt]
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? now,
    origin: { source: "workbench", instanceId: null, legacyRef: null },
    capabilities: [
      "resume",
      "project-scoped",
      ...(workflowRecord ? ["workflow-review"] : []),
      ...(workflowRecord?.execution.recoveryWorkflowIds.length ? ["workflow-recovery"] : []),
    ],
    projectId,
    state,
    goalId: null,
    goal: latestRun?.goal ?? session?.userGoal ?? null,
    planId: null,
    taskId: task?.id ?? null,
    taskTitle: task?.title ?? workflowRecord?.execution.workflowId ?? null,
    taskProgress: tasks.length > 0 ? { completed, total: tasks.length } : null,
    runId: latestRun?.id ?? null,
    workflowExecutionId: workflowRecord?.execution.id ?? null,
    workflowId: workflowRecord?.execution.workflowId ?? null,
    recoveryWorkflowIds: workflowRecord?.execution.recoveryWorkflowIds ?? [],
    sessionId: session?.id ?? latestRun?.sessionId ?? workflowRecord?.execution.sessionId ?? null,
    approvalId: approval?.id ?? null,
    blocker,
    branch: latestRun?.workspace?.branch ?? branch,
    files: latestRun ? [...new Set([...latestRun.filesEdited, ...latestRun.filesCreated])] : [],
    modelRole: session?.modelProfile ?? null,
    recommendedActionIds: workflowRecord?.execution.recoveryWorkflowIds ?? [],
    resumable:
      ["starting", "loading", "ready", "waiting", "blocked", "running"].includes(state) ||
      (workflowRecord?.execution.recoveryWorkflowIds.length ?? 0) > 0,
  };
}

function apiRuntimeHealth(now: string): RuntimeHealth {
  return {
    schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
    id: "runtime:workbench",
    createdAt: now,
    updatedAt: now,
    origin: { source: "workbench", instanceId: null, legacyRef: null },
    capabilities: ["api", "status"],
    state: "ready",
    ready: true,
    checkedAt: now,
    components: [
      {
        id: "workbench-api",
        name: "Workbench API",
        state: "ready",
        processAlive: true,
        ready: true,
        latencyMs: null,
        detail: "Status API is accepting requests",
        checkedAt: now,
        endpoint: null,
        capabilities: ["registry", "context", "status"],
      },
    ],
    blockers: [],
  };
}

function latestChecks(store: Store, projectId: string) {
  const byName = new Map<string, ReturnType<Store["listCheckRuns"]>[number]>();
  for (const check of store.listCheckRuns(100, projectId)) {
    if (!byName.has(check.name)) byName.set(check.name, check);
  }
  return [...byName.values()];
}

export interface BuildProjectStatusOptions {
  projectId?: string | null;
  runner?: CommandRunner;
  now?: string;
  staleAfterMs?: number;
}

export const DEFAULT_STATUS_STALE_AFTER_MS = 5 * 60 * 1_000;

export async function buildProjectStatus(
  store: Store,
  options: BuildProjectStatusOptions = {}
): Promise<ProjectStatus> {
  const now = options.now ?? new Date().toISOString();
  const context = store.activeContext.getContext();
  const selection = store.projectRegistry.getSelection();
  const projectId = options.projectId ?? selection?.projectId ?? context?.project?.id ?? null;
  const project = projectId ? store.getProject(projectId) : null;
  const manifest = projectId ? store.projectRegistry.getManifest(projectId) : null;
  const projectPath = manifest?.path ?? project?.path ?? null;
  const composeProfiles = [...new Set(manifest?.services.flatMap((service) => service.composeProfiles) ?? [])];
  const [git, compose] = projectPath
    ? await Promise.all([
        collectGitStatus(projectPath, options.runner),
        collectComposeStatus(projectPath, options.runner, [], composeProfiles),
      ])
    : [null, null];
  const checks = projectId ? latestChecks(store, projectId) : [];
  const checkSummary = {
    passed: checks.filter((check) => check.status === "completed" && (check.exitCode ?? 0) === 0).length,
    failed: checks.filter((check) => check.status === "failed" || (check.exitCode !== null && check.exitCode !== 0))
      .length,
    running: checks.filter((check) => check.status === "queued" || check.status === "running").length,
  };
  const checkState: UnifiedState =
    checkSummary.failed > 0
      ? "failed"
      : checkSummary.running > 0
        ? "running"
        : checks.length > 0
          ? "completed"
          : "unknown";
  const indexAge = project?.lastIndexedAt
    ? Date.parse(now) - Date.parse(project.lastIndexedAt)
    : Number.POSITIVE_INFINITY;
  const indexStale = !project?.lastIndexedAt || indexAge > 24 * 60 * 60 * 1_000;
  const activeWork = projectId ? buildActiveWork(store, projectId, git?.status?.branch ?? null, now) : null;
  const blockers: Array<{ code: string; summary: string }> = [];
  if (!projectId) blockers.push({ code: "project_required", summary: "Select a project to view work status" });
  if (checkSummary.failed > 0)
    blockers.push({ code: "checks_failed", summary: `${checkSummary.failed} check(s) failed` });
  if (activeWork?.blocker) blockers.push(activeWork.blocker);
  const state: UnifiedState = blockers.some((blocker) => blocker.code !== "project_required")
    ? "blocked"
    : activeWork && ["running", "waiting", "starting"].includes(activeWork.state)
      ? activeWork.state
      : projectId
        ? "ready"
        : "unknown";
  const generated = new Date(now);
  const staleAfter = new Date(
    generated.getTime() + (options.staleAfterMs ?? DEFAULT_STATUS_STALE_AFTER_MS)
  ).toISOString();
  return {
    schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
    id: projectId ? `project-status:${projectId}` : "project-status:unresolved",
    createdAt: now,
    updatedAt: now,
    origin: { source: "workbench", instanceId: null, legacyRef: null },
    capabilities: ["git", "compose", "checks", "active-work", "desktop-cache"],
    project: project ? { id: project.id, name: project.name, path: project.path } : null,
    state,
    context,
    git: git?.status ?? null,
    services: compose?.services ?? [],
    checks: { state: checkState, ...checkSummary },
    index: {
      state: project?.status === "indexing" ? "running" : indexStale ? "stale" : "ready",
      lastIndexedAt: project?.lastIndexedAt ?? null,
      stale: indexStale,
      progress: project?.status === "indexing" ? 0 : null,
    },
    activeWork,
    runtime: apiRuntimeHealth(now),
    blockers,
    recommendedActions: manifest ? recommendedActionsFromManifest(manifest, now) : [],
    generatedAt: now,
    staleAfter,
    workbenchAvailable: true,
  };
}

export interface CompactProjectStatus {
  schemaVersion: 1;
  generatedAt: string;
  staleAfter: string;
  state: UnifiedState;
  project: { id: string; name: string; pinned: boolean; confidence: number } | null;
  git: { branch: string | null; dirty: number; staged: number; conflicts: number; state: UnifiedState };
  work: { label: string; state: UnifiedState; progress: string | null };
  ai: { label: string; state: UnifiedState };
  warnings: string[];
  tooltip: string;
}

export function compactProjectStatus(status: ProjectStatus): CompactProjectStatus {
  const dirty = status.git ? status.git.modified + status.git.deleted + status.git.renamed + status.git.untracked : 0;
  const warnings = [
    ...status.blockers.map((blocker) => blocker.summary),
    ...(status.index.stale ? ["Project index is stale"] : []),
    ...(status.context?.confirmationRecommended ? ["Project context needs confirmation"] : []),
    ...(status.activeWork?.approvalId ? ["Approval is pending"] : []),
  ];
  const progress = status.activeWork?.taskProgress
    ? `${status.activeWork.taskProgress.completed}/${status.activeWork.taskProgress.total}`
    : null;
  const modelRuntime = status.runtime?.components.find(
    (component) => component.capabilities.includes("models") || component.id.includes("model")
  );
  const projectName = status.project?.name ?? "No project";
  const branch = status.git?.branch ?? "no branch";
  const tooltip = [
    projectName,
    `Git: ${branch}${status.git?.dirty ? `, ${dirty} changed, ${status.git.staged} staged` : ", clean"}`,
    status.activeWork?.taskTitle ? `Work: ${status.activeWork.taskTitle}` : "Work: no active task",
    `Checks: ${status.checks.failed} failed, ${status.checks.running} running`,
    ...warnings,
  ].join("\n");
  return {
    schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
    generatedAt: status.generatedAt,
    staleAfter: status.staleAfter,
    state: status.state,
    project: status.project
      ? {
          id: status.project.id,
          name: status.project.name,
          pinned: status.context?.pinned ?? false,
          confidence: status.context?.confidence ?? 0,
        }
      : null,
    git: {
      branch: status.git?.branch ?? null,
      dirty,
      staged: status.git?.staged ?? 0,
      conflicts: status.git?.conflicts ?? 0,
      state: status.git ? (status.git.conflicts > 0 ? "failed" : "ready") : "unknown",
    },
    work: {
      label: status.activeWork?.approvalId
        ? `Approval: ${status.activeWork.taskTitle ?? "development run"}`
        : (status.activeWork?.taskTitle ?? "No active task"),
      state: status.activeWork?.state ?? "unknown",
      progress,
    },
    ai: {
      label: status.activeWork?.modelRole ?? "AI",
      state: modelRuntime?.state ?? "unknown",
    },
    warnings,
    tooltip,
  };
}

export interface ProjectStatusCache {
  schemaVersion: 1;
  generatedAt: string;
  status: ProjectStatus;
  compact: CompactProjectStatus;
}

export function defaultProjectStatusCachePath(): string {
  return join(dirname(defaultRegistryCachePath()), "project-status-v1.json");
}

export async function writeProjectStatusCache(
  status: ProjectStatus,
  path = defaultProjectStatusCachePath()
): Promise<ProjectStatusCache> {
  const cache = {
    schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
    generatedAt: status.generatedAt,
    status,
    compact: compactProjectStatus(status),
  } satisfies ProjectStatusCache;
  await atomicWriteJson(path, cache);
  return cache;
}

export async function readProjectStatusCache(
  path = defaultProjectStatusCachePath()
): Promise<ProjectStatusCache | null> {
  try {
    const cache = JSON.parse(await readFile(path, "utf8")) as ProjectStatusCache;
    return cache.schemaVersion === CONTROL_PLANE_SCHEMA_VERSION && cache.status && cache.compact ? cache : null;
  } catch {
    return null;
  }
}
