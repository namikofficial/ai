// Typed schemas and runtime validators for the local agentic dev pipeline.
//
// Mirrors the project convention: a `parse*` function performs runtime
// validation and returns a strongly typed value, matching the existing
// `parseAskRequest` / `parseProjectCreateInput` helpers in
// `packages/shared/src/index.ts`.

import type {
  ApprovalPolicy,
  ApprovalStatus,
  DevCheckResult,
  DevEdit,
  DevMode,
  DevPlan,
  DevRequest,
  DevResult,
  DevRun,
  DevRunStatus,
  EditChangeType,
  ExecutionEvent,
  ExecutionEventKind,
  RiskLevel,
  WorkspaceStrategy,
} from "../../shared/src/index.ts";

export type {
  ApprovalPolicy,
  ApprovalStatus,
  DevCheckResult,
  DevEdit,
  DevMode,
  DevPlan,
  DevRequest,
  DevResult,
  DevRun,
  DevRunStatus,
  EditChangeType,
  ExecutionEvent,
  ExecutionEventKind,
  RiskLevel,
  WorkspaceStrategy,
};

const DEV_MODES: ReadonlyArray<DevMode> = ["local", "cloud", "hybrid"];
const APPROVAL_POLICIES: ReadonlyArray<ApprovalPolicy> = ["auto", "manual", "high_risk_only"];
const RISK_LEVELS: ReadonlyArray<RiskLevel> = ["low", "medium", "high"];
const EDIT_CHANGE_TYPES: ReadonlyArray<EditChangeType> = ["replace", "create", "append"];
const DEV_RUN_STATUSES: ReadonlyArray<DevRunStatus> = [
  "queued",
  "planning",
  "editing",
  "checking",
  "repairing",
  "awaiting_approval",
  "approved",
  "applied",
  "completed",
  "failed",
  "cancelled",
  "blocked",
];
const WORKSPACE_STRATEGIES: ReadonlyArray<WorkspaceStrategy> = ["git_worktree", "safe_copy"];
const EXECUTION_EVENT_KINDS: ReadonlyArray<ExecutionEventKind> = [
  "run.queued",
  "run.started",
  "plan.ready",
  "workspace.ready",
  "edit.proposed",
  "edit.applied",
  "edit.rejected",
  "check.started",
  "check.completed",
  "check.failed",
  "repair.attempted",
  "approval.required",
  "approval.granted",
  "approval.rejected",
  "patch.applied",
  "run.completed",
  "run.failed",
  "run.cancelled",
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function optionalString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") throw new TypeError("value must be a string");
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function oneOf<T extends string>(value: unknown, allowed: ReadonlyArray<T>, name: string): T {
  if (typeof value !== "string" || !(allowed as ReadonlyArray<string>).includes(value)) {
    throw new TypeError(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

export function parseDevRequest(value: unknown): DevRequest {
  if (!isObject(value)) throw new TypeError("dev request must be an object");
  return {
    project: requiredString(value.project, "project"),
    goal: requiredString(value.goal, "goal"),
    mode: value.mode == null ? "local" : oneOf(value.mode, DEV_MODES, "mode"),
    approvalPolicy:
      value.approvalPolicy == null
        ? "manual"
        : oneOf(value.approvalPolicy, APPROVAL_POLICIES, "approvalPolicy"),
    approveEdits: value.approveEdits === true,
    checks: Array.isArray(value.checks) ? (value.checks.filter((item) => typeof item === "string") as string[]) : undefined,
    maxRepairs: typeof value.maxRepairs === "number" && Number.isFinite(value.maxRepairs) ? Math.max(0, Math.floor(value.maxRepairs)) : undefined,
    editorProfileId: optionalString(value.editorProfileId),
    repairProfileId: optionalString(value.repairProfileId),
    plannerProfileId: optionalString(value.plannerProfileId),
  };
}

export function parseDevEdit(value: unknown): DevEdit {
  if (!isObject(value)) throw new TypeError("dev edit must be an object");
  const path = requiredString(value.path, "path");
  const reason = requiredString(value.reason, "reason");
  const newText = typeof value.newText === "string" ? value.newText : "";
  const changeType = value.changeType == null
    ? (newText.length > 0 && (typeof value.oldText !== "string" || value.oldText.length === 0) ? "create" : "replace")
    : oneOf(value.changeType, EDIT_CHANGE_TYPES, "changeType");
  const edit: DevEdit = {
    path,
    reason,
    newText,
    changeType,
  };
  if (typeof value.oldText === "string") {
    edit.oldText = value.oldText;
  }
  return edit;
}

export function parseDevPlan(value: unknown): DevPlan {
  if (!isObject(value)) throw new TypeError("dev plan must be an object");
  const summary = typeof value.summary === "string" ? value.summary : "";
  const edits = Array.isArray(value.edits) ? value.edits.map(parseDevEdit) : [];
  const checks = Array.isArray(value.checks) ? (value.checks.filter((item) => typeof item === "string") as string[]) : [];
  const risk = value.risk == null ? "low" : oneOf(value.risk, RISK_LEVELS, "risk");
  const plan: DevPlan = { summary, edits, checks, risk };
  if (typeof value.notes === "string") plan.notes = value.notes;
  if (typeof value.missingContextReason === "string") plan.missingContextReason = value.missingContextReason;
  return plan;
}

export function parseDevCheckResult(value: unknown): DevCheckResult {
  if (!isObject(value)) throw new TypeError("dev check result must be an object");
  const name = requiredString(value.name, "name");
  const status =
    value.status == null
      ? "completed"
      : oneOf(
          value.status,
          ["queued", "running", "completed", "failed", "blocked"] as const,
          "status",
        );
  const startedAt = typeof value.startedAt === "string" ? value.startedAt : new Date(0).toISOString();
  const finishedAt = typeof value.finishedAt === "string" ? value.finishedAt : startedAt;
  return {
    name,
    status,
    exitCode: typeof value.exitCode === "number" ? value.exitCode : null,
    stdout: typeof value.stdout === "string" ? value.stdout : "",
    stderr: typeof value.stderr === "string" ? value.stderr : "",
    durationMs: typeof value.durationMs === "number" ? value.durationMs : 0,
    startedAt,
    finishedAt,
  };
}

export function parseDevRunStatus(value: unknown): DevRunStatus {
  return oneOf(value, DEV_RUN_STATUSES, "status");
}

export function parseRiskLevel(value: unknown): RiskLevel {
  return oneOf(value, RISK_LEVELS, "risk");
}

export function parseApprovalPolicy(value: unknown): ApprovalPolicy {
  return oneOf(value, APPROVAL_POLICIES, "approvalPolicy");
}

export function parseWorkspaceStrategy(value: unknown): WorkspaceStrategy {
  return oneOf(value, WORKSPACE_STRATEGIES, "strategy");
}

export function parseExecutionEventKind(value: unknown): ExecutionEventKind {
  return oneOf(value, EXECUTION_EVENT_KINDS, "kind");
}

export function parseDevRun(value: unknown): DevRun {
  if (!isObject(value)) throw new TypeError("dev run must be an object");
  return {
    id: requiredString(value.id, "id"),
    sessionId: requiredString(value.sessionId, "sessionId"),
    projectId: requiredString(value.projectId, "projectId"),
    goal: requiredString(value.goal, "goal"),
    mode: oneOf(value.mode ?? "local", DEV_MODES, "mode"),
    approvalPolicy: oneOf(value.approvalPolicy ?? "manual", APPROVAL_POLICIES, "approvalPolicy"),
    approveEdits: value.approveEdits === true,
    risk: oneOf(value.risk ?? "low", RISK_LEVELS, "risk"),
    status: oneOf(value.status ?? "queued", DEV_RUN_STATUSES, "status"),
    plan: value.plan == null ? null : parseDevPlan(value.plan),
    workspace: parseWorkspace(value.workspace),
    checks: Array.isArray(value.checks)
      ? (value.checks.map(parseDevCheckResult) as DevCheckResult[])
      : [],
    repairAttempts: typeof value.repairAttempts === "number" ? value.repairAttempts : 0,
    maxRepairs: typeof value.maxRepairs === "number" ? value.maxRepairs : 0,
    errorMessage: typeof value.errorMessage === "string" ? value.errorMessage : null,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
    finishedAt: typeof value.finishedAt === "string" ? value.finishedAt : null,
    durationMs: typeof value.durationMs === "number" ? value.durationMs : null,
  };
}

function parseWorkspace(value: unknown): DevRun["workspace"] {
  if (value == null) return null;
  if (!isObject(value)) throw new TypeError("workspace must be an object");
  return {
    id: requiredString(value.id, "workspace.id"),
    strategy: parseWorkspaceStrategy(value.strategy),
    path: requiredString(value.path, "workspace.path"),
    branch: typeof value.branch === "string" ? value.branch : null,
  };
}

export function parseDevResult(value: unknown): DevResult {
  if (!isObject(value)) throw new TypeError("dev result must be an object");
  const status = oneOf(value.status ?? "completed", DEV_RUN_STATUSES, "status");
  const risk = oneOf(value.risk ?? "low", RISK_LEVELS, "risk");
  return {
    runId: requiredString(value.runId, "runId"),
    sessionId: requiredString(value.sessionId, "sessionId"),
    projectId: requiredString(value.projectId, "projectId"),
    status,
    risk,
    goal: requiredString(value.goal, "goal"),
    summary: typeof value.summary === "string" ? value.summary : "",
    filesEdited: isStringArray(value.filesEdited) ? value.filesEdited : [],
    filesCreated: isStringArray(value.filesCreated) ? value.filesCreated : [],
    checks: Array.isArray(value.checks) ? (value.checks.map(parseDevCheckResult) as DevCheckResult[]) : [],
    diffSummary: typeof value.diffSummary === "string" ? value.diffSummary : "",
    diff: typeof value.diff === "string" ? value.diff : "",
    applied: value.applied === true,
    missingContextReason: typeof value.missingContextReason === "string" ? value.missingContextReason : null,
    errorMessage: typeof value.errorMessage === "string" ? value.errorMessage : null,
    workspacePath: typeof value.workspacePath === "string" ? value.workspacePath : null,
    repairAttempts: typeof value.repairAttempts === "number" ? value.repairAttempts : 0,
    nextCommand: typeof value.nextCommand === "string" ? value.nextCommand : "",
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    finishedAt: typeof value.finishedAt === "string" ? value.finishedAt : null,
  };
}

export function parseExecutionEvent(value: unknown): ExecutionEvent {
  if (!isObject(value)) throw new TypeError("execution event must be an object");
  return {
    id: requiredString(value.id, "id"),
    runId: requiredString(value.runId, "runId"),
    sessionId: requiredString(value.sessionId, "sessionId"),
    projectId: requiredString(value.projectId, "projectId"),
    kind: parseExecutionEventKind(value.kind),
    level: value.level === "warn" || value.level === "error" || value.level === "debug" ? value.level : "info",
    ts: typeof value.ts === "string" ? value.ts : new Date().toISOString(),
    message: typeof value.message === "string" ? value.message : "",
    data: isObject(value.data) ? value.data : {},
  };
}

export function isExecutionEventKind(value: string): value is ExecutionEventKind {
  return (EXECUTION_EVENT_KINDS as ReadonlyArray<string>).includes(value);
}

export function isRiskLevel(value: string): value is RiskLevel {
  return (RISK_LEVELS as ReadonlyArray<string>).includes(value);
}

export function isApprovalPolicy(value: string): value is ApprovalPolicy {
  return (APPROVAL_POLICIES as ReadonlyArray<string>).includes(value);
}

export function isDevMode(value: string): value is DevMode {
  return (DEV_MODES as ReadonlyArray<string>).includes(value);
}

export function emptyPlan(reason: string): DevPlan {
  return {
    summary: "insufficient context",
    edits: [],
    checks: [],
    risk: "low",
    missingContextReason: reason,
  };
}

export function buildDevEdit(input: {
  path: string;
  reason: string;
  oldText?: string;
  newText: string;
  changeType?: EditChangeType;
}): DevEdit {
  const edit: DevEdit = {
    path: input.path,
    reason: input.reason,
    newText: input.newText,
    changeType: input.changeType ?? (input.oldText ? "replace" : "create"),
  };
  if (input.oldText !== undefined) {
    edit.oldText = input.oldText;
  }
  return edit;
}

export function devRunIsTerminal(status: DevRunStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "applied" ||
    status === "blocked"
  );
}

export function devRunNeedsApproval(status: DevRunStatus): boolean {
  return status === "awaiting_approval";
}

export function ensureString(value: unknown, name: string): string {
  return isString(value) ? value : requiredString(value, name);
}
