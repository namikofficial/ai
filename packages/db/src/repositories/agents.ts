import type { DatabaseSync } from "node:sqlite";
import type {
  AgentHandoffRecord,
  AgentMessageDirection,
  AgentMessageRecord,
  AgentRisk,
  AgentRunRecord,
  AgentStatus,
} from "../../../shared/src/index.ts";
import { asNumber, asString, asStringOrNull, now, newId, safeParseJson } from "./_shared.ts";

interface AgentRunRow {
  id: string;
  session_id: string | null;
  task_id: string | null;
  project_id: string | null;
  agent: string;
  role: string;
  status: string;
  input_json: string;
  output_json: string;
  model_role: string | null;
  risk: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface AgentMessageRow {
  id: string;
  agent_run_id: string;
  direction: string;
  role: string;
  content: string;
  meta_json: string;
  ts: string;
  created_at: string;
}

interface AgentHandoffRow {
  id: string;
  from_agent_run_id: string | null;
  to_agent: string;
  payload_json: string;
  context_pack_id: string | null;
  session_id: string | null;
  task_id: string | null;
  created_at: string;
}

function rowToRun(row: AgentRunRow): AgentRunRecord {
  return {
    id: asString(row.id),
    sessionId: asStringOrNull(row.session_id),
    taskId: asStringOrNull(row.task_id),
    projectId: asStringOrNull(row.project_id),
    agent: asString(row.agent),
    role: asString(row.role),
    status: asString(row.status) as AgentStatus,
    input: safeParseJson(asString(row.input_json)),
    output: safeParseJson(asString(row.output_json)),
    modelRole: asStringOrNull(row.model_role) as AgentRunRecord["modelRole"],
    risk: asString(row.risk) as AgentRisk,
    startedAt: asString(row.started_at),
    finishedAt: asStringOrNull(row.finished_at),
    durationMs: row.duration_ms == null ? null : asNumber(row.duration_ms),
    error: asStringOrNull(row.error),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function rowToMessage(row: AgentMessageRow): AgentMessageRecord {
  return {
    id: asString(row.id),
    agentRunId: asString(row.agent_run_id),
    direction: asString(row.direction) as AgentMessageDirection,
    role: asString(row.role),
    content: asString(row.content),
    meta: safeParseJson(asString(row.meta_json)),
    ts: asString(row.ts),
    createdAt: asString(row.created_at),
  };
}

function rowToHandoff(row: AgentHandoffRow): AgentHandoffRecord {
  return {
    id: asString(row.id),
    fromAgentRunId: asStringOrNull(row.from_agent_run_id),
    toAgent: asString(row.to_agent),
    payload: safeParseJson(asString(row.payload_json)),
    contextPackId: asStringOrNull(row.context_pack_id),
    sessionId: asStringOrNull(row.session_id),
    taskId: asStringOrNull(row.task_id),
    createdAt: asString(row.created_at),
  };
}

export function createAgentsRepo(db: DatabaseSync) {
  return {
    createRun(input: {
      sessionId?: string | null;
      taskId?: string | null;
      projectId?: string | null;
      agent: string;
      role: string;
      input?: Record<string, unknown>;
      modelRole?: string | null;
      risk?: AgentRisk;
    }): AgentRunRecord {
      const id = newId("arun");
      const ts = now();
      const risk = input.risk ?? "low";
      db.prepare(
        `INSERT INTO agent_runs (
          id, session_id, task_id, project_id, agent, role, status, input_json, output_json,
          model_role, risk, started_at, finished_at, duration_ms, error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.sessionId ?? null,
        input.taskId ?? null,
        input.projectId ?? null,
        input.agent,
        input.role,
        "running",
        JSON.stringify(input.input ?? {}),
        "{}",
        input.modelRole ?? null,
        risk,
        ts,
        null,
        null,
        null,
        ts,
        ts,
      );
      return {
        id,
        sessionId: input.sessionId ?? null,
        taskId: input.taskId ?? null,
        projectId: input.projectId ?? null,
        agent: input.agent,
        role: input.role,
        status: "running",
        input: input.input ?? {},
        output: {},
        modelRole: (input.modelRole as AgentRunRecord["modelRole"]) ?? null,
        risk,
        startedAt: ts,
        finishedAt: null,
        durationMs: null,
        error: null,
        createdAt: ts,
        updatedAt: ts,
      };
    },
    updateRun(id: string, patch: Partial<Pick<AgentRunRecord, "status" | "output" | "error" | "finishedAt" | "durationMs">>): AgentRunRecord {
      const current = db.prepare("SELECT * FROM agent_runs WHERE id = ? LIMIT 1").get(id) as AgentRunRow | undefined;
      if (!current) throw new Error(`unknown agent run: ${id}`);
      const nextStatus = patch.status ?? (current.status as AgentStatus);
      const nextOutput = patch.output !== undefined ? JSON.stringify(patch.output) : current.output_json;
      const nextError = patch.error !== undefined ? patch.error : current.error;
      const nextFinished = patch.finishedAt !== undefined ? patch.finishedAt : current.finished_at;
      const nextDuration = patch.durationMs !== undefined ? patch.durationMs : current.duration_ms;
      const ts = now();
      db.prepare(
        `UPDATE agent_runs SET status = ?, output_json = ?, error = ?, finished_at = ?, duration_ms = ?, updated_at = ? WHERE id = ?`,
      ).run(nextStatus, nextOutput, nextError, nextFinished, nextDuration, ts, id);
      const updated = db.prepare("SELECT * FROM agent_runs WHERE id = ?").get(id) as AgentRunRow;
      return rowToRun(updated);
    },
    getRun(id: string): AgentRunRecord | null {
      const row = db.prepare("SELECT * FROM agent_runs WHERE id = ? LIMIT 1").get(id) as AgentRunRow | undefined;
      return row ? rowToRun(row) : null;
    },
    listRuns(sessionId: string, limit = 200): AgentRunRecord[] {
      const rows = db
        .prepare("SELECT * FROM agent_runs WHERE session_id = ? ORDER BY started_at ASC LIMIT ?")
        .all(sessionId, limit) as AgentRunRow[];
      return rows.map(rowToRun);
    },
    appendMessage(input: {
      agentRunId: string;
      direction: AgentMessageDirection;
      role: string;
      content: string;
      meta?: Record<string, unknown>;
    }): AgentMessageRecord {
      const id = newId("amsg");
      const ts = now();
      db.prepare(
        `INSERT INTO agent_messages (
          id, agent_run_id, direction, role, content, meta_json, ts, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.agentRunId,
        input.direction,
        input.role,
        input.content,
        JSON.stringify(input.meta ?? {}),
        ts,
        ts,
      );
      return {
        id,
        agentRunId: input.agentRunId,
        direction: input.direction,
        role: input.role,
        content: input.content,
        meta: input.meta ?? {},
        ts,
        createdAt: ts,
      };
    },
    listMessages(agentRunId: string, limit = 200): AgentMessageRecord[] {
      const rows = db
        .prepare("SELECT * FROM agent_messages WHERE agent_run_id = ? ORDER BY ts ASC LIMIT ?")
        .all(agentRunId, limit) as AgentMessageRow[];
      return rows.map(rowToMessage);
    },
    recordHandoff(input: {
      fromAgentRunId?: string | null;
      toAgent: string;
      payload?: Record<string, unknown>;
      contextPackId?: string | null;
      sessionId?: string | null;
      taskId?: string | null;
    }): AgentHandoffRecord {
      const id = newId("ah");
      const ts = now();
      db.prepare(
        `INSERT INTO agent_handoffs (
          id, from_agent_run_id, to_agent, payload_json, context_pack_id, session_id, task_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.fromAgentRunId ?? null,
        input.toAgent,
        JSON.stringify(input.payload ?? {}),
        input.contextPackId ?? null,
        input.sessionId ?? null,
        input.taskId ?? null,
        ts,
      );
      return {
        id,
        fromAgentRunId: input.fromAgentRunId ?? null,
        toAgent: input.toAgent,
        payload: input.payload ?? {},
        contextPackId: input.contextPackId ?? null,
        sessionId: input.sessionId ?? null,
        taskId: input.taskId ?? null,
        createdAt: ts,
      };
    },
    listHandoffs(sessionId: string, limit = 50): AgentHandoffRecord[] {
      const rows = db
        .prepare("SELECT * FROM agent_handoffs WHERE session_id = ? ORDER BY created_at ASC LIMIT ?")
        .all(sessionId, limit) as AgentHandoffRow[];
      return rows.map(rowToHandoff);
    },
    listAllHandoffs(limit = 50): AgentHandoffRecord[] {
      const rows = db
        .prepare("SELECT * FROM agent_handoffs ORDER BY created_at DESC LIMIT ?")
        .all(limit) as AgentHandoffRow[];
      return rows.map(rowToHandoff);
    },
  };
}

export type AgentsRepo = ReturnType<typeof createAgentsRepo>;
