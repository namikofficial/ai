// Project indexer: walks the project tree, reads files, chunks content,
// embeds chunks (via the caller-supplied embedder), and writes the
// resulting rows to SQLite. The Qdrant upsert is performed by the
// retrieval-engine QdrantClient so dimension validation and safe
// fallback both live next to the rest of the retrieval logic.

import { normalize, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  buildProjectContextGraph,
  type CodeChunkSpan,
  type CodeIntelligenceResult,
  extractCodeIntelligence,
  linkSymbolsToChunks,
  resolveLocalReference,
} from "../../code-intelligence/src/index.ts";
import {
  type QdrantClient,
  type QdrantPoint,
  qdrantPointForChunk,
  syncSearchIndexForFile,
} from "../../retrieval-engine/src/index.ts";
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
  projectConfig?: {
    ignore: string[];
    include: string[];
    chunking: { preferTreeSitter: boolean; maxChunkTokens: number };
    codeIntelligence: { enabled: boolean };
    retrieval: { boostPaths: string[]; authHints: string[] };
    models: { answer: string | null; embedding: string | null };
  } | null;
  qdrant: QdrantClient | null;
  embedBatch: IndexEmbeddingBatcher;
  embeddingModel: string;
  embeddingProvider: string;
  embeddingDimension: number;
  language?: string | null;
  onWarning?: (warning: { kind: string; path: string; detail: string }) => void;
  onProgress?: (progress: { filesIndexed: number; chunksIndexed: number }) => void;
  codeIntelligenceExtractor?: (input: Parameters<typeof extractCodeIntelligence>[0]) => CodeIntelligenceResult;
}

interface ExistingFileRow {
  id: string;
  path: string;
  content_hash: string;
  is_indexed: number;
}

interface ExistingDocumentRow {
  id: string;
  file_id: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function readExistingFile(db: DatabaseSync, projectId: string, path: string): ExistingFileRow | null {
  try {
    const row = db
      .prepare("SELECT id, path, content_hash, is_indexed FROM files WHERE project_id = ? AND path = ? LIMIT 1")
      .get(projectId, path) as ExistingFileRow | undefined;
    return row ?? null;
  } catch (error) {
    console.warn("[indexer] readExistingFile failed:", error instanceof Error ? error.message : String(error));
    return null;
  }
}

function readExistingDocument(db: DatabaseSync, projectId: string, path: string): ExistingDocumentRow | null {
  try {
    const row = db
      .prepare("SELECT id, file_id FROM rag_documents WHERE project_id = ? AND path = ? LIMIT 1")
      .get(projectId, path) as ExistingDocumentRow | undefined;
    return row ?? null;
  } catch (error) {
    console.warn("[indexer] readExistingDocument failed:", error instanceof Error ? error.message : String(error));
    return null;
  }
}

function globMatch(value: string, pattern: string): boolean {
  const normalized = pattern.replaceAll("\\", "/").trim();
  let regex = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized.charAt(index);
    const next = normalized[index + 1] ?? "";
    if (char === "*" && next === "*") {
      regex += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      regex += "[^/]*";
      continue;
    }
    regex += /[.+^${}()|[\]\\?]/.test(char) ? `\\${char}` : char;
  }
  regex += "$";
  return new RegExp(regex).test(value.replaceAll("\\", "/").replace(/^\.?\//, ""));
}

export async function indexProject(options: IndexProjectOptions): Promise<IndexProjectResult> {
  const { db, projectId, projectPath, projectConfig, qdrant, embedBatch, embeddingDimension, onWarning, onProgress } =
    options;
  const codeIntelligenceEnabled = projectConfig?.codeIntelligence?.enabled ?? false;
  const extractIntelligence = options.codeIntelligenceExtractor ?? extractCodeIntelligence;
  const files = (await walkFiles(projectPath)).filter((path) => {
    const normalized = normalize(relative(projectPath, path));
    const ignore = projectConfig?.ignore ?? [];
    const include = projectConfig?.include ?? [];
    const ignored = ignore.some((pattern) => globMatch(normalized, pattern));
    const included = include.length === 0 || include.some((pattern) => globMatch(normalized, pattern));
    return !ignored && included;
  });
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
      updated_at = excluded.updated_at`
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
      updated_at = excluded.updated_at`
  );
  const deleteChunks = db.prepare("DELETE FROM rag_chunks WHERE document_id = ?");
  const deleteSymbolLinks = db.prepare("DELETE FROM code_symbol_chunks WHERE project_id = ? AND file_id = ?");
  const deleteSymbols = db.prepare("DELETE FROM code_symbols WHERE project_id = ? AND file_id = ?");
  const insertSymbol = db.prepare(
    `INSERT INTO code_symbols (
      id, project_id, file_id, path, language, kind, name, qualified_name,
      start_line, end_line, signature, doc, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertEdge = db.prepare(
    `INSERT OR REPLACE INTO code_edges (
      id, project_id, from_symbol_id, to_symbol_id, kind, confidence, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertSymbolChunk = db.prepare(
    `INSERT INTO code_symbol_chunks (
      id, project_id, file_id, symbol_id, chunk_id, start_line, end_line, overlap_lines, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const upsertProjectGraph = db.prepare(
    `INSERT INTO project_context_graphs (project_id, summary_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET summary_json = excluded.summary_json, updated_at = excluded.updated_at`
  );
  const insertChunk = db.prepare(
    `INSERT INTO rag_chunks (
      id, project_id, document_id, chunk_index, content, content_hash, start_line, end_line, token_count,
      embedding_id, metadata_json, created_at, embedding_model, embedding_dim, embedding_provider
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const qdrantPoints: QdrantPoint[] = [];
  const seenPaths = new Set<string>();

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
    const relativePath = normalize(relative(projectPath, absolutePath));
    seenPaths.add(relativePath);
    const language = inferLanguage(relativePath);
    const previous = readExistingFile(db, projectId, relativePath);
    const previousDocument = readExistingDocument(db, projectId, relativePath);
    if (previous && previous.content_hash === contentHash && previous.is_indexed === 1) {
      reusedFiles += 1;
      filesIndexed += 1;
      continue;
    }
    const fileId = previous?.id ?? createId("file");
    const documentId = previousDocument?.id ?? createId("doc");
    changedFiles += 1;
    const maxChunkTokens = projectConfig?.chunking.maxChunkTokens ?? 900;
    const preferTreeSitter = projectConfig?.chunking.preferTreeSitter ?? true;
    const linesPerChunk = preferTreeSitter
      ? Math.max(20, Math.floor(maxChunkTokens / 10))
      : Math.max(24, Math.floor(maxChunkTokens / 12));
    const chunks = chunkContent(content, linesPerChunk);
    const chunkRows: Array<CodeChunkSpan & { id: string; content: string }> = chunks.map((chunk) => ({
      id: createId("chunk"),
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      tokenCount: chunk.tokenCount,
      content: chunk.content,
    }));
    const existingSymbolRows =
      codeIntelligenceEnabled && previous
        ? (db
            .prepare("SELECT id FROM code_symbols WHERE project_id = ? AND file_id = ?")
            .all(projectId, fileId) as Array<{ id: string }>)
        : [];
    if (existingSymbolRows.length > 0) {
      const oldIds = existingSymbolRows.map((row) => row.id);
      const placeholders = oldIds.map(() => "?").join(", ");
      deleteSymbolLinks.run(projectId, fileId);
      deleteSymbols.run(projectId, fileId);
      if (placeholders.length > 0) {
        db.prepare(
          `DELETE FROM code_edges WHERE project_id = ? AND (from_symbol_id IN (${placeholders}) OR to_symbol_id IN (${placeholders}))`
        ).run(projectId, ...oldIds, ...oldIds);
      }
    }
    let code: CodeIntelligenceResult | null = null;
    if (codeIntelligenceEnabled) {
      try {
        code = extractIntelligence(
          {
            projectId,
            fileId,
            path: relativePath,
            language,
            content,
          },
          { deepGraph: preferTreeSitter }
        );
      } catch (error) {
        code = null;
        onWarning?.({
          kind: "code-intelligence-failed",
          path: relativePath,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const chunkLinks = code
      ? linkSymbolsToChunks(code.symbols, chunkRows)
      : {
          links: [],
          metadataByChunkId: new Map<
            string,
            Array<{
              id: string;
              kind: string;
              name: string;
              qualifiedName: string;
              signature: string | null;
              confidence: number;
            }>
          >(),
        };
    deleteChunks.run(documentId);

    upsertFile.run(fileId, projectId, relativePath, language, byteLength, contentHash, 1, 0, ts, ts, ts);
    upsertDocument.run(documentId, projectId, fileId, relativePath, contentHash, chunks.length, ts, ts, ts);

    if (code) {
      for (const symbol of code.symbols) {
        insertSymbol.run(
          symbol.id,
          projectId,
          fileId,
          relativePath,
          symbol.language,
          symbol.kind,
          symbol.name,
          symbol.qualifiedName,
          symbol.startLine,
          symbol.endLine,
          symbol.signature,
          symbol.doc,
          JSON.stringify(symbol.metadata),
          ts,
          ts
        );
      }
      for (const edge of code.edges) {
        insertEdge.run(
          edge.id,
          projectId,
          edge.fromSymbolId,
          edge.toSymbolId,
          edge.kind,
          edge.confidence,
          JSON.stringify(edge.metadata),
          ts
        );
      }
    }

    const embeddingInput = chunks.map((chunk) => `${relativePath}\n${chunk.content}`);
    const embeddingResult =
      embeddingInput.length > 0
        ? await embedBatch(embeddingInput)
        : { embeddings: [], dimensions: 0, modelName: "none", providerId: "none" };
    if (embeddingResult.dimensions > 0 && embeddingResult.dimensions !== embeddingDimension) {
      onWarning?.({
        kind: "embedding-dimension-mismatch",
        path: relativePath,
        detail: `embedder reported dim=${embeddingResult.dimensions}, expected=${embeddingDimension}`,
      });
    }

    chunkRows.forEach((chunk, index) => {
      const chunkHash = hashContent(`${relativePath}\n${chunk.content}\n${chunk.startLine}\n${chunk.endLine}`);
      const vector = embeddingResult.embeddings[index] ?? [];
      const symbolMetadata = chunkLinks.metadataByChunkId.get(chunk.id) ?? [];
      insertChunk.run(
        chunk.id,
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
          codeSymbols: symbolMetadata,
          codeSymbolIds: symbolMetadata.map((symbol) => symbol.id),
        }),
        ts,
        embeddingResult.modelName,
        embeddingResult.dimensions || null,
        embeddingResult.providerId
      );
      if (code) {
        for (const symbol of code.symbols) {
          if (chunkLinks.links.some((link) => link.symbolId === symbol.id && link.chunkId === chunk.id)) {
            const overlaps = chunkLinks.links.filter(
              (link) => link.symbolId === symbol.id && link.chunkId === chunk.id
            );
            insertSymbolChunk.run(
              createId("cs"),
              projectId,
              fileId,
              symbol.id,
              chunk.id,
              chunk.startLine,
              chunk.endLine,
              overlaps[0]?.overlapLines ?? 0,
              ts
            );
          }
        }
      }
      if (qdrant && vector.length > 0) {
        qdrantPoints.push(
          qdrantPointForChunk(
            projectId,
            documentId,
            relativePath,
            {
              id: chunk.id,
              content: chunk.content,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              tokenCount: chunk.tokenCount,
            },
            language,
            vector
          )
        );
      }
      chunksIndexed += 1;
    });
    const indexedChunks = chunkRows.map((chunk) => ({ id: chunk.id, content: chunk.content }));
    syncSearchIndexForFile(db, projectId, relativePath, indexedChunks);
    filesIndexed += 1;
    onProgress?.({ filesIndexed, chunksIndexed });
  }

  const staleFileRows = db.prepare("SELECT id, path FROM files WHERE project_id = ?").all(projectId) as Array<{
    id: string;
    path: string;
  }>;
  const staleFiles = staleFileRows.filter((row) => !seenPaths.has(row.path));
  if (staleFiles.length > 0) {
    const deleteSearchRows = (path: string) => {
      try {
        db.prepare("DELETE FROM rag_chunks_fts WHERE project_id = ? AND path = ?").run(projectId, path);
      } catch {
        // FTS is optional.
      }
    };
    for (const staleFile of staleFiles) {
      const documentRows = db
        .prepare("SELECT id FROM rag_documents WHERE project_id = ? AND file_id = ?")
        .all(projectId, staleFile.id) as Array<{ id: string }>;
      const symbolRows = db
        .prepare("SELECT id FROM code_symbols WHERE project_id = ? AND file_id = ?")
        .all(projectId, staleFile.id) as Array<{ id: string }>;
      const symbolIds = symbolRows.map((row) => row.id);
      if (symbolIds.length > 0) {
        const placeholders = symbolIds.map(() => "?").join(", ");
        db.prepare("DELETE FROM code_symbol_chunks WHERE project_id = ? AND file_id = ?").run(projectId, staleFile.id);
        db.prepare("DELETE FROM code_symbols WHERE project_id = ? AND file_id = ?").run(projectId, staleFile.id);
        db.prepare(
          `DELETE FROM code_edges
           WHERE project_id = ?
             AND (from_symbol_id IN (${placeholders}) OR to_symbol_id IN (${placeholders}))`
        ).run(projectId, ...symbolIds, ...symbolIds);
      }
      for (const documentRow of documentRows) {
        db.prepare("DELETE FROM rag_chunks WHERE document_id = ?").run(documentRow.id);
      }
      db.prepare("DELETE FROM rag_documents WHERE project_id = ? AND file_id = ?").run(projectId, staleFile.id);
      db.prepare("DELETE FROM files WHERE project_id = ? AND id = ?").run(projectId, staleFile.id);
      deleteSearchRows(staleFile.path);
    }
  }

  try {
    if (codeIntelligenceEnabled) {
      const importRows = db
        .prepare("SELECT id, path, metadata_json FROM code_symbols WHERE project_id = ? AND kind = 'import'")
        .all(projectId) as Array<Record<string, unknown>>;
      const targetRows = db
        .prepare(
          "SELECT id, path, name, qualified_name, kind FROM code_symbols WHERE project_id = ? AND kind != 'import'"
        )
        .all(projectId) as Array<Record<string, unknown>>;
      for (const importRow of importRows) {
        const sourcePath = String(importRow.path);
        const metadata = JSON.parse(String(importRow.metadata_json || "{}")) as Record<string, unknown>;
        const modulePath = String(metadata.modulePath ?? metadata.imported ?? "");
        const resolvedPath = resolveLocalReference(sourcePath, modulePath);
        if (!resolvedPath) continue;
        const importedNames = String(metadata.imported ?? "")
          .split(/[^A-Za-z0-9_$]+/g)
          .filter((token) => token.length > 0);
        const targetForPath = targetRows.filter((row) => String(row.path) === resolvedPath);
        if (targetForPath.length === 0) continue;
        const bestTarget =
          importedNames.length > 0
            ? (targetForPath.find((row) => importedNames.includes(String(row.name))) ??
              targetForPath.find((row) => importedNames.some((name) => String(row.qualified_name).includes(name))) ??
              targetForPath[0])
            : targetForPath[0];
        if (!bestTarget) continue;
        insertEdge.run(
          createId("edge"),
          projectId,
          String(importRow.id),
          String(bestTarget.id),
          "imports",
          0.8,
          JSON.stringify({ modulePath, resolvedPath, sourcePath }),
          ts
        );
      }
    }
  } catch {
    // Import resolution is best-effort and should never block indexing.
  }

  try {
    const symbolRows = db
      .prepare(
        "SELECT id, project_id, file_id, path, language, kind, name, qualified_name, start_line, end_line, signature, doc, metadata_json FROM code_symbols WHERE project_id = ?"
      )
      .all(projectId) as Array<Record<string, unknown>>;
    const symbols = symbolRows.map((row) => ({
      id: String(row.id),
      projectId: String(row.project_id),
      fileId: String(row.file_id),
      path: String(row.path),
      language: row.language == null ? null : String(row.language),
      kind: String(row.kind) as
        | "function"
        | "class"
        | "method"
        | "interface"
        | "type"
        | "import"
        | "route"
        | "middleware"
        | "constant"
        | "unknown",
      name: String(row.name),
      qualifiedName: String(row.qualified_name),
      startLine: Number(row.start_line),
      endLine: Number(row.end_line),
      signature: row.signature == null ? null : String(row.signature),
      doc: row.doc == null ? null : String(row.doc),
      metadata: JSON.parse(String(row.metadata_json || "{}")) as Record<string, unknown>,
    }));
    const paths = db.prepare("SELECT path FROM files WHERE project_id = ?").all(projectId) as Array<{ path: string }>;
    const graph = buildProjectContextGraph({
      projectId,
      symbols,
      paths: paths.map((row) => row.path),
      updatedAt: ts,
    });
    upsertProjectGraph.run(projectId, JSON.stringify(graph), ts);
  } catch {
    // The graph is best-effort; indexing must still complete without it.
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

  db.prepare("UPDATE projects SET status = ?, last_indexed_at = ?, updated_at = ? WHERE id = ?").run(
    "ready",
    ts,
    ts,
    projectId
  );
  return { filesIndexed, chunksIndexed, qdrantFailed, reusedFiles, changedFiles };
}
