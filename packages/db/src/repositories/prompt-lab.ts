import type { DatabaseSync } from "node:sqlite";
import type { PromptLabResultRecord, PromptLabRunRecord } from "../../../shared/src/index.ts";
import { asNumber, asString, asStringOrNull, newId, now, safeParseJsonArray } from "./_shared.ts";

interface PromptLabRunRow {
  id: string;
  session_id: string | null;
  project_id: string;
  prompt_id: string;
  mode: string;
  selected_profiles_json: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface PromptLabResultRow {
  id: string;
  run_id: string;
  profile_id: string;
  profile_name: string;
  model_name: string;
  status: string;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  output_text: string | null;
  error: string | null;
  approx_cost: number | null;
  created_at: string;
}

function rowToRun(row: PromptLabRunRow): PromptLabRunRecord {
  return {
    id: asString(row.id),
    sessionId: asStringOrNull(row.session_id),
    projectId: asString(row.project_id),
    promptId: asString(row.prompt_id),
    mode: asString(row.mode),
    selectedProfiles: safeParseJsonArray<string>(asString(row.selected_profiles_json)),
    notes: asStringOrNull(row.notes),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function rowToResult(row: PromptLabResultRow): PromptLabResultRecord {
  return {
    id: asString(row.id),
    runId: asString(row.run_id),
    profileId: asString(row.profile_id),
    profileName: asString(row.profile_name),
    modelName: asString(row.model_name),
    status: asString(row.status) as PromptLabResultRecord["status"],
    promptTokens: asNumber(row.prompt_tokens),
    completionTokens: asNumber(row.completion_tokens),
    latencyMs: asNumber(row.latency_ms),
    outputText: asStringOrNull(row.output_text),
    error: asStringOrNull(row.error),
    approxCost: row.approx_cost != null ? asNumber(row.approx_cost) : null,
    createdAt: asString(row.created_at),
  };
}

export function createPromptLabRepo(db: DatabaseSync) {
  return {
    listRuns(limit = 100): PromptLabRunRecord[] {
      const rows = db
        .prepare("SELECT * FROM prompt_lab_runs ORDER BY created_at DESC LIMIT ?")
        .all(limit) as PromptLabRunRow[];
      return rows.map(rowToRun);
    },

    getRun(runId: string): PromptLabRunRecord | null {
      const row = db.prepare("SELECT * FROM prompt_lab_runs WHERE id = ? LIMIT 1").get(runId) as
        | PromptLabRunRow
        | undefined;
      return row ? rowToRun(row) : null;
    },

    listResults(runId: string): PromptLabResultRecord[] {
      const rows = db
        .prepare("SELECT * FROM prompt_lab_results WHERE run_id = ? ORDER BY created_at ASC")
        .all(runId) as PromptLabResultRow[];
      return rows.map(rowToResult);
    },

    createRun(input: {
      id: string;
      sessionId?: string | null;
      projectId: string;
      promptId: string;
      mode: string;
      selectedProfiles: string[];
      notes?: string | null;
      createdAt?: string;
      updatedAt?: string;
    }): PromptLabRunRecord {
      const ts = input.createdAt ?? now();
      const runId = input.id;
      db.prepare(
        `INSERT INTO prompt_lab_runs (
          id, session_id, project_id, prompt_id, mode, selected_profiles_json, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        runId,
        input.sessionId ?? null,
        input.projectId,
        input.promptId,
        input.mode,
        JSON.stringify(input.selectedProfiles),
        input.notes ?? null,
        ts,
        ts
      );
      return {
        id: runId,
        sessionId: input.sessionId ?? null,
        projectId: input.projectId,
        promptId: input.promptId,
        mode: input.mode,
        selectedProfiles: input.selectedProfiles,
        notes: input.notes ?? null,
        createdAt: ts,
        updatedAt: ts,
      };
    },

    createResult(input: {
      id: string;
      runId: string;
      profileId: string;
      profileName: string;
      modelName: string;
      status: string;
      promptTokens: number;
      completionTokens: number;
      latencyMs: number;
      outputText?: string | null;
      error?: string | null;
      approxCost?: number | null;
      createdAt?: string;
    }): PromptLabResultRecord {
      const ts = input.createdAt ?? now();
      const resultId = input.id;
      db.prepare(
        `INSERT INTO prompt_lab_results (
          id, run_id, profile_id, profile_name, model_name, status,
          prompt_tokens, completion_tokens, latency_ms, output_text, error, approx_cost, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        resultId,
        input.runId,
        input.profileId,
        input.profileName,
        input.modelName,
        input.status,
        input.promptTokens,
        input.completionTokens,
        input.latencyMs,
        input.outputText ?? null,
        input.error ?? null,
        input.approxCost ?? null,
        ts
      );
      return {
        id: resultId,
        runId: input.runId,
        profileId: input.profileId,
        profileName: input.profileName,
        modelName: input.modelName,
        status: input.status as PromptLabResultRecord["status"],
        promptTokens: input.promptTokens,
        completionTokens: input.completionTokens,
        latencyMs: input.latencyMs,
        outputText: input.outputText ?? null,
        error: input.error ?? null,
        approxCost: input.approxCost ?? null,
        createdAt: ts,
      };
    },
  };
}

export type PromptLabRepo = ReturnType<typeof createPromptLabRepo>;
