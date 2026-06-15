import type { DatabaseSync } from "node:sqlite";
import type {
  ContextBudgetEventRecord,
  ContextPackItemKind,
  ContextPackItemRecord,
  ContextPackRecord,
} from "../../../shared/src/index.ts";
import { asBool, asNumber, asString, asStringOrNull, newId, now } from "./_shared.ts";

interface ContextPackRow {
  id: string;
  session_id: string | null;
  task_id: string | null;
  project_id: string | null;
  retrieval_query_id: string | null;
  budget_tokens: number;
  used_tokens: number;
  reason: string | null;
  created_at: string;
}

interface ContextPackItemRow {
  id: string;
  context_pack_id: string;
  kind: string;
  source_id: string | null;
  rank: number;
  token_count: number;
  excerpt: string;
  included: number;
  omission_reason: string | null;
  created_at: string;
}

interface ContextBudgetRow {
  id: string;
  context_pack_id: string;
  delta_tokens: number;
  reason: string;
  created_at: string;
}

function rowToPack(row: ContextPackRow): ContextPackRecord {
  return {
    id: asString(row.id),
    sessionId: asStringOrNull(row.session_id),
    taskId: asStringOrNull(row.task_id),
    projectId: asStringOrNull(row.project_id),
    retrievalQueryId: asStringOrNull(row.retrieval_query_id),
    budgetTokens: asNumber(row.budget_tokens),
    usedTokens: asNumber(row.used_tokens),
    reason: asStringOrNull(row.reason),
    createdAt: asString(row.created_at),
  };
}

function rowToItem(row: ContextPackItemRow): ContextPackItemRecord {
  return {
    id: asString(row.id),
    contextPackId: asString(row.context_pack_id),
    kind: asString(row.kind) as ContextPackItemKind,
    sourceId: asStringOrNull(row.source_id),
    rank: asNumber(row.rank),
    tokenCount: asNumber(row.token_count),
    excerpt: asString(row.excerpt),
    included: asBool(row.included),
    omissionReason: asStringOrNull(row.omission_reason),
    createdAt: asString(row.created_at),
  };
}

function rowToBudget(row: ContextBudgetRow): ContextBudgetEventRecord {
  return {
    id: asString(row.id),
    contextPackId: asString(row.context_pack_id),
    deltaTokens: asNumber(row.delta_tokens),
    reason: asString(row.reason),
    createdAt: asString(row.created_at),
  };
}

export function createContextRepo(db: DatabaseSync) {
  return {
    recordPack(input: {
      sessionId?: string | null;
      taskId?: string | null;
      projectId?: string | null;
      retrievalQueryId?: string | null;
      budgetTokens: number;
      usedTokens: number;
      reason?: string | null;
      items: Array<{
        kind: ContextPackItemKind;
        sourceId?: string | null;
        rank: number;
        tokenCount: number;
        excerpt: string;
        included?: boolean;
        omissionReason?: string | null;
      }>;
      budgetEvents?: Array<{
        deltaTokens: number;
        reason: string;
      }>;
    }): ContextPackRecord {
      const id = newId("cp");
      const ts = now();
      db.prepare(
        `INSERT INTO context_packs (
          id, session_id, task_id, project_id, retrieval_query_id,
          budget_tokens, used_tokens, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        input.sessionId ?? null,
        input.taskId ?? null,
        input.projectId ?? null,
        input.retrievalQueryId ?? null,
        input.budgetTokens,
        input.usedTokens,
        input.reason ?? null,
        ts
      );
      const itemInsert = db.prepare(
        `INSERT INTO context_pack_items (
          id, context_pack_id, kind, source_id, rank, token_count, excerpt,
          included, omission_reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const item of input.items) {
        itemInsert.run(
          newId("cpi"),
          id,
          item.kind,
          item.sourceId ?? null,
          item.rank,
          item.tokenCount,
          item.excerpt,
          item.included === false ? 0 : 1,
          item.omissionReason ?? null,
          ts
        );
      }
      const budgetInsert = db.prepare(
        `INSERT INTO context_budget_events (id, context_pack_id, delta_tokens, reason, created_at)
         VALUES (?, ?, ?, ?, ?)`
      );
      for (const ev of input.budgetEvents ?? []) {
        budgetInsert.run(newId("cbe"), id, ev.deltaTokens, ev.reason, ts);
      }
      return {
        id,
        sessionId: input.sessionId ?? null,
        taskId: input.taskId ?? null,
        projectId: input.projectId ?? null,
        retrievalQueryId: input.retrievalQueryId ?? null,
        budgetTokens: input.budgetTokens,
        usedTokens: input.usedTokens,
        reason: input.reason ?? null,
        createdAt: ts,
      };
    },
    getPack(id: string): ContextPackRecord | null {
      const row = db.prepare("SELECT * FROM context_packs WHERE id = ? LIMIT 1").get(id) as ContextPackRow | undefined;
      return row ? rowToPack(row) : null;
    },
    listPacksForSession(sessionId: string, limit = 50): ContextPackRecord[] {
      const rows = db
        .prepare("SELECT * FROM context_packs WHERE session_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(sessionId, limit) as ContextPackRow[];
      return rows.map(rowToPack);
    },
    listItems(packId: string): ContextPackItemRecord[] {
      const rows = db
        .prepare("SELECT * FROM context_pack_items WHERE context_pack_id = ? ORDER BY rank ASC")
        .all(packId) as ContextPackItemRow[];
      return rows.map(rowToItem);
    },
    listBudgetEvents(packId: string): ContextBudgetEventRecord[] {
      const rows = db
        .prepare("SELECT * FROM context_budget_events WHERE context_pack_id = ? ORDER BY created_at ASC")
        .all(packId) as ContextBudgetRow[];
      return rows.map(rowToBudget);
    },
  };
}

export type ContextRepo = ReturnType<typeof createContextRepo>;
