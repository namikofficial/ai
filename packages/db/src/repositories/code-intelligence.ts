import type { DatabaseSync } from "node:sqlite";
import type { CodeEdgeRecord, CodeSymbolRecord } from "../../../shared/src/index.ts";
import { asNumber, asString, asStringOrNull, now, newId, safeParseJson } from "./_shared.ts";

interface CodeSymbolRow {
  id: string;
  project_id: string;
  file_id: string;
  path: string;
  language: string | null;
  kind: string;
  name: string;
  qualified_name: string;
  start_line: number;
  end_line: number;
  signature: string | null;
  doc: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

interface CodeEdgeRow {
  id: string;
  project_id: string;
  from_symbol_id: string;
  to_symbol_id: string;
  kind: string;
  confidence: number;
  metadata_json: string;
  created_at: string;
}

interface CodeSymbolChunkRow {
  id: string;
  project_id: string;
  file_id: string;
  symbol_id: string;
  chunk_id: string;
  start_line: number;
  end_line: number;
  overlap_lines: number;
  created_at: string;
}

function rowToSymbol(row: CodeSymbolRow): CodeSymbolRecord {
  return {
    id: asString(row.id),
    projectId: asString(row.project_id),
    fileId: asString(row.file_id),
    path: asString(row.path),
    language: asStringOrNull(row.language),
    kind: asString(row.kind) as CodeSymbolRecord["kind"],
    name: asString(row.name),
    qualifiedName: asString(row.qualified_name),
    startLine: asNumber(row.start_line),
    endLine: asNumber(row.end_line),
    signature: asStringOrNull(row.signature),
    doc: asStringOrNull(row.doc),
    metadata: safeParseJson<Record<string, unknown>>(asString(row.metadata_json)),
  };
}

function rowToEdge(row: CodeEdgeRow): CodeEdgeRecord {
  return {
    id: asString(row.id),
    projectId: asString(row.project_id),
    fromSymbolId: asString(row.from_symbol_id),
    toSymbolId: asString(row.to_symbol_id),
    kind: asString(row.kind) as CodeEdgeRecord["kind"],
    confidence: asNumber(row.confidence),
    metadata: safeParseJson<Record<string, unknown>>(asString(row.metadata_json)),
  };
}

export function createCodeIntelligenceRepo(db: DatabaseSync) {
  return {
    replaceFileSymbols(
      projectId: string,
      fileId: string,
      path: string,
      symbols: CodeSymbolRecord[],
      edges: CodeEdgeRecord[],
      symbolChunkLinks: Array<{ symbolId: string; chunkId: string; startLine: number; endLine: number; overlapLines: number }>,
    ): void {
      const existingIds = db
        .prepare("SELECT id FROM code_symbols WHERE project_id = ? AND file_id = ?")
        .all(projectId, fileId) as Array<{ id: string }>;
      const oldIds = existingIds.map((row) => row.id);
      db.prepare("DELETE FROM code_symbol_chunks WHERE project_id = ? AND file_id = ?").run(projectId, fileId);
      db.prepare("DELETE FROM code_symbols WHERE project_id = ? AND file_id = ?").run(projectId, fileId);
      if (oldIds.length > 0) {
        const placeholders = oldIds.map(() => "?").join(", ");
        db.prepare(
          `DELETE FROM code_edges
           WHERE project_id = ?
             AND (from_symbol_id IN (${placeholders}) OR to_symbol_id IN (${placeholders}))`,
        ).run(projectId, ...oldIds, ...oldIds);
      }

      const ts = now();
      const insertSymbol = db.prepare(
        `INSERT INTO code_symbols (
          id, project_id, file_id, path, language, kind, name, qualified_name,
          start_line, end_line, signature, doc, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const symbol of symbols) {
        insertSymbol.run(
          symbol.id,
          projectId,
          fileId,
          path,
          symbol.language ?? null,
          symbol.kind,
          symbol.name,
          symbol.qualifiedName,
          symbol.startLine,
          symbol.endLine,
          symbol.signature ?? null,
          symbol.doc ?? null,
          JSON.stringify(symbol.metadata ?? {}),
          ts,
          ts,
        );
      }

      const insertEdge = db.prepare(
        `INSERT OR REPLACE INTO code_edges (
          id, project_id, from_symbol_id, to_symbol_id, kind, confidence, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const edge of edges) {
        insertEdge.run(
          edge.id,
          projectId,
          edge.fromSymbolId,
          edge.toSymbolId,
          edge.kind,
          edge.confidence,
          JSON.stringify(edge.metadata ?? {}),
          ts,
        );
      }

      const insertChunkLink = db.prepare(
        `INSERT OR REPLACE INTO code_symbol_chunks (
          id, project_id, file_id, symbol_id, chunk_id, start_line, end_line, overlap_lines, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const link of symbolChunkLinks) {
        insertChunkLink.run(
          newId("csl"),
          projectId,
          fileId,
          link.symbolId,
          link.chunkId,
          link.startLine,
          link.endLine,
          link.overlapLines,
          ts,
        );
      }
    },
    listSymbols(projectId: string, query?: string | null, limit = 50): CodeSymbolRecord[] {
      const trimmed = query?.trim() ?? "";
      if (trimmed.length === 0) {
        const rows = db
          .prepare("SELECT * FROM code_symbols WHERE project_id = ? ORDER BY path ASC, start_line ASC LIMIT ?")
          .all(projectId, limit) as CodeSymbolRow[];
        return rows.map(rowToSymbol);
      }
      const lowered = `%${trimmed.toLowerCase()}%`;
      const rows = db
        .prepare(
          `SELECT * FROM code_symbols
           WHERE project_id = ?
             AND (LOWER(name) LIKE ? OR LOWER(path) LIKE ? OR LOWER(qualified_name) LIKE ?)
           ORDER BY path ASC, start_line ASC
           LIMIT ?`,
        )
        .all(projectId, lowered, lowered, lowered, limit) as CodeSymbolRow[];
      return rows.map(rowToSymbol);
    },
    getSymbol(id: string): CodeSymbolRecord | null {
      const row = db.prepare("SELECT * FROM code_symbols WHERE id = ? LIMIT 1").get(id) as CodeSymbolRow | undefined;
      return row ? rowToSymbol(row) : null;
    },
    listSymbolChunks(symbolId: string): Array<{
      id: string;
      projectId: string;
      fileId: string;
      symbolId: string;
      chunkId: string;
      path: string;
      startLine: number;
      endLine: number;
      overlapLines: number;
      createdAt: string;
    }> {
      const rows = db
        .prepare(
          `SELECT csc.*, d.path AS path
           FROM code_symbol_chunks csc
           JOIN rag_chunks c ON c.id = csc.chunk_id
           JOIN rag_documents d ON d.id = c.document_id
           WHERE csc.symbol_id = ?
           ORDER BY csc.overlap_lines DESC, csc.start_line ASC`,
        )
        .all(symbolId) as Array<CodeSymbolChunkRow & { path: string }>;
      return rows.map((row) => ({
        id: asString(row.id),
        projectId: asString(row.project_id),
        fileId: asString(row.file_id),
        symbolId: asString(row.symbol_id),
        chunkId: asString(row.chunk_id),
        path: asString((row as CodeSymbolChunkRow & { path: string }).path),
        startLine: asNumber(row.start_line),
        endLine: asNumber(row.end_line),
        overlapLines: asNumber(row.overlap_lines),
        createdAt: asString(row.created_at),
      }));
    },
    listEdgesForSymbol(symbolId: string): CodeEdgeRecord[] {
      const rows = db
        .prepare("SELECT * FROM code_edges WHERE from_symbol_id = ? OR to_symbol_id = ? ORDER BY created_at ASC")
        .all(symbolId, symbolId) as CodeEdgeRow[];
      return rows.map(rowToEdge);
    },
  };
}

export type CodeIntelligenceRepo = ReturnType<typeof createCodeIntelligenceRepo>;
