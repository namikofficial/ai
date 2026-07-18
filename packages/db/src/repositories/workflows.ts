import type { DatabaseSync } from "node:sqlite";
import type { WorkflowExecution } from "../../../contracts/src/index.ts";
import { workflowExecutionSchema } from "../../../contracts/src/index.ts";
import { asNumber, asString, asStringOrNull, newId, now, safeParseJson, safeParseJsonArray } from "./_shared.ts";

interface WorkflowExecutionRow {
  id: string;
  workflow_id: string;
  project_id: string;
  session_id: string | null;
  task_id: string | null;
  run_id: string | null;
  state: string;
  current_step_id: string | null;
  step_states_json: string;
  started_at: string | null;
  finished_at: string | null;
  approval_id: string | null;
  exit_code: number | null;
  artifacts_json: string;
  error_code: string | null;
  error_summary: string | null;
  command_json: string;
  stdout: string;
  stderr: string;
  duration_ms: number;
  origin_json: string;
  capabilities_json: string;
  created_at: string;
  updated_at: string;
}

export interface WorkflowExecutionRecord {
  execution: WorkflowExecution;
  command: { executable: string; arguments: string[]; workingDirectory: string };
  stdout: string;
  stderr: string;
  durationMs: number;
}

export type WorkflowApprovalStatus = "pending" | "approved" | "rejected" | "expired";

interface WorkflowApprovalRow {
  id: string;
  execution_id: string;
  workflow_id: string;
  project_id: string;
  status: string;
  mutation: string;
  context_hash: string;
  branch: string | null;
  base_commit: string | null;
  reason: string;
  requested_at: string;
  expires_at: string;
  decided_at: string | null;
  decided_by: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkflowApprovalRecord {
  id: string;
  executionId: string;
  workflowId: string;
  projectId: string;
  status: WorkflowApprovalStatus;
  mutation: string;
  contextHash: string;
  branch: string | null;
  baseCommit: string | null;
  reason: string;
  requestedAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowToApproval(row: WorkflowApprovalRow): WorkflowApprovalRecord {
  return {
    id: asString(row.id),
    executionId: asString(row.execution_id),
    workflowId: asString(row.workflow_id),
    projectId: asString(row.project_id),
    status: asString(row.status) as WorkflowApprovalStatus,
    mutation: asString(row.mutation),
    contextHash: asString(row.context_hash),
    branch: asStringOrNull(row.branch),
    baseCommit: asStringOrNull(row.base_commit),
    reason: asString(row.reason),
    requestedAt: asString(row.requested_at),
    expiresAt: asString(row.expires_at),
    decidedAt: asStringOrNull(row.decided_at),
    decidedBy: asStringOrNull(row.decided_by),
    notes: asStringOrNull(row.notes),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function rowToRecord(row: WorkflowExecutionRow): WorkflowExecutionRecord {
  const execution = workflowExecutionSchema.parse({
    schemaVersion: 1,
    id: asString(row.id),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    origin: safeParseJson(row.origin_json),
    capabilities: safeParseJsonArray<string>(row.capabilities_json),
    workflowId: asString(row.workflow_id),
    projectId: asString(row.project_id),
    sessionId: asStringOrNull(row.session_id),
    taskId: asStringOrNull(row.task_id),
    runId: asStringOrNull(row.run_id),
    state: asString(row.state),
    currentStepId: asStringOrNull(row.current_step_id),
    stepStates: safeParseJson<Record<string, string>>(row.step_states_json),
    startedAt: asStringOrNull(row.started_at),
    finishedAt: asStringOrNull(row.finished_at),
    approvalId: asStringOrNull(row.approval_id),
    exitCode: row.exit_code == null ? null : asNumber(row.exit_code),
    artifacts: safeParseJsonArray<string>(row.artifacts_json),
    errorCode: asStringOrNull(row.error_code),
    errorSummary: asStringOrNull(row.error_summary),
  });
  const command = safeParseJson<WorkflowExecutionRecord["command"]>(row.command_json);
  return {
    execution,
    command,
    stdout: asString(row.stdout),
    stderr: asString(row.stderr),
    durationMs: asNumber(row.duration_ms),
  };
}

export function createWorkflowsRepo(db: DatabaseSync) {
  return {
    save(record: WorkflowExecutionRecord): WorkflowExecutionRecord {
      const execution = workflowExecutionSchema.parse(record.execution);
      db.prepare(
        `INSERT INTO workflow_executions (
           id, workflow_id, project_id, session_id, task_id, run_id, state, current_step_id,
           step_states_json, started_at, finished_at, approval_id, exit_code, artifacts_json,
           error_code, error_summary, command_json, stdout, stderr, duration_ms, origin_json,
           capabilities_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           state = excluded.state,
           current_step_id = excluded.current_step_id,
           step_states_json = excluded.step_states_json,
           finished_at = excluded.finished_at,
           approval_id = excluded.approval_id,
           exit_code = excluded.exit_code,
           artifacts_json = excluded.artifacts_json,
           error_code = excluded.error_code,
           error_summary = excluded.error_summary,
           stdout = excluded.stdout,
           stderr = excluded.stderr,
           duration_ms = excluded.duration_ms,
           updated_at = excluded.updated_at`
      ).run(
        execution.id,
        execution.workflowId,
        execution.projectId,
        execution.sessionId,
        execution.taskId,
        execution.runId,
        execution.state,
        execution.currentStepId,
        JSON.stringify(execution.stepStates),
        execution.startedAt,
        execution.finishedAt,
        execution.approvalId,
        execution.exitCode,
        JSON.stringify(execution.artifacts),
        execution.errorCode,
        execution.errorSummary,
        JSON.stringify(record.command),
        record.stdout,
        record.stderr,
        record.durationMs,
        JSON.stringify(execution.origin),
        JSON.stringify(execution.capabilities),
        execution.createdAt,
        execution.updatedAt
      );
      const saved = this.get(execution.id);
      if (!saved) throw new Error(`workflow execution ${execution.id} was not persisted`);
      return saved;
    },

    get(id: string): WorkflowExecutionRecord | null {
      const row = db.prepare("SELECT * FROM workflow_executions WHERE id = ? LIMIT 1").get(id) as
        | WorkflowExecutionRow
        | undefined;
      return row ? rowToRecord(row) : null;
    },

    list(projectId: string, limit = 50): WorkflowExecutionRecord[] {
      const rows = db
        .prepare("SELECT * FROM workflow_executions WHERE project_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(projectId, Math.max(1, Math.min(200, Math.floor(limit)))) as WorkflowExecutionRow[];
      return rows.map(rowToRecord);
    },

    requestApproval(input: {
      executionId: string;
      workflowId: string;
      projectId: string;
      mutation: string;
      contextHash: string;
      branch: string | null;
      baseCommit: string | null;
      reason: string;
      ttlSeconds?: number;
    }): WorkflowApprovalRecord {
      const timestamp = now();
      const ttlSeconds = Math.max(60, Math.min(86_400, Math.floor(input.ttlSeconds ?? 900)));
      const expiresAt = new Date(Date.parse(timestamp) + ttlSeconds * 1_000).toISOString();
      const id = newId("workflow_approval");
      db.prepare(
        `INSERT INTO workflow_approvals (
           id, execution_id, workflow_id, project_id, status, mutation, context_hash,
           branch, base_commit, reason, requested_at, expires_at, decided_at, decided_by,
           notes, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`
      ).run(
        id,
        input.executionId,
        input.workflowId,
        input.projectId,
        input.mutation,
        input.contextHash,
        input.branch,
        input.baseCommit,
        input.reason,
        timestamp,
        expiresAt,
        timestamp,
        timestamp
      );
      const approval = this.getApproval(id);
      if (!approval) throw new Error(`workflow approval ${id} was not persisted`);
      return approval;
    },

    getApproval(id: string): WorkflowApprovalRecord | null {
      const row = db.prepare("SELECT * FROM workflow_approvals WHERE id = ? LIMIT 1").get(id) as
        | WorkflowApprovalRow
        | undefined;
      return row ? rowToApproval(row) : null;
    },

    getApprovalForExecution(executionId: string): WorkflowApprovalRecord | null {
      const row = db.prepare("SELECT * FROM workflow_approvals WHERE execution_id = ? LIMIT 1").get(executionId) as
        | WorkflowApprovalRow
        | undefined;
      return row ? rowToApproval(row) : null;
    },

    decideApproval(input: {
      id: string;
      status: Exclude<WorkflowApprovalStatus, "pending">;
      decidedBy: string;
      notes?: string | null;
    }): WorkflowApprovalRecord {
      const timestamp = now();
      const result = db
        .prepare(
          `UPDATE workflow_approvals
           SET status = ?, decided_at = ?, decided_by = ?, notes = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'`
        )
        .run(input.status, timestamp, input.decidedBy, input.notes ?? null, timestamp, input.id);
      if (Number(result.changes) !== 1) {
        throw new Error(`workflow approval is missing or already decided: ${input.id}`);
      }
      const approval = this.getApproval(input.id);
      if (!approval) throw new Error(`workflow approval ${input.id} disappeared after decision`);
      return approval;
    },
  };
}

export type WorkflowsRepo = ReturnType<typeof createWorkflowsRepo>;
