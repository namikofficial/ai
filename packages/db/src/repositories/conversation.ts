import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  ConversationMessageRecord,
  ConversationMessageRole,
} from "../../../shared/src/index.ts";
import {
  asBool,
  asNumber,
  asString,
  asStringOrNull,
  newId,
  now,
  safeParseJson,
} from "./_shared.ts";

interface ConversationRow {
  id: string;
  session_id: string;
  project_id: string | null;
  role: string;
  agent: string | null;
  content: string;
  content_hash: string;
  meta_json: string;
  token_count: number;
  parent_message_id: string | null;
  ts: string;
  created_at: string;
}

function rowToConversationMessage(row: ConversationRow): ConversationMessageRecord {
  return {
    id: asString(row.id),
    sessionId: asString(row.session_id),
    projectId: asStringOrNull(row.project_id),
    role: asString(row.role) as ConversationMessageRole,
    agent: asStringOrNull(row.agent),
    content: asString(row.content),
    contentHash: asString(row.content_hash),
    metaJson: asString(row.meta_json),
    tokenCount: asNumber(row.token_count),
    parentMessageId: asStringOrNull(row.parent_message_id),
    ts: asString(row.ts),
    createdAt: asString(row.created_at),
  };
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function createConversationRepo(db: DatabaseSync) {
  return {
    appendMessage(input: {
      sessionId: string;
      projectId?: string | null;
      role: ConversationMessageRole;
      agent?: string | null;
      content: string;
      parentMessageId?: string | null;
      tokenCount?: number;
      meta?: Record<string, unknown>;
      ts?: string | null;
    }): ConversationMessageRecord {
      const id = newId("msg");
      const ts = input.ts ?? now();
      const meta = input.meta ?? {};
      const content = input.content;
      const tokenCount = input.tokenCount ?? Math.max(1, Math.ceil(content.length / 4));
      db.prepare(
        `INSERT INTO conversation_messages (
          id, session_id, project_id, role, agent, content, content_hash,
          meta_json, token_count, parent_message_id, ts, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        input.sessionId,
        input.projectId ?? null,
        input.role,
        input.agent ?? null,
        content,
        hashContent(content),
        JSON.stringify(meta),
        tokenCount,
        input.parentMessageId ?? null,
        ts,
        ts
      );
      return {
        id,
        sessionId: input.sessionId,
        projectId: input.projectId ?? null,
        role: input.role,
        agent: input.agent ?? null,
        content,
        contentHash: hashContent(content),
        metaJson: JSON.stringify(meta),
        tokenCount,
        parentMessageId: input.parentMessageId ?? null,
        ts,
        createdAt: ts,
      };
    },
    listMessages(sessionId: string, limit = 200): ConversationMessageRecord[] {
      const rows = db
        .prepare("SELECT * FROM conversation_messages WHERE session_id = ? ORDER BY ts ASC LIMIT ?")
        .all(sessionId, limit) as ConversationRow[];
      return rows.map(rowToConversationMessage);
    },
    listRecentMessages(limit = 200): ConversationMessageRecord[] {
      const rows = db
        .prepare("SELECT * FROM conversation_messages ORDER BY ts DESC LIMIT ?")
        .all(limit) as ConversationRow[];
      return rows.map(rowToConversationMessage).reverse();
    },
    getMessage(id: string): ConversationMessageRecord | null {
      const row = db.prepare("SELECT * FROM conversation_messages WHERE id = ? LIMIT 1").get(id) as
        | ConversationRow
        | undefined;
      if (!row) return null;
      return rowToConversationMessage(row);
    },
  };
}

export type ConversationRepo = ReturnType<typeof createConversationRepo>;

// Re-export to silence unused-import warnings while keeping the surface explicit.
export { asBool, safeParseJson };
