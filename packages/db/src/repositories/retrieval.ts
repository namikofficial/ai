import type { DatabaseSync } from "node:sqlite";
import type {
  ChunkPathBoostRecord,
  QueryAnalysis,
  QueryRewriteRecord,
  RetrievalDepth,
  RetrievalFeedbackRating,
  RetrievalFeedbackRecord,
  RetrievalIntentKind,
  RetrievalMissRecord,
  RetrievalMode,
  RetrievalPathFeedbackRecord,
  RetrievalQueryRecord,
  RetrievalResultRecord,
  RetrievalSelectedContextRecord,
} from "../../../shared/src/index.ts";
import { asNumber, asString, asStringOrNull, now, newId, safeParseJson, safeParseJsonArray } from "./_shared.ts";

interface RetrievalQueryRow {
  id: string;
  session_id: string | null;
  task_id: string | null;
  project_id: string;
  original_query: string;
  intent: string;
  mode: string;
  depth: string;
  rewritten_query: string | null;
  analysis_json: string;
  created_at: string;
}

interface RetrievalRewriteRow {
  id: string;
  retrieval_query_id: string;
  variant: string;
  terms_json: string;
  path_hints_json: string;
  symbol_hints_json: string;
  score: number;
  created_at: string;
}

interface RetrievalResultRow {
  id: string;
  retrieval_query_id: string;
  chunk_id: string;
  path: string;
  start_line: number;
  end_line: number;
  source: string;
  base_score: number;
  rerank_score: number;
  final_score: number;
  included: number;
  reason: string | null;
  created_at: string;
}

interface RetrievalSelectedContextRow {
  id: string;
  retrieval_query_id: string;
  chunk_id: string;
  rank: number;
  token_count: number;
  excerpt: string;
  created_at: string;
}

interface RetrievalFeedbackRow {
  id: string;
  retrieval_query_id: string;
  chunk_id: string | null;
  rating: string;
  missed_path: string | null;
  notes: string | null;
  created_at: string;
}

interface RetrievalMissRow {
  id: string;
  retrieval_query_id: string;
  missed_path: string;
  confidence: number;
  notes: string | null;
  created_at: string;
}

interface RetrievalPathFeedbackRow {
  id: string;
  project_id: string;
  retrieval_query_id: string | null;
  path: string;
  rating: string;
  weight: number;
  notes: string | null;
  created_at: string;
}

interface ChunkPathBoostRow {
  id: string;
  project_id: string;
  path: string;
  weight: number;
  source: string;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

function rowToQuery(row: RetrievalQueryRow): RetrievalQueryRecord {
  return {
    id: asString(row.id),
    sessionId: asStringOrNull(row.session_id),
    taskId: asStringOrNull(row.task_id),
    projectId: asString(row.project_id),
    originalQuery: asString(row.original_query),
    intent: asString(row.intent) as RetrievalIntentKind,
    mode: asString(row.mode) as RetrievalMode,
    depth: asString(row.depth) as RetrievalDepth,
    rewrittenQuery: asStringOrNull(row.rewritten_query),
    analysis: safeParseJson<QueryAnalysis>(asString(row.analysis_json)),
    createdAt: asString(row.created_at),
  };
}

function rowToRewrite(row: RetrievalRewriteRow): QueryRewriteRecord {
  return {
    id: asString(row.id),
    retrievalQueryId: asString(row.retrieval_query_id),
    variant: asString(row.variant),
    terms: safeParseJsonArray<string>(asString(row.terms_json)),
    pathHints: safeParseJsonArray<string>(asString(row.path_hints_json)),
    symbolHints: safeParseJsonArray<string>(asString(row.symbol_hints_json)),
    score: asNumber(row.score),
    createdAt: asString(row.created_at),
  };
}

function rowToResult(row: RetrievalResultRow): RetrievalResultRecord {
  return {
    id: asString(row.id),
    retrievalQueryId: asString(row.retrieval_query_id),
    chunkId: asString(row.chunk_id),
    path: asString(row.path),
    startLine: asNumber(row.start_line),
    endLine: asNumber(row.end_line),
    source: asString(row.source) as RetrievalResultRecord["source"],
    baseScore: asNumber(row.base_score),
    rerankScore: asNumber(row.rerank_score),
    finalScore: asNumber(row.final_score),
    included: row.included === 1,
    reason: asStringOrNull(row.reason),
    createdAt: asString(row.created_at),
  };
}

function rowToSelectedContext(row: RetrievalSelectedContextRow): RetrievalSelectedContextRecord {
  return {
    id: asString(row.id),
    retrievalQueryId: asString(row.retrieval_query_id),
    chunkId: asString(row.chunk_id),
    rank: asNumber(row.rank),
    tokenCount: asNumber(row.token_count),
    excerpt: asString(row.excerpt),
    createdAt: asString(row.created_at),
  };
}

function rowToFeedback(row: RetrievalFeedbackRow): RetrievalFeedbackRecord {
  return {
    id: asString(row.id),
    retrievalQueryId: asString(row.retrieval_query_id),
    chunkId: asStringOrNull(row.chunk_id),
    rating: asString(row.rating) as RetrievalFeedbackRating,
    missedPath: asStringOrNull(row.missed_path),
    notes: asStringOrNull(row.notes),
    createdAt: asString(row.created_at),
  };
}

function rowToMiss(row: RetrievalMissRow): RetrievalMissRecord {
  return {
    id: asString(row.id),
    retrievalQueryId: asString(row.retrieval_query_id),
    missedPath: asString(row.missed_path),
    confidence: asNumber(row.confidence),
    notes: asStringOrNull(row.notes),
    createdAt: asString(row.created_at),
  };
}

function rowToPathFeedback(row: RetrievalPathFeedbackRow): RetrievalPathFeedbackRecord {
  return {
    id: asString(row.id),
    projectId: asString(row.project_id),
    retrievalQueryId: asStringOrNull(row.retrieval_query_id),
    path: asString(row.path),
    rating: asString(row.rating) as RetrievalFeedbackRating,
    weight: asNumber(row.weight),
    notes: asStringOrNull(row.notes),
    createdAt: asString(row.created_at),
  };
}

function rowToPathBoost(row: ChunkPathBoostRow): ChunkPathBoostRecord {
  return {
    id: asString(row.id),
    projectId: asString(row.project_id),
    path: asString(row.path),
    weight: asNumber(row.weight),
    source: asString(row.source),
    reason: asStringOrNull(row.reason),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

export function createRetrievalRepo(db: DatabaseSync) {
  return {
    createQuery(input: {
      sessionId?: string | null;
      taskId?: string | null;
      projectId: string;
      originalQuery: string;
      intent: RetrievalIntentKind;
      mode: RetrievalMode;
      depth: RetrievalDepth;
      rewrittenQuery?: string | null;
      analysis: QueryAnalysis;
    }): RetrievalQueryRecord {
      const id = newId("rq");
      const ts = now();
      db.prepare(
        `INSERT INTO retrieval_queries (
          id, session_id, task_id, project_id, original_query, intent, mode, depth,
          rewritten_query, analysis_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.sessionId ?? null,
        input.taskId ?? null,
        input.projectId,
        input.originalQuery,
        input.intent,
        input.mode,
        input.depth,
        input.rewrittenQuery ?? null,
        JSON.stringify(input.analysis),
        ts,
      );
      return {
        id,
        sessionId: input.sessionId ?? null,
        taskId: input.taskId ?? null,
        projectId: input.projectId,
        originalQuery: input.originalQuery,
        intent: input.intent,
        mode: input.mode,
        depth: input.depth,
        rewrittenQuery: input.rewrittenQuery ?? null,
        analysis: input.analysis,
        createdAt: ts,
      };
    },
    updateRewrittenQuery(queryId: string, rewrittenQuery: string): void {
      db.prepare("UPDATE retrieval_queries SET rewritten_query = ? WHERE id = ?").run(rewrittenQuery, queryId);
    },
    getQuery(id: string): RetrievalQueryRecord | null {
      const row = db.prepare("SELECT * FROM retrieval_queries WHERE id = ? LIMIT 1").get(id) as RetrievalQueryRow | undefined;
      return row ? rowToQuery(row) : null;
    },
    listQueriesForSession(sessionId: string, limit = 50): RetrievalQueryRecord[] {
      const rows = db
        .prepare("SELECT * FROM retrieval_queries WHERE session_id = ? ORDER BY created_at ASC LIMIT ?")
        .all(sessionId, limit) as RetrievalQueryRow[];
      return rows.map(rowToQuery);
    },
    listQueriesForProject(projectId: string, limit = 50): RetrievalQueryRecord[] {
      const rows = db
        .prepare("SELECT * FROM retrieval_queries WHERE project_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(projectId, limit) as RetrievalQueryRow[];
      return rows.map(rowToQuery);
    },
    createRewrite(input: {
      retrievalQueryId: string;
      variant: string;
      terms: string[];
      pathHints: string[];
      symbolHints: string[];
      score: number;
    }): QueryRewriteRecord {
      const id = newId("rrw");
      const ts = now();
      db.prepare(
        `INSERT INTO retrieval_rewrites (
          id, retrieval_query_id, variant, terms_json, path_hints_json,
          symbol_hints_json, score, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.retrievalQueryId,
        input.variant,
        JSON.stringify(input.terms),
        JSON.stringify(input.pathHints),
        JSON.stringify(input.symbolHints),
        input.score,
        ts,
      );
      return {
        id,
        retrievalQueryId: input.retrievalQueryId,
        variant: input.variant,
        terms: input.terms,
        pathHints: input.pathHints,
        symbolHints: input.symbolHints,
        score: input.score,
        createdAt: ts,
      };
    },
    listRewrites(retrievalQueryId: string): QueryRewriteRecord[] {
      const rows = db
        .prepare("SELECT * FROM retrieval_rewrites WHERE retrieval_query_id = ? ORDER BY score DESC, created_at ASC")
        .all(retrievalQueryId) as RetrievalRewriteRow[];
      return rows.map(rowToRewrite);
    },
    recordResults(queryId: string, results: Array<{
      chunkId: string;
      path: string;
      startLine: number;
      endLine: number;
      source: RetrievalResultRecord["source"];
      baseScore: number;
      rerankScore?: number;
      finalScore: number;
      included?: boolean;
      reason?: string | null;
    }>): RetrievalResultRecord[] {
      const ts = now();
      const insert = db.prepare(
        `INSERT INTO retrieval_results (
          id, retrieval_query_id, chunk_id, path, start_line, end_line, source,
          base_score, rerank_score, final_score, included, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const recorded: RetrievalResultRecord[] = [];
      for (const r of results) {
        const id = newId("rres");
        insert.run(
          id,
          queryId,
          r.chunkId,
          r.path,
          r.startLine,
          r.endLine,
          r.source,
          r.baseScore,
          r.rerankScore ?? 0,
          r.finalScore,
          r.included === false ? 0 : 1,
          r.reason ?? null,
          ts,
        );
        recorded.push({
          id,
          retrievalQueryId: queryId,
          chunkId: r.chunkId,
          path: r.path,
          startLine: r.startLine,
          endLine: r.endLine,
          source: r.source,
          baseScore: r.baseScore,
          rerankScore: r.rerankScore ?? 0,
          finalScore: r.finalScore,
          included: r.included !== false,
          reason: r.reason ?? null,
          createdAt: ts,
        });
      }
      return recorded;
    },
    listResults(queryId: string, limit = 200): RetrievalResultRecord[] {
      const rows = db
        .prepare("SELECT * FROM retrieval_results WHERE retrieval_query_id = ? ORDER BY final_score DESC LIMIT ?")
        .all(queryId, limit) as RetrievalResultRow[];
      return rows.map(rowToResult);
    },
    recordSelectedContext(queryId: string, items: Array<{
      chunkId: string;
      rank: number;
      tokenCount: number;
      excerpt: string;
    }>): RetrievalSelectedContextRecord[] {
      const ts = now();
      const insert = db.prepare(
        `INSERT INTO retrieval_selected_context (
          id, retrieval_query_id, chunk_id, rank, token_count, excerpt, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const recorded: RetrievalSelectedContextRecord[] = [];
      for (const item of items) {
        const id = newId("rsel");
        insert.run(id, queryId, item.chunkId, item.rank, item.tokenCount, item.excerpt, ts);
        recorded.push({
          id,
          retrievalQueryId: queryId,
          chunkId: item.chunkId,
          rank: item.rank,
          tokenCount: item.tokenCount,
          excerpt: item.excerpt,
          createdAt: ts,
        });
      }
      return recorded;
    },
    listSelectedContext(queryId: string): RetrievalSelectedContextRecord[] {
      const rows = db
        .prepare("SELECT * FROM retrieval_selected_context WHERE retrieval_query_id = ? ORDER BY rank ASC")
        .all(queryId) as RetrievalSelectedContextRow[];
      return rows.map(rowToSelectedContext);
    },
    recordFeedback(input: {
      retrievalQueryId: string;
      chunkId?: string | null;
      rating: RetrievalFeedbackRating;
      missedPath?: string | null;
      notes?: string | null;
    }): RetrievalFeedbackRecord {
      const id = newId("rfb");
      const ts = now();
      db.exec("BEGIN");
      try {
        db.prepare(
          `INSERT INTO retrieval_feedback (
            id, retrieval_query_id, chunk_id, rating, missed_path, notes, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          input.retrievalQueryId,
          input.chunkId ?? null,
          input.rating,
          input.missedPath ?? null,
          input.notes ?? null,
          ts,
        );
        const queryRow = db
          .prepare("SELECT project_id FROM retrieval_queries WHERE id = ?")
          .get(input.retrievalQueryId) as { project_id: string | null } | undefined;
        const projectId = queryRow?.project_id ?? null;
        let path: string | null = null;
        if (input.chunkId) {
          const chunkRow = db
            .prepare(
              "SELECT d.path AS path FROM rag_chunks c JOIN rag_documents d ON d.id = c.document_id WHERE c.id = ?",
            )
            .get(input.chunkId) as { path: string | null } | undefined;
          path = chunkRow?.path ?? null;
        } else if (input.missedPath) {
          path = input.missedPath;
        }
        if (projectId && path) {
          const weight = input.rating === "good" ? 0.7 : input.rating === "bad" ? 0.2 : 0.5;
          db.prepare(
            `INSERT INTO retrieval_path_feedback (
              id, project_id, retrieval_query_id, path, rating, weight, notes, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            newId("rpf"),
            projectId,
            input.retrievalQueryId,
            path,
            input.rating,
            weight,
            input.notes ?? null,
            ts,
          );
          const existingRow = db
            .prepare("SELECT weight FROM chunk_path_boosts WHERE project_id = ? AND path = ?")
            .get(projectId, path) as { weight: number } | undefined;
          const previousWeight = existingRow?.weight ?? 0.5;
          const nextWeight = Math.max(0, Math.min(1, previousWeight * 0.7 + weight * 0.3));
          if (existingRow) {
            db.prepare(
              "UPDATE chunk_path_boosts SET weight = ?, reason = ?, updated_at = ? WHERE project_id = ? AND path = ?",
            ).run(nextWeight, `feedback:${input.rating}`, ts, projectId, path);
          } else {
            db.prepare(
              `INSERT INTO chunk_path_boosts (
                id, project_id, path, weight, source, reason, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              newId("cpb"),
              projectId,
              path,
              nextWeight,
              "feedback",
              `feedback:${input.rating}`,
              ts,
              ts,
            );
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return {
        id,
        retrievalQueryId: input.retrievalQueryId,
        chunkId: input.chunkId ?? null,
        rating: input.rating,
        missedPath: input.missedPath ?? null,
        notes: input.notes ?? null,
        createdAt: ts,
      };
    },
    listFeedback(queryId: string, limit = 50): RetrievalFeedbackRecord[] {
      const rows = db
        .prepare("SELECT * FROM retrieval_feedback WHERE retrieval_query_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(queryId, limit) as RetrievalFeedbackRow[];
      return rows.map(rowToFeedback);
    },
    recordMiss(input: {
      retrievalQueryId: string;
      missedPath: string;
      confidence: number;
      notes?: string | null;
    }): RetrievalMissRecord {
      const id = newId("rms");
      const ts = now();
      db.prepare(
        `INSERT INTO retrieval_misses (
          id, retrieval_query_id, missed_path, confidence, notes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.retrievalQueryId,
        input.missedPath,
        input.confidence,
        input.notes ?? null,
        ts,
      );
      return {
        id,
        retrievalQueryId: input.retrievalQueryId,
        missedPath: input.missedPath,
        confidence: input.confidence,
        notes: input.notes ?? null,
        createdAt: ts,
      };
    },
    listMisses(queryId: string): RetrievalMissRecord[] {
      const rows = db
        .prepare("SELECT * FROM retrieval_misses WHERE retrieval_query_id = ? ORDER BY confidence ASC")
        .all(queryId) as RetrievalMissRow[];
      return rows.map(rowToMiss);
    },
    listPathFeedback(projectId: string, limit = 100): RetrievalPathFeedbackRecord[] {
      const rows = db
        .prepare(
          "SELECT * FROM retrieval_path_feedback WHERE project_id = ? ORDER BY created_at DESC LIMIT ?",
        )
        .all(projectId, limit) as RetrievalPathFeedbackRow[];
      return rows.map(rowToPathFeedback);
    },
    listPathBoosts(projectId: string, limit = 100): ChunkPathBoostRecord[] {
      const rows = db
        .prepare(
          "SELECT * FROM chunk_path_boosts WHERE project_id = ? ORDER BY weight DESC LIMIT ?",
        )
        .all(projectId, limit) as ChunkPathBoostRow[];
      return rows.map(rowToPathBoost);
    },
  };
}

export type RetrievalRepo = ReturnType<typeof createRetrievalRepo>;
