// Project indexer: walks the project tree, reads files, chunks content,
// embeds chunks (via the caller-supplied embedder), and writes the
// resulting rows to SQLite. The Qdrant upsert is performed by the
// retrieval-engine QdrantClient so dimension validation and safe
// fallback both live next to the rest of the retrieval logic.

import type { DatabaseSync } from "node:sqlite";
import { normalize, relative, resolve } from "node:path";
import { qdrantPointForChunk, syncSearchIndexForFile, type QdrantClient, type QdrantPoint } from "../../retrieval-engine/src/index.ts";
import { createId } from "../../shared/src/index.ts";
import { chunkContent, hashContent, isFileSizeIndexable } from "./chunk.ts";
import { inferLanguage, isProbablyTextFile, isReadableFile, safeReadText, walkFiles } from "./walk.ts";

export interface IndexFileResult {
  path: string;
  chunksIndexed: number;
  bytes: number;
  contentHash: string;
  reused: boolean;
}

export interface IndexProjectResult {
  filesIndexed: number;
  chunksIndexed: number;
  qdrantFailed: boolean;
  reusedFiles: number;
  changedFiles: number;
}

export type IndexEmbeddingBatcher = (input: string[]) => Promise<{
  embeddings: number[][];
  dimensions: number;
  modelName: string;
  providerId: string;
}>;

export interface IndexProjectOptions {
  db: DatabaseSync;
  projectId: string;
  projectPath: string;
  qdrant: QdrantClient | null;
  embedBatch: IndexEmbeddingBatcher;
  embeddingModel: string;
  embeddingProvider: string;
  embeddingDimension: number;
  language?: string | null;
  onWarning?: (warning: { kind: string; path: string; detail: string }) => void;
  onProgress?: (progress: { filesIndexed: number; chunksIndexed: number }) => void;
}

interface ExistingFileRow {
  id: string;
  content_hash: string;
  is_indexed: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function readExistingFile(db: DatabaseSync, projectId: string, path: string): ExistingFileRow | null {
  try {
    const row = db
      .prepare("SELECT id, content_hash, is_indexed FROM files WHERE project_id = ? AND path = ? LIMIT 1")
      .get(projectId, path) as ExistingFileRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

export async function indexProject(options: IndexProjectOptions): Promise<IndexProjectResult> {
  const { db, projectId, projectPath, qdrant, embedBatch, embeddingModel, embeddingProvider, embeddingDimension, onWarning, onProgress } = options;
  const files = await walkFiles(projectPath);
  const ts = nowIso();
  const upsertFile = db.prepare(
    `INSERT INTO files (
      id, project_id, path, language, size_bytes, content_hash, is_indexed, is_generated, last_seen_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, path) DO UPDATE SET
      language = excluded.language,
      size_bytes = excluded.size_bytes,
      content_hash = excluded.content_hash,
      is_indexed = excluded.is_indexed,
      is_generated = excluded.is_generated,
      last_seen_at = excluded.last_seen_at,
      updated_at = excluded.updated_at`,
  );
  const upsertDocument = db.prepare(
    `INSERT INTO rag_documents (
      id, project_id, file_id, path, content_hash, chunk_count, indexed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, path) DO UPDATE SET
      file_id = excluded.file_id,
      content_hash = excluded.content_hash,
      chunk_count = excluded.chunk_count,
      indexed_at = excluded.indexed_at,
      updated_at = excluded.updated_at`,
  );
  const deleteChunks = db.prepare("DELETE FROM rag_chunks WHERE document_id = ?");
  const insertChunk = db.prepare(
    `INSERT INTO rag_chunks (
      id, project_id, document_id, chunk_index, content, content_hash, start_line, end_line, token_count,
      embedding_id, metadata_json, created_at, embedding_model, embedding_dim, embedding_provider
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const qdrantPoints: QdrantPoint[] = [];

  let filesIndexed = 0;
  let chunksIndexed = 0;
  let qdrantFailed = false;
  let reusedFiles = 0;
  let changedFiles = 0;

  for (const filePath of files) {
    const absolutePath = resolve(filePath);
    if (!(await isReadableFile(absolutePath))) {
      continue;
    }
    const content = await safeReadText(absolutePath);
    const byteLength = content == null ? 0 : new TextEncoder().encode(content).length;
    if (content == null || !isFileSizeIndexable(byteLength) || !isProbablyTextFile(absolutePath)) {
      continue;
    }

    const contentHash = hashContent(content);
    const fileId = createId("file");
    const documentId = createId("doc");
    const relativePath = normalize(relative(projectPath, absolutePath));
    const language = inferLanguage(relativePath);
    const previous = readExistingFile(db, projectId, relativePath);
    if (previous && previous.content_hash === contentHash && previous.is_indexed === 1) {
      reusedFiles += 1;
      filesIndexed += 1;
      continue;
    }
    changedFiles += 1;
    const chunks = chunkContent(content);
    const indexedChunks: Array<{ id: string; content: string }> = [];

    upsertFile.run(fileId, projectId, relativePath, language, byteLength, contentHash, 1, 0, ts, ts, ts);
    upsertDocument.run(documentId, projectId, fileId, relativePath, contentHash, chunks.length, ts, ts, ts);
    deleteChunks.run(documentId);

    const embeddingInput = chunks.map((chunk) => `${relativePath}\n${chunk.content}`);
    const embeddingResult = embeddingInput.length > 0
      ? await embedBatch(embeddingInput)
      : { embeddings: [], dimensions: 0, modelName: "none", providerId: "none" };
    if (embeddingResult.dimensions > 0 && embeddingResult.dimensions !== embeddingDimension) {
      onWarning?.({
        kind: "embedding-dimension-mismatch",
        path: relativePath,
        detail: `embedder reported dim=${embeddingResult.dimensions}, expected=${embeddingDimension}`,
      });
    }

    chunks.forEach((chunk, index) => {
      const chunkId = createId("chunk");
      const chunkHash = hashContent(`${relativePath}\n${chunk.content}\n${chunk.startLine}\n${chunk.endLine}`);
      const vector = embeddingResult.embeddings[index] ?? [];
      insertChunk.run(
        chunkId,
        projectId,
        documentId,
        index,
        chunk.content,
        chunkHash,
        chunk.startLine,
        chunk.endLine,
        chunk.tokenCount,
        null,
        JSON.stringify({
          path: relativePath,
          language,
          embedding: {
            model: embeddingResult.modelName,
            dimensions: embeddingResult.dimensions,
            provider: embeddingResult.providerId,
          },
        }),
        ts,
        embeddingResult.modelName,
        embeddingResult.dimensions || null,
        embeddingResult.providerId,
      );
      indexedChunks.push({ id: chunkId, content: chunk.content });
      if (qdrant && vector.length > 0) {
        qdrantPoints.push(
          qdrantPointForChunk(
            projectId,
            documentId,
            relativePath,
            {
              id: chunkId,
              content: chunk.content,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              tokenCount: chunk.tokenCount,
            },
            language,
            vector,
          ),
        );
      }
      chunksIndexed += 1;
    });
    syncSearchIndexForFile(db, projectId, relativePath, indexedChunks);
    filesIndexed += 1;
    onProgress?.({ filesIndexed, chunksIndexed });
  }

  if (qdrant && qdrantPoints.length > 0) {
    const result = qdrant.upsert(qdrantPoints);
    if (!result.ok) {
      qdrantFailed = true;
      onWarning?.({
        kind: "qdrant-upsert-failed",
        path: qdrant.collectionName(),
        detail: result.detail,
      });
    }
  }

  db.prepare("UPDATE projects SET status = ?, last_indexed_at = ?, updated_at = ? WHERE id = ?").run("ready", ts, ts, projectId);
  return { filesIndexed, chunksIndexed, qdrantFailed, reusedFiles, changedFiles };
}
