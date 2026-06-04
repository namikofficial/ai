// Chunking + content hashing for the local indexer.
//
// Chunks are line-windowed (default 80 lines per chunk) and token counts
// are estimated with a 4-chars-per-token rule of thumb. This is good
// enough as a baseline; richer chunkers (semantic, AST-aware) can be
// plugged in later without changing the public surface.

import { createHash } from "node:crypto";

export interface ChunkOptions {
  linesPerChunk?: number;
  maxFileBytes?: number;
}

export interface Chunk {
  content: string;
  startLine: number;
  endLine: number;
  tokenCount: number;
}

const DEFAULT_LINES_PER_CHUNK = 80;
const DEFAULT_MAX_FILE_BYTES = 256_000;

export function chunkContent(content: string, linesPerChunk = DEFAULT_LINES_PER_CHUNK): Chunk[] {
  const lines = content.split("\n");
  const chunks: Chunk[] = [];
  for (let index = 0; index < lines.length; index += linesPerChunk) {
    const slice = lines.slice(index, index + linesPerChunk);
    const startLine = index + 1;
    const endLine = index + slice.length;
    const chunkText = slice.join("\n").trim();
    if (chunkText.length === 0) {
      continue;
    }
    chunks.push({
      content: chunkText,
      startLine,
      endLine,
      tokenCount: Math.max(1, Math.ceil(chunkText.length / 4)),
    });
  }
  return chunks;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function isFileSizeIndexable(sizeBytes: number, options: ChunkOptions = {}): boolean {
  const max = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  return sizeBytes <= max;
}
