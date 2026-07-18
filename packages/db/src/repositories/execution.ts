import type { DatabaseSync } from "node:sqlite";
import type { ApprovalStatus, WorkspaceStrategy } from "../../../shared/src/index.ts";
import { asBool, asNumber, asString, asStringOrNull, newId, now, safeParseJson } from "./_shared.ts";

interface WorkspaceRow {
  id: string;
  run_id: string;
  project_id: string;
  strategy: string;
  path: string;
  branch: string | null;
  is_git_worktree: number;
  base_commit: string | null;
  original_root: string;
  cleaned_up: number;
  created_at: string;
  updated_at: string;
}

interface CommandRow {
  id: string;
  run_id: string;
  project_id: string;
  workspace_id: string | null;
  name: string;
  command: string;
  cwd: string;
  status: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
  parsed_errors_json: string;
  affected_files_json: string;
  started_at: string | null;
  finished_at: string | null;
  blocked_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface ApprovalRow {
  id: string;
  run_id: string;
  project_id: string;
  requested_at: string;
  status: string;
  policy: string;
  risk: string;
  requires_explicit: number;
  reason: string | null;
  decided_at: string | null;
  decided_by: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface PatchRow {
  id: string;
  run_id: string;
  project_id: string;
  format: string;
  path: string;
  diff_text: string;
  metadata_json: string;
  applied: number;
  applied_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExecutionWorkspaceRecord {
  id: string;
  runId: string;
  projectId: string;
  strategy: WorkspaceStrategy;
  path: string;
  branch: string | null;
  isGitWorktree: boolean;
  baseCommit: string | null;
  originalRoot: string;
  cleanedUp: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionCommandRecord {
  id: string;
  runId: string;
  projectId: string;
  workspaceId: string | null;
  name: string;
  command: string;
  cwd: string;
  status: "queued" | "running" | "completed" | "failed" | "blocked";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  parsedErrors: string[];
  affectedFiles: string[];
  startedAt: string | null;
  finishedAt: string | null;
  blockedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionApprovalRecord {
  id: string;
  runId: string;
  projectId: string;
  requestedAt: string;
  status: ApprovalStatus;
  policy: string;
  risk: string;
  requiresExplicit: boolean;
  reason: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PatchRecord {
  id: string;
  runId: string;
  projectId: string;
  format: string;
  path: string;
  diffText: string;
  metadata: Record<string, unknown>;
  applied: boolean;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowToWorkspace(row: WorkspaceRow): ExecutionWorkspaceRecord {
  return {
    id: asString(row.id),
    runId: asString(row.run_id),
    projectId: asString(row.project_id),
    strategy: asString(row.strategy) as WorkspaceStrategy,
    path: asString(row.path),
    branch: asStringOrNull(row.branch),
    isGitWorktree: asBool(row.is_git_worktree),
    baseCommit: asStringOrNull(row.base_commit),
    originalRoot: asString(row.original_root),
    cleanedUp: asBool(row.cleaned_up),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function rowToCommand(row: CommandRow): ExecutionCommandRecord {
  return {
    id: asString(row.id),
    runId: asString(row.run_id),
    projectId: asString(row.project_id),
    workspaceId: asStringOrNull(row.workspace_id),
    name: asString(row.name),
    command: asString(row.command),
    cwd: asString(row.cwd),
    status: asString(row.status) as ExecutionCommandRecord["status"],
    exitCode: row.exit_code == null ? null : asNumber(row.exit_code),
    stdout: asString(row.stdout),
    stderr: asString(row.stderr),
    durationMs: asNumber(row.duration_ms),
    parsedErrors: safeParseJson(asString(row.parsed_errors_json ?? "[]")) as string[],
    affectedFiles: safeParseJson(asString(row.affected_files_json ?? "[]")) as string[],
    startedAt: asStringOrNull(row.started_at),
    finishedAt: asStringOrNull(row.finished_at),
    blockedReason: asStringOrNull(row.blocked_reason),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function rowToApproval(row: ApprovalRow): ExecutionApprovalRecord {
  return {
    id: asString(row.id),
    runId: asString(row.run_id),
    projectId: asString(row.project_id),
    requestedAt: asString(row.requested_at),
    status: asString(row.status) as ApprovalStatus,
    policy: asString(row.policy),
    risk: asString(row.risk),
    requiresExplicit: asBool(row.requires_explicit),
    reason: asStringOrNull(row.reason),
    decidedAt: asStringOrNull(row.decided_at),
    decidedBy: asStringOrNull(row.decided_by),
    notes: asStringOrNull(row.notes),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function rowToPatch(row: PatchRow): PatchRecord {
  return {
    id: asString(row.id),
    runId: asString(row.run_id),
    projectId: asString(row.project_id),
    format: asString(row.format),
    path: asString(row.path),
    diffText: asString(row.diff_text),
    metadata: safeParseJson(asString(row.metadata_json)),
    applied: asBool(row.applied),
    appliedAt: asStringOrNull(row.applied_at),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

export function createExecutionRepo(db: DatabaseSync) {
  return {
    createWorkspace(input: {
      runId: string;
      projectId: string;
      strategy: WorkspaceStrategy;
      path: string;
      branch?: string | null;
      isGitWorktree: boolean;
      baseCommit?: string | null;
      originalRoot: string;
    }): ExecutionWorkspaceRecord {
      const id = newId("ws");
      const ts = now();
      db.prepare(
        `INSERT INTO execution_workspaces (
          id, run_id, project_id, strategy, path, branch, is_git_worktree, base_commit,
          original_root, cleaned_up, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        input.runId,
        input.projectId,
        input.strategy,
        input.path,
        input.branch ?? null,
        input.isGitWorktree ? 1 : 0,
        input.baseCommit ?? null,
        input.originalRoot,
        0,
        ts,
        ts
      );
      return {
        id,
        runId: input.runId,
        projectId: input.projectId,
        strategy: input.strategy,
        path: input.path,
        branch: input.branch ?? null,
        isGitWorktree: input.isGitWorktree,
        baseCommit: input.baseCommit ?? null,
        originalRoot: input.originalRoot,
        cleanedUp: false,
        createdAt: ts,
        updatedAt: ts,
      };
    },
    markWorkspaceCleaned(workspaceId: string): void {
      db.prepare("UPDATE execution_workspaces SET cleaned_up = 1, updated_at = ? WHERE id = ?").run(now(), workspaceId);
    },
    getWorkspace(workspaceId: string): ExecutionWorkspaceRecord | null {
      const row = db.prepare("SELECT * FROM execution_workspaces WHERE id = ? LIMIT 1").get(workspaceId) as
        | WorkspaceRow
        | undefined;
      return row ? rowToWorkspace(row) : null;
    },
    getWorkspaceForRun(runId: string): ExecutionWorkspaceRecord | null {
      const row = db
        .prepare("SELECT * FROM execution_workspaces WHERE run_id = ? ORDER BY created_at DESC LIMIT 1")
        .get(runId) as WorkspaceRow | undefined;
      return row ? rowToWorkspace(row) : null;
    },
    recordCommand(input: {
      runId: string;
      projectId: string;
      workspaceId?: string | null;
      name: string;
      command: string;
      cwd: string;
    }): ExecutionCommandRecord {
      const id = newId("cmd");
      const ts = now();
      db.prepare(
        `INSERT INTO execution_commands (
          id, run_id, project_id, workspace_id, name, command, cwd, status,
          stdout, stderr, duration_ms, parsed_errors_json, affected_files_json, started_at, finished_at, blocked_reason,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        input.runId,
        input.projectId,
        input.workspaceId ?? null,
        input.name,
        input.command,
        input.cwd,
        "queued",
        "",
        "",
        0,
        "[]",
        "[]",
        null,
        null,
        null,
        ts,
        ts
      );
      return {
        id,
        runId: input.runId,
        projectId: input.projectId,
        workspaceId: input.workspaceId ?? null,
        name: input.name,
        command: input.command,
        cwd: input.cwd,
        status: "queued",
        exitCode: null,
        stdout: "",
        stderr: "",
        durationMs: 0,
        parsedErrors: [],
        affectedFiles: [],
        startedAt: null,
        finishedAt: null,
        blockedReason: null,
        createdAt: ts,
        updatedAt: ts,
      };
    },
    completeCommand(input: {
      id: string;
      status: ExecutionCommandRecord["status"];
      exitCode: number | null;
      stdout: string;
      stderr: string;
      durationMs: number;
      parsedErrors?: string[];
      affectedFiles?: string[];
      startedAt: string;
      finishedAt: string;
      blockedReason?: string | null;
    }): ExecutionCommandRecord {
      const ts = now();
      db.prepare(
        `UPDATE execution_commands
           SET status = ?, exit_code = ?, stdout = ?, stderr = ?, duration_ms = ?,
               parsed_errors_json = ?, affected_files_json = ?,
               started_at = ?, finished_at = ?, blocked_reason = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        input.status,
        input.exitCode,
        input.stdout,
        input.stderr,
        input.durationMs,
        JSON.stringify(input.parsedErrors ?? []),
        JSON.stringify(input.affectedFiles ?? []),
        input.startedAt,
        input.finishedAt,
        input.blockedReason ?? null,
        ts,
        input.id
      );
      const row = db.prepare("SELECT * FROM execution_commands WHERE id = ?").get(input.id) as CommandRow;
      return rowToCommand(row);
    },
    listCommands(runId: string): ExecutionCommandRecord[] {
      const rows = db
        .prepare("SELECT * FROM execution_commands WHERE run_id = ? ORDER BY created_at ASC")
        .all(runId) as CommandRow[];
      return rows.map(rowToCommand);
    },
    requestApproval(input: {
      runId: string;
      projectId: string;
      policy: string;
      risk: string;
      requiresExplicit: boolean;
      reason: string;
    }): ExecutionApprovalRecord {
      const id = newId("appr");
      const ts = now();
      db.prepare(
        `INSERT INTO execution_approvals (
          id, run_id, project_id, requested_at, status, policy, risk, requires_explicit,
          reason, decided_at, decided_by, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        input.runId,
        input.projectId,
        ts,
        "pending",
        input.policy,
        input.risk,
        input.requiresExplicit ? 1 : 0,
        input.reason,
        null,
        null,
        null,
        ts,
        ts
      );
      return {
        id,
        runId: input.runId,
        projectId: input.projectId,
        requestedAt: ts,
        status: "pending",
        policy: input.policy,
        risk: input.risk,
        requiresExplicit: input.requiresExplicit,
        reason: input.reason,
        decidedAt: null,
        decidedBy: null,
        notes: null,
        createdAt: ts,
        updatedAt: ts,
      };
    },
    decideApproval(input: {
      id: string;
      status: ApprovalStatus;
      decidedBy?: string | null;
      notes?: string | null;
    }): ExecutionApprovalRecord {
      const ts = now();
      db.prepare(
        `UPDATE execution_approvals
           SET status = ?, decided_at = ?, decided_by = ?, notes = ?, updated_at = ?
         WHERE id = ?`
      ).run(input.status, ts, input.decidedBy ?? null, input.notes ?? null, ts, input.id);
      const row = db.prepare("SELECT * FROM execution_approvals WHERE id = ?").get(input.id) as ApprovalRow;
      return rowToApproval(row);
    },
    listApprovals(runId: string): ExecutionApprovalRecord[] {
      const rows = db
        .prepare("SELECT * FROM execution_approvals WHERE run_id = ? ORDER BY created_at ASC")
        .all(runId) as ApprovalRow[];
      return rows.map(rowToApproval);
    },
    getApproval(approvalId: string): ExecutionApprovalRecord | null {
      const row = db.prepare("SELECT * FROM execution_approvals WHERE id = ? LIMIT 1").get(approvalId) as
        | ApprovalRow
        | undefined;
      return row ? rowToApproval(row) : null;
    },
    recordPatch(input: {
      runId: string;
      projectId: string;
      path: string;
      diffText: string;
      metadata?: Record<string, unknown>;
    }): PatchRecord {
      const id = newId("patch");
      const ts = now();
      const metadata = input.metadata ?? {};
      db.prepare(
        `INSERT INTO patches (
          id, run_id, project_id, format, path, diff_text, metadata_json, applied, applied_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        input.runId,
        input.projectId,
        "unified",
        input.path,
        input.diffText,
        JSON.stringify(metadata),
        0,
        null,
        ts,
        ts
      );
      return {
        id,
        runId: input.runId,
        projectId: input.projectId,
        format: "unified",
        path: input.path,
        diffText: input.diffText,
        metadata,
        applied: false,
        appliedAt: null,
        createdAt: ts,
        updatedAt: ts,
      };
    },
    markPatchApplied(patchId: string): PatchRecord {
      const ts = now();
      db.prepare("UPDATE patches SET applied = 1, applied_at = ?, updated_at = ? WHERE id = ?").run(ts, ts, patchId);
      const row = db.prepare("SELECT * FROM patches WHERE id = ?").get(patchId) as PatchRow;
      return rowToPatch(row);
    },
    listPatches(runId: string): PatchRecord[] {
      const rows = db
        .prepare("SELECT * FROM patches WHERE run_id = ? ORDER BY created_at ASC")
        .all(runId) as PatchRow[];
      return rows.map(rowToPatch);
    },
  };
}

export type ExecutionRepo = ReturnType<typeof createExecutionRepo>;
