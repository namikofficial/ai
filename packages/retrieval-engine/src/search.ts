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

export interface SearchProjectChunksInput {
  db: DatabaseSync;
  projectId: string;
  query: string;
  limit: number;
  qdrantSettings: QdrantRuntimeSettings | null;
  queryVectorDimension?: number;
}

export function searchProjectChunks(input: SearchProjectChunksInput): RetrievalChunk[] {
  const normalizedQuery = input.query.trim();
  const limit = input.limit;
  const candidates = new Map<string, RetrievalChunk>();
  const addCandidates = (chunks: RetrievalChunk[]) => {
    for (const chunk of chunks) {
      const existing = candidates.get(chunk.id);
      if (!existing || chunk.score > existing.score) {
        candidates.set(chunk.id, chunk);
      }
    }
  };

  if (normalizedQuery.length > 0 && input.qdrantSettings) {
    const qdrantChunks = searchQdrantChunksSync(
      input.qdrantSettings,
      input.projectId,
      embedQueryForQdrant({ text: normalizedQuery, dimension: input.queryVectorDimension ?? 32 }),
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

  return Array.from(candidates.values())
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}
