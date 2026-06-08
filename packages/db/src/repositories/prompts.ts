import type { DatabaseSync } from "node:sqlite";
import type { CompiledPromptRecord } from "../../../shared/src/index.ts";
import { asNumber, asString, asStringOrNull, newId, now } from "./_shared.ts";

interface CompiledPromptRow {
  id: string;
  session_id: string | null;
  task_id: string | null;
  retrieval_query_id: string | null;
  context_pack_id: string | null;
  mode: string;
  role: string;
  messages_json: string;
  estimated_tokens: number;
  included_context_json: string;
  omitted_context_json: string;
  safety_notes_json: string;
  output_schema_json: string | null;
  created_at: string;
}

function rowToCompiledPrompt(row: CompiledPromptRow): CompiledPromptRecord {
  return {
    id: asString(row.id),
    sessionId: asStringOrNull(row.session_id),
    taskId: asStringOrNull(row.task_id),
    retrievalQueryId: asStringOrNull(row.retrieval_query_id),
    contextPackId: asStringOrNull(row.context_pack_id),
    mode: asString(row.mode),
    role: asString(row.role),
    messagesJson: asString(row.messages_json),
    estimatedTokens: asNumber(row.estimated_tokens),
    includedContextJson: asString(row.included_context_json),
    omittedContextJson: asString(row.omitted_context_json),
    safetyNotesJson: asString(row.safety_notes_json),
    outputSchemaJson: asStringOrNull(row.output_schema_json),
    createdAt: asString(row.created_at),
  };
}

export function createPromptRepo(db: DatabaseSync) {
  return {
    recordCompiledPrompt(
      input: Omit<CompiledPromptRecord, "id" | "createdAt"> & { id?: string; createdAt?: string }
    ): CompiledPromptRecord {
      const id = input.id ?? newId("pp");
      const ts = input.createdAt ?? now();
      db.prepare(
        `INSERT INTO compiled_prompts (
          id, session_id, task_id, retrieval_query_id, context_pack_id,
          mode, role, messages_json, estimated_tokens, included_context_json,
          omitted_context_json, safety_notes_json, output_schema_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        input.sessionId ?? null,
        input.taskId ?? null,
        input.retrievalQueryId ?? null,
        input.contextPackId ?? null,
        input.mode,
        input.role,
        input.messagesJson,
        input.estimatedTokens,
        input.includedContextJson,
        input.omittedContextJson,
        input.safetyNotesJson,
        input.outputSchemaJson ?? null,
        ts
      );
      return {
        ...input,
        id,
        createdAt: ts,
      };
    },
    getCompiledPrompt(id: string): CompiledPromptRecord | null {
      const row = db.prepare("SELECT * FROM compiled_prompts WHERE id = ? LIMIT 1").get(id) as
        | CompiledPromptRow
        | undefined;
      return row ? rowToCompiledPrompt(row) : null;
    },
    listCompiledPrompts(sessionId?: string | null, limit = 50): CompiledPromptRecord[] {
      const rows = sessionId
        ? (db
            .prepare(
              "SELECT * FROM compiled_prompts WHERE session_id = ? ORDER BY created_at DESC LIMIT ?"
            )
            .all(sessionId, limit) as CompiledPromptRow[])
        : (db
            .prepare("SELECT * FROM compiled_prompts ORDER BY created_at DESC LIMIT ?")
            .all(limit) as CompiledPromptRow[]);
      return rows.map(rowToCompiledPrompt);
    },
  };
}

export type PromptRepo = ReturnType<typeof createPromptRepo>;
