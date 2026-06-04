import type { DatabaseSync } from "node:sqlite";
import type { RetrievalChunk } from "../../shared/src/index.ts";
import { ftsSearch } from "./fts.ts";
import { embedQueryForQdrant, searchQdrantChunksSync, type QdrantRuntimeSettings } from "./qdrant.ts";

function tokenize(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9_]+/g)
        .filter((term) => term.length >= 3),
    ),
  );
}

function buildFtsQuery(question: string): string | null {
  const terms = tokenize(question);
  if (terms.length === 0) {
    return null;
  }
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

function rankChunk(
  question: string,
  path: string,
  content: string,
  startLine: number,
  endLine: number,
): number {
  const haystack = `${path}\n${content}`.toLowerCase();
  const terms = tokenize(question);
  let score = 0;
  if (question.trim().length > 0 && haystack.includes(question.toLowerCase().trim())) {
    score += 5;
  }
  for (const term of terms) {
    if (haystack.includes(term)) {
      score += term.length >= 6 ? 3 : 1;
    }
  }
  const pathParts = path.toLowerCase().split(/[^a-z0-9]+/g).filter(Boolean);
  for (const term of terms) {
    if (pathParts.includes(term)) {
      score += 2;
    }
  }
  if (terms.some((term) => pathParts.some((part) => part.startsWith(term) || term.startsWith(part)))) {
    score += 1;
  }
  if (/auth|login|session|token/i.test(path)) score += 2;
  if (/test|spec/i.test(path)) score += 1;
  if (/readme|docs?|notes?/i.test(path)) score += 1;
  if (/index|overview|summary/i.test(path)) score += 0.5;
  if (terms.some((term) => content.toLowerCase().includes(`${term}(`) || content.toLowerCase().includes(`${term} `))) {
    score += 1;
  }
  if (content.split("\n")[0]?.toLowerCase().includes(terms[0] ?? "")) {
    score += 0.5;
  }
  score += Math.max(0, 5 - Math.min(5, Math.abs(endLine - startLine) / 40));
  return score;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.length > 0) return Number(value);
  return 0;
}

function safeParseJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function safeParseArray(value: unknown): unknown[] {
  if (typeof value !== "string" || value.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toNumberOrZero(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.length > 0) return Number(value);
  return 0;
}

function scoreSymbolRow(query: string, row: Record<string, unknown>): number {
  const terms = tokenize(query);
  const lowered = query.toLowerCase();
  const path = asString(row.path);
  const name = asString(row.name);
  const qualifiedName = asString(row.qualified_name);
  const kind = asString(row.kind);
  const haystack = `${path}\n${name}\n${qualifiedName}\n${kind}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) {
      score += term.length >= 6 ? 3 : 1.5;
    }
  }
  if (lowered.includes(name.toLowerCase()) || lowered.includes(qualifiedName.toLowerCase())) {
    score += 4;
  }
  if (/auth|session|jwt|tenant/.test(lowered) && /auth|session|jwt|tenant/i.test(haystack)) {
    score += 3;
  }
  if (/where is|how is|how does|what calls|handled|used/i.test(lowered) && /route|middleware|function|class|method|import/i.test(kind)) {
    score += 1;
  }
  if (/test|spec/i.test(path) && /test|spec/.test(lowered)) {
    score += 1.5;
  }
  return score;
}

function selectTopSymbolChunks(db: DatabaseSync, projectId: string, query: string, limit: number): RetrievalChunk[] {
  if (query.trim().length === 0) return [];
  try {
    const symbolRows = db
      .prepare(
        `SELECT id, path, language, kind, name, qualified_name, start_line, end_line, signature, doc, metadata_json
         FROM code_symbols
         WHERE project_id = ?`,
      )
      .all(projectId) as Array<Record<string, unknown>>;
    const scoredSymbols = symbolRows
      .map((row) => ({
        row,
        score: scoreSymbolRow(query, row),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(6, limit));
    const symbolIds = new Set(scoredSymbols.map((entry) => asString(entry.row.id)));
    const chunks: RetrievalChunk[] = [];
    const chunkRows = db.prepare(
      `SELECT cs.symbol_id, cs.overlap_lines, c.*
       FROM code_symbol_chunks cs
       JOIN rag_chunks c ON c.id = cs.chunk_id
       WHERE cs.project_id = ? AND cs.symbol_id = ? AND c.project_id = ?
       ORDER BY cs.overlap_lines DESC, c.start_line ASC`,
    );
    const edgeRows = db.prepare(
      `SELECT * FROM code_edges
       WHERE project_id = ? AND (from_symbol_id = ? OR to_symbol_id = ?)`,
    );
    for (const symbolEntry of scoredSymbols) {
      const symbol = symbolEntry.row;
      const symbolId = asString(symbol.id);
      const symbolMetadata = safeParseJson(asString(symbol.metadata_json));
      const symbolChunkRows = chunkRows.all(projectId, symbolId, projectId) as Array<Record<string, unknown>>;
      for (const row of symbolChunkRows) {
        const content = asString(row.content);
        const metadata = safeParseJson(asString(row.metadata_json));
        const path = asString(row.path) || asString(metadata.path);
        const chunkScore = rankChunk(query, path, content, toNumberOrZero(row.start_line), toNumberOrZero(row.end_line));
        chunks.push({
          id: asString(row.id),
          projectId: asString(row.project_id),
          documentId: asString(row.document_id),
          path,
          content,
          startLine: toNumberOrZero(row.start_line),
          endLine: toNumberOrZero(row.end_line),
          tokenCount: toNumberOrZero(row.token_count),
          score: chunkScore + symbolEntry.score + (toNumberOrZero(row.overlap_lines) / 10),
          metadata: {
            ...metadata,
            codeSymbols: [
              {
                id: symbolId,
                kind: asString(symbol.kind),
                name: asString(symbol.name),
                qualifiedName: asString(symbol.qualified_name),
                signature: symbol.signature == null ? null : asString(symbol.signature),
                metadata: symbolMetadata,
              },
            ],
            symbolMatch: {
              symbolId,
              score: symbolEntry.score,
            },
          },
        });
      }

      const incomingEdges = edgeRows.all(projectId, symbolId, symbolId) as Array<Record<string, unknown>>;
      for (const edge of incomingEdges) {
        const otherId = asString(edge.from_symbol_id) === symbolId ? asString(edge.to_symbol_id) : asString(edge.from_symbol_id);
        if (!otherId) continue;
        const target = symbolRows.find((row) => asString(row.id) === otherId);
        if (!target) continue;
        const targetChunks = chunkRows.all(projectId, otherId, projectId) as Array<Record<string, unknown>>;
        for (const row of targetChunks.slice(0, 2)) {
          const content = asString(row.content);
          const metadata = safeParseJson(asString(row.metadata_json));
          const path = asString(row.path) || asString(metadata.path);
          const chunkScore = rankChunk(query, path, content, toNumberOrZero(row.start_line), toNumberOrZero(row.end_line));
          chunks.push({
            id: asString(row.id),
            projectId: asString(row.project_id),
            documentId: asString(row.document_id),
            path,
            content,
            startLine: toNumberOrZero(row.start_line),
            endLine: toNumberOrZero(row.end_line),
            tokenCount: toNumberOrZero(row.token_count),
            score: chunkScore + (symbolEntry.score * 0.5) + toNumberOrZero(edge.confidence ?? 0),
            metadata: {
              ...metadata,
              graphExpansion: {
                fromSymbolId: symbolId,
                toSymbolId: otherId,
                kind: asString(edge.kind),
                confidence: toNumberOrZero(edge.confidence),
              },
            },
          });
        }
      }
    }
    return chunks;
  } catch {
    return [];
  }
}

export interface SearchProjectChunksInput {
  db: DatabaseSync;
  projectId: string;
  query: string;
  limit: number;
  qdrantSettings: QdrantRuntimeSettings | null;
  queryVectorDimension?: number;
  queryVector?: number[] | null;
}

export function searchProjectChunks(input: SearchProjectChunksInput): RetrievalChunk[] {
  const normalizedQuery = input.query.trim();
  const limit = input.limit;
  const candidates = new Map<string, RetrievalChunk>();
  const addCandidates = (chunks: RetrievalChunk[]) => {
    for (const chunk of chunks) {
      const existing = candidates.get(chunk.id);
      if (!existing) {
        candidates.set(chunk.id, chunk);
        continue;
      }
      const score = Math.max(existing.score, chunk.score);
      const existingMetadata = existing.metadata as Record<string, unknown>;
      const chunkMetadata = chunk.metadata as Record<string, unknown>;
      candidates.set(chunk.id, {
        ...existing,
        ...chunk,
        score,
        metadata: {
          ...existingMetadata,
          ...chunkMetadata,
          graphExpansion: existingMetadata.graphExpansion ?? chunkMetadata.graphExpansion ?? null,
          symbolMatch: existingMetadata.symbolMatch ?? chunkMetadata.symbolMatch ?? null,
        },
      });
    }
  };

  if (normalizedQuery.length > 0 && input.qdrantSettings) {
    const queryVector = input.queryVector ?? embedQueryForQdrant({ text: normalizedQuery, dimension: input.queryVectorDimension ?? 32 });
    const qdrantChunks = searchQdrantChunksSync(
      input.qdrantSettings,
      input.projectId,
      queryVector,
      limit,
    );
    if (qdrantChunks) {
      addCandidates(qdrantChunks);
    }
  }

  const ftsQuery = normalizedQuery.length > 0 ? buildFtsQuery(normalizedQuery) : null;
  if (ftsQuery) {
    const ftsChunks = ftsSearch(input.db, input.projectId, ftsQuery, limit, rankChunk);
    addCandidates(ftsChunks);
  }

  if (normalizedQuery.length === 0) {
    try {
      const rows = input.db
        .prepare("SELECT * FROM rag_chunks WHERE project_id = ? ORDER BY created_at DESC LIMIT 500")
        .all(input.projectId) as Array<Record<string, unknown>>;
      const scored = rows
        .map((row) => {
          const content = asString(row.content);
          const metadata = safeParseJson(asString(row.metadata_json));
          const path = asString(row.path) || asString(metadata.path);
          return {
            id: asString(row.id),
            projectId: asString(row.project_id),
            documentId: asString(row.document_id),
            path,
            content,
            startLine: toNumber(row.start_line),
            endLine: toNumber(row.end_line),
            tokenCount: toNumber(row.token_count),
            score: 1,
            metadata,
          } satisfies RetrievalChunk;
        })
        .sort((left, right) => right.score - left.score);
      addCandidates(scored);
    } catch {
      // Keep the empty-query heuristic best-effort.
    }
  } else if (candidates.size === 0) {
    try {
      const rows = input.db
        .prepare(
          `SELECT
            c.*,
            (100 - bm25(rag_chunks_fts)) AS fts_score
           FROM rag_chunks_fts
           JOIN rag_chunks c ON c.id = rag_chunks_fts.chunk_id
           WHERE c.project_id = ?
           ORDER BY bm25(rag_chunks_fts) ASC
           LIMIT ?`,
        )
        .all(input.projectId, limit * 4) as Array<Record<string, unknown>>;
      const scored = rows
        .map((row) => {
          const content = asString(row.content);
          const metadata = safeParseJson(asString(row.metadata_json));
          const path = asString(row.path) || asString(metadata.path);
          const heuristicScore = rankChunk(normalizedQuery, path, content, toNumber(row.start_line), toNumber(row.end_line));
          return {
            id: asString(row.id),
            projectId: asString(row.project_id),
            documentId: asString(row.document_id),
            path,
            content,
            startLine: toNumber(row.start_line),
            endLine: toNumber(row.end_line),
            tokenCount: toNumber(row.token_count),
            score: heuristicScore,
            metadata,
          } satisfies RetrievalChunk;
        })
        .filter((chunk) => chunk.score > 0)
        .sort((left, right) => right.score - left.score);
      addCandidates(scored);
    } catch {
      // Keep the search best-effort: if the fallback path fails, return what we have.
    }
  }

  const symbolChunks = selectTopSymbolChunks(input.db, input.projectId, normalizedQuery, limit);
  addCandidates(symbolChunks);

  return Array.from(candidates.values())
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}
