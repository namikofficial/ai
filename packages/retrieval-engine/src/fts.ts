// SQLite FTS5 adapter for local full-text retrieval.
//
// This module is the dedicated owner of the optional `rag_chunks_fts`
// virtual table. It exposes:
//   - one-time enable / probe of FTS5 (best-effort, never throws)
//   - per-file sync that replaces stale rows
//   - BM25-ranked search that joins back to `rag_chunks`
//
// The DB layer keeps ownership of the schema; this module only manipulates
// the virtual table and never changes anything outside it.

import type { DatabaseSync } from "node:sqlite";
import type { RetrievalChunk } from "../../shared/src/index.ts";
import { rankChunk } from "./index.ts";

// Re-use row helpers from search.ts so there is one canonical implementation
import { asString, safeParseJson, toNumber } from "./search.ts";

type Row = Record<string, unknown>;

export function tryEnableSearchIndex(db: DatabaseSync): boolean {
  try {
    db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunks_fts USING fts5(chunk_id UNINDEXED, project_id UNINDEXED, path, content)"
    );
    return true;
  } catch {
    return false;
  }
}

export function syncSearchIndexForFile(
  db: DatabaseSync,
  projectId: string,
  path: string,
  chunks: Array<{ id: string; content: string }>
): void {
  try {
    db.prepare("DELETE FROM rag_chunks_fts WHERE project_id = ? AND path = ?").run(projectId, path);
    const insertSearchRow = db.prepare(
      "INSERT INTO rag_chunks_fts (chunk_id, project_id, path, content) VALUES (?, ?, ?, ?)"
    );
    for (const chunk of chunks) {
      insertSearchRow.run(chunk.id, projectId, path, chunk.content);
    }
  } catch {
    // FTS is optional. When unavailable, the heuristic search path remains active.
  }
}

export function ftsSearch(
  db: DatabaseSync,
  projectId: string,
  ftsQuery: string,
  limit: number,
  heuristicRanker: (
    query: string,
    path: string,
    content: string,
    startLine: number,
    endLine: number
  ) => number = rankChunk
): RetrievalChunk[] {
  try {
    const rows = db
      .prepare(
        `SELECT
          c.*,
          (100 - bm25(rag_chunks_fts)) AS fts_score
         FROM rag_chunks_fts
         JOIN rag_chunks c ON c.id = rag_chunks_fts.chunk_id
         WHERE rag_chunks_fts MATCH ? AND c.project_id = ?
         ORDER BY bm25(rag_chunks_fts) ASC
         LIMIT ?`
      )
      .all(ftsQuery, projectId, limit * 3) as Row[];
    return rows
      .map((row) => {
        const content = asString(row.content);
        const metadata = safeParseJson(asString(row.metadata_json));
        const path = asString(row.path) || asString(metadata.path);
        const heuristicScore = heuristicRanker(
          ftsQuery,
          path,
          content,
          toNumber(row.start_line),
          toNumber(row.end_line)
        );
        const ftsScore = toNumber(row.fts_score);
        return {
          id: asString(row.id),
          projectId: asString(row.project_id),
          documentId: asString(row.document_id),
          path,
          content,
          startLine: toNumber(row.start_line),
          endLine: toNumber(row.end_line),
          tokenCount: toNumber(row.token_count),
          score: ftsScore + heuristicScore,
          metadata,
        } satisfies RetrievalChunk;
      })
      .filter((chunk) => chunk.score > 0)
      .sort((left, right) => right.score - left.score);
  } catch {
    return [];
  }
}
