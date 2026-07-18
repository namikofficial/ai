import type { DatabaseSync } from "node:sqlite";
import type {
  ApprovalPolicy,
  DevCheckResult,
  DevEdit,
  DevPlan,
  DevRun,
  DevRunStatus,
  EditChangeType,
  RiskLevel,
  WorkspaceStrategy,
} from "../../../shared/src/index.ts";
import {
  asBool,
  asNumber,
  asString,
  asStringOrNull,
  newId,
  now,
  safeParseJson,
  safeParseJsonArray,
} from "./_shared.ts";

interface DevRunRow {
  id: string;
  session_id: string;
  project_id: string;
  goal: string;
  mode: string;
  approval_policy: string;
  approve_edits: number;
  risk: string;
  status: string;
  plan_json: string;
  workspace_id: string | null;
  workspace_strategy: string | null;
  workspace_path: string | null;
  workspace_branch: string | null;
  checks_json: string;
  repair_attempts: number;
  max_repairs: number;
  diff_summary: string;
  diff_text: string;
  summary: string;
  files_edited_json: string;
  files_created_json: string;
  error_message: string | null;
  applied_at: string | null;
  applied_files_json: string;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  duration_ms: number | null;
}

interface DevEditRow {
  id: string;
  run_id: string;
  project_id: string;
  path: string;
  reason: string;
  old_text: string | null;
  new_text: string;
  change_type: string;
  status: string;
  risk: string;
  blocked_reason: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface DevRunCreateInput {
  sessionId: string;
  projectId: string;
  goal: string;
  mode: DevRun["mode"];
  approvalPolicy: ApprovalPolicy;
  approveEdits: boolean;
  maxRepairs: number;
}

export interface DevRunUpdateInput {
  status?: DevRunStatus;
  risk?: RiskLevel;
  plan?: DevPlan | null;
  workspace?: {
    id: string;
    strategy: WorkspaceStrategy;
    path: string;
    branch: string | null;
  } | null;
  checks?: DevCheckResult[];
  repairAttempts?: number;
  diffSummary?: string;
  diffText?: string;
  summary?: string;
  filesEdited?: string[];
  filesCreated?: string[];
  errorMessage?: string | null;
  appliedAt?: string | null;
  appliedFiles?: string[];
  finishedAt?: string | null;
  durationMs?: number | null;
}

export interface DevRunWithEdits extends DevRun {
  edits: DevEdit[];
}

function rowToRun(row: DevRunRow): DevRun {
  const workspace =
    row.workspace_id && row.workspace_path && row.workspace_strategy
      ? {
          id: asString(row.workspace_id),
          strategy: asString(row.workspace_strategy) as WorkspaceStrategy,
          path: asString(row.workspace_path),
          branch: asStringOrNull(row.workspace_branch),
        }
      : null;
  const plan = safeParseJson<DevPlan | null>(row.plan_json);
  const checks = safeParseJsonArray<DevCheckResult>(row.checks_json);
  const filesEdited = safeParseJsonArray<string>(asString(row.files_edited_json ?? "[]"));
  const filesCreated = safeParseJsonArray<string>(asString(row.files_created_json ?? "[]"));
  const appliedFiles = safeParseJsonArray<string>(asString(row.applied_files_json ?? "[]"));
  return {
    id: asString(row.id),
    sessionId: asString(row.session_id),
    projectId: asString(row.project_id),
    goal: asString(row.goal),
    mode: asString(row.mode) as DevRun["mode"],
    approvalPolicy: asString(row.approval_policy) as ApprovalPolicy,
    approveEdits: asBool(row.approve_edits),
    risk: asString(row.risk) as RiskLevel,
    status: asString(row.status) as DevRunStatus,
    plan: plan ?? null,
    workspace,
    checks,
    repairAttempts: asNumber(row.repair_attempts),
    maxRepairs: asNumber(row.max_repairs),
    errorMessage: asStringOrNull(row.error_message),
    summary: asString(row.summary ?? ""),
    diffSummary: asString(row.diff_summary ?? ""),
    diffText: asString(row.diff_text ?? ""),
    filesEdited,
    filesCreated,
    appliedAt: asStringOrNull(row.applied_at),
    appliedFiles,
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    finishedAt: asStringOrNull(row.finished_at),
    durationMs: row.duration_ms == null ? null : asNumber(row.duration_ms),
  };
}

function rowToEdit(row: DevEditRow): DevEdit {
  const edit: DevEdit = {
    path: asString(row.path),
    reason: asString(row.reason),
    newText: asString(row.new_text),
    changeType: asString(row.change_type) as EditChangeType,
  };
  if (row.old_text != null) {
    edit.oldText = asString(row.old_text);
  }
  return edit;
}

function rowToEditRecord(row: DevEditRow): DevEdit & {
  id: string;
  status: string;
  risk: RiskLevel;
  blockedReason: string | null;
  errorMessage: string | null;
} {
  return {
    ...rowToEdit(row),
    id: asString(row.id),
    status: asString(row.status),
    risk: asString(row.risk) as RiskLevel,
    blockedReason: asStringOrNull(row.blocked_reason),
    errorMessage: asStringOrNull(row.error_message),
  };
}

export function createDevRunsRepo(db: DatabaseSync) {
  return {
    createRun(input: DevRunCreateInput): DevRun {
      const id = newId("drun");
      const ts = now();
      db.prepare(
        `INSERT INTO dev_runs (
          id, session_id, project_id, goal, mode, approval_policy, approve_edits, risk, status,
          plan_json, checks_json, repair_attempts, max_repairs,
          diff_summary, diff_text, summary, files_edited_json, files_created_json,
          error_message, applied_at, applied_files_json,
          created_at, updated_at, finished_at, duration_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        input.sessionId,
        input.projectId,
        input.goal,
        input.mode,
        input.approvalPolicy,
        input.approveEdits ? 1 : 0,
        "low",
        "queued",
        "{}",
        "[]",
        0,
        input.maxRepairs,
        "",
        "",
        "",
        "[]",
        "[]",
        null,
        null,
        "[]",
        ts,
        ts,
        null,
        null
      );
      const row = db.prepare("SELECT * FROM dev_runs WHERE id = ?").get(id) as DevRunRow;
      return rowToRun(row);
    },
    updateRun(runId: string, input: DevRunUpdateInput): DevRun {
      const existing = db.prepare("SELECT * FROM dev_runs WHERE id = ? LIMIT 1").get(runId) as DevRunRow | undefined;
      if (!existing) throw new Error(`dev run not found: ${runId}`);
      const current = rowToRun(existing);
      const merged: DevRun = {
        ...current,
        status: input.status ?? current.status,
        risk: input.risk ?? current.risk,
        plan: input.plan !== undefined ? input.plan : current.plan,
        workspace: input.workspace !== undefined ? input.workspace : current.workspace,
        checks: input.checks ?? current.checks,
        repairAttempts: input.repairAttempts ?? current.repairAttempts,
        errorMessage: input.errorMessage !== undefined ? input.errorMessage : current.errorMessage,
        finishedAt: input.finishedAt !== undefined ? input.finishedAt : current.finishedAt,
        durationMs: input.durationMs !== undefined ? input.durationMs : current.durationMs,
      };
      const ts = now();
      const appliedFiles =
        input.appliedFiles !== undefined
          ? JSON.stringify(input.appliedFiles)
          : asString(existing.applied_files_json ?? "[]");
      const appliedAt = input.appliedAt !== undefined ? input.appliedAt : asStringOrNull(existing.applied_at);
      const workspaceId = merged.workspace?.id ?? asStringOrNull(existing.workspace_id) ?? null;
      const workspaceStrategy = merged.workspace?.strategy ?? asStringOrNull(existing.workspace_strategy) ?? null;
      const workspacePath = merged.workspace?.path ?? asStringOrNull(existing.workspace_path) ?? null;
      const workspaceBranch = merged.workspace?.branch ?? asStringOrNull(existing.workspace_branch) ?? null;
      db.prepare(
        `UPDATE dev_runs
           SET plan_json = ?, status = ?, risk = ?,
               workspace_id = ?, workspace_strategy = ?, workspace_path = ?, workspace_branch = ?,
               checks_json = ?, repair_attempts = ?,
               diff_summary = ?, diff_text = ?, summary = ?,
               files_edited_json = ?, files_created_json = ?,
               error_message = ?, applied_at = ?, applied_files_json = ?,
               updated_at = ?, finished_at = ?, duration_ms = ?
         WHERE id = ?`
      ).run(
        JSON.stringify(merged.plan ?? {}),
        merged.status,
        merged.risk,
        workspaceId,
        workspaceStrategy,
        workspacePath,
        workspaceBranch,
        JSON.stringify(merged.checks),
        merged.repairAttempts,
        input.diffSummary ?? asString(existing.diff_summary ?? ""),
        input.diffText ?? asString(existing.diff_text ?? ""),
        input.summary ?? asString(existing.summary ?? ""),
        JSON.stringify(input.filesEdited ?? safeParseJsonArray<string>(asString(existing.files_edited_json ?? "[]"))),
        JSON.stringify(input.filesCreated ?? safeParseJsonArray<string>(asString(existing.files_created_json ?? "[]"))),
        merged.errorMessage,
        appliedAt,
        appliedFiles,
        ts,
        merged.finishedAt,
        merged.durationMs,
        runId
      );
      const row = db.prepare("SELECT * FROM dev_runs WHERE id = ?").get(runId) as DevRunRow;
      return rowToRun(row);
    },
    addEdit(input: {
      runId: string;
      projectId: string;
      edit: DevEdit;
      risk: RiskLevel;
      status?: string;
      blockedReason?: string | null;
      errorMessage?: string | null;
    }): string {
      const id = newId("dedit");
      const ts = now();
      db.prepare(
        `INSERT INTO dev_edits (
          id, run_id, project_id, path, reason, old_text, new_text, change_type, status, risk,
          blocked_reason, error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        input.runId,
        input.projectId,
        input.edit.path,
        input.edit.reason,
        input.edit.oldText ?? null,
        input.edit.newText,
        input.edit.changeType,
        input.status ?? "proposed",
        input.risk,
        input.blockedReason ?? null,
        input.errorMessage ?? null,
        ts,
        ts
      );
      return id;
    },
    listEdits(runId: string): Array<
      DevEdit & {
        id: string;
        status: string;
        risk: RiskLevel;
        blockedReason: string | null;
        errorMessage: string | null;
      }
    > {
      const rows = db
        .prepare("SELECT * FROM dev_edits WHERE run_id = ? ORDER BY created_at ASC")
        .all(runId) as DevEditRow[];
      return rows.map(rowToEditRecord);
    },
    getRun(id: string): DevRun | null {
      const row = db.prepare("SELECT * FROM dev_runs WHERE id = ? LIMIT 1").get(id) as DevRunRow | undefined;
      return row ? rowToRun(row) : null;
    },
    listRuns(input?: { projectId?: string; sessionId?: string; limit?: number }): DevRun[] {
      const limit = input?.limit ?? 50;
      let rows: DevRunRow[];
      if (input?.projectId && input.sessionId) {
        rows = db
          .prepare("SELECT * FROM dev_runs WHERE project_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT ?")
          .all(input.projectId, input.sessionId, limit) as DevRunRow[];
      } else if (input?.projectId) {
        rows = db
          .prepare("SELECT * FROM dev_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?")
          .all(input.projectId, limit) as DevRunRow[];
      } else if (input?.sessionId) {
        rows = db
          .prepare("SELECT * FROM dev_runs WHERE session_id = ? ORDER BY created_at DESC LIMIT ?")
          .all(input.sessionId, limit) as DevRunRow[];
      } else {
        rows = db.prepare("SELECT * FROM dev_runs ORDER BY created_at DESC LIMIT ?").all(limit) as DevRunRow[];
      }
      return rows.map(rowToRun);
    },
    getRunWithEdits(id: string): DevRunWithEdits | null {
      const run = this.getRun(id);
      if (!run) return null;
      return { ...run, edits: this.listEdits(id).map((row) => row as DevEdit) };
    },
  };
}

export type DevRunsRepo = ReturnType<typeof createDevRunsRepo>;
