// Qdrant HTTP adapter and embedding-dimension validation.
//
// This module owns the Qdrant side of retrieval:
//   - reading runtime settings (env-driven, with safe defaults)
//   - issuing HTTP requests to Qdrant's REST API
//   - validating that the configured collection's vector dimension matches
//     the embedding model the runtime is producing
//   - falling back to a "disabled" state when the dimension is incompatible,
//     so callers (FTS search, indexing) can degrade to SQLite-only behavior
//
// The HTTP transport is intentionally synchronous via child_process so it
// can be called from the existing sync `searchChunks` flow. Higher-level
// async callers can simply `await` the synchronous methods in a worker
// (the work happens off the main thread today; the rest of the codebase
// is mixed sync/async and we keep this contract stable).

import { createHash } from "node:crypto";
// @ts-expect-error - this workspace's node type surface does not expose node:module, but the runtime does.
import { createRequire } from "node:module";

import type { RetrievalChunk } from "../../shared/src/index.ts";

const require = createRequire(import.meta.url);

export interface QdrantRuntimeSettings {
  enabled: boolean;
  url: string | null;
  collection: string;
}

export interface QdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface QdrantDimensionState {
  status: "ok" | "mismatch" | "missing" | "unreachable";
  expected: number;
  actual: number | null;
  detail: string;
}

export interface QdrantIndexChunkInput {
  id: string;
  content: string;
  startLine: number;
  endLine: number;
  tokenCount: number;
}

export function readQdrantRuntimeSettings(
  env: Record<string, string | undefined> = process.env
): QdrantRuntimeSettings {
  const enabled = /^(1|true|yes)$/i.test(env.AI_QDRANT_ENABLED ?? "");
  const collection = env.AI_QDRANT_COLLECTION ?? "ai_chunks";
  const url = env.AI_QDRANT_URL ?? (enabled ? "http://127.0.0.1:6333" : null);
  return { enabled, url, collection };
}

function qdrantRequestSync(
  baseUrl: string,
  path: string,
  init?: { method: string; body?: unknown }
): { ok: boolean; status: number; body: string } | null {
  const method = init?.method ?? "GET";
  const encodedBody = init?.body === undefined ? "" : encodeURIComponent(JSON.stringify(init.body));
  const script = `
    const [url, method, bodyB64] = process.argv.slice(1);
    const body = bodyB64 ? JSON.parse(decodeURIComponent(bodyB64)) : undefined;
    const response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    process.stdout.write(JSON.stringify({ ok: response.ok, status: response.status, body: text }));
  `;
  const { spawnSync } = require("node:child_process") as {
    spawnSync: (
      command: string,
      args: string[],
      options: { encoding: "utf8"; timeout: number; maxBuffer: number }
    ) => { status: number | null; stdout: string };
  };
  let stdout = "";
  try {
    stdout = spawnSync(
      process.argv[0],
      ["--input-type=module", "-e", script, new URL(path, baseUrl).toString(), method, encodedBody],
      {
        encoding: "utf8",
        timeout: 2500,
        maxBuffer: 10_000_000,
      }
    ).stdout;
  } catch {
    return null;
  }
  try {
    return JSON.parse(stdout) as { ok: boolean; status: number; body: string };
  } catch {
    return null;
  }
}

function readCollectionVectorSize(body: string): number | null {
  try {
    const parsed = JSON.parse(body) as {
      result?: {
        config?: {
          params?: {
            vectors?: { size?: number; default?: { size?: number } } | Record<string, { size?: number }>;
          };
        };
      };
    };
    const vectors = parsed.result?.config?.params?.vectors;
    if (!vectors || typeof vectors !== "object") return null;
    if ("size" in vectors && typeof vectors.size === "number") return vectors.size;
    if ("default" in vectors && typeof vectors.default?.size === "number") return vectors.default.size;
    for (const value of Object.values(vectors)) {
      if (value && typeof value === "object" && typeof value.size === "number") return value.size;
    }
  } catch {
    return null;
  }
  return null;
}

export function checkQdrantCollectionDimension(
  settings: QdrantRuntimeSettings,
  expectedDimension: number
): QdrantDimensionState {
  if (!settings.enabled || !settings.url) {
    return {
      status: "unreachable",
      expected: expectedDimension,
      actual: null,
      detail: "qdrant disabled",
    };
  }
  if (expectedDimension <= 0) {
    return {
      status: "unreachable",
      expected: expectedDimension,
      actual: null,
      detail: "no embedding dimension available",
    };
  }
  const response = qdrantRequestSync(settings.url, `/collections/${encodeURIComponent(settings.collection)}`, {
    method: "GET",
  });
  if (response?.ok) {
    const existingSize = readCollectionVectorSize(response.body);
    if (existingSize == null) {
      return {
        status: "ok",
        expected: expectedDimension,
        actual: expectedDimension,
        detail: "collection size not declared; assuming compatible",
      };
    }
    if (existingSize === expectedDimension) {
      return {
        status: "ok",
        expected: expectedDimension,
        actual: existingSize,
        detail: "collection size matches",
      };
    }
    return {
      status: "mismatch",
      expected: expectedDimension,
      actual: existingSize,
      detail: `collection vector size ${existingSize} does not match embedding dimension ${expectedDimension}`,
    };
  }
  return {
    status: "missing",
    expected: expectedDimension,
    actual: null,
    detail: "collection does not exist yet",
  };
}

export function ensureQdrantCollectionSync(settings: QdrantRuntimeSettings, dimension: number): boolean {
  if (!settings.enabled || !settings.url) {
    return false;
  }
  const existing = qdrantRequestSync(settings.url, `/collections/${encodeURIComponent(settings.collection)}`, {
    method: "GET",
  });
  if (existing?.ok) {
    const existingSize = readCollectionVectorSize(existing.body);
    return existingSize == null || existingSize === dimension;
  }
  const created = qdrantRequestSync(settings.url, `/collections/${encodeURIComponent(settings.collection)}`, {
    method: "PUT",
    body: {
      vectors: {
        size: dimension,
        distance: "Cosine",
      },
    },
  });
  return Boolean(created?.ok);
}

export function qdrantPointForChunk(
  projectId: string,
  documentId: string,
  path: string,
  chunk: QdrantIndexChunkInput,
  language: string | null,
  vector: number[]
): QdrantPoint {
  return {
    id: chunk.id,
    vector,
    payload: {
      chunkId: chunk.id,
      projectId,
      documentId,
      path,
      content: chunk.content,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      tokenCount: chunk.tokenCount,
      metadata: {
        path,
        language,
      },
    },
  };
}

export function upsertQdrantChunksSync(settings: QdrantRuntimeSettings, points: QdrantPoint[]): boolean {
  if (!settings.enabled || !settings.url || points.length === 0) {
    return false;
  }
  const dimension = points[0]?.vector.length ?? 0;
  if (dimension <= 0 || !points.every((point) => point.vector.length === dimension)) {
    return false;
  }
  if (!ensureQdrantCollectionSync(settings, dimension)) {
    return false;
  }
  const response = qdrantRequestSync(
    settings.url,
    `/collections/${encodeURIComponent(settings.collection)}/points?wait=true`,
    {
      method: "PUT",
      body: { points },
    }
  );
  return Boolean(response?.ok);
}

export function searchQdrantChunksSync(
  settings: QdrantRuntimeSettings,
  projectId: string,
  queryVector: number[],
  limit: number
): RetrievalChunk[] | null {
  if (!settings.enabled || !settings.url || queryVector.length === 0) {
    return null;
  }
  const state = checkQdrantCollectionDimension(settings, queryVector.length);
  if (state.status === "mismatch" || state.status === "unreachable") {
    return null;
  }
  if (state.status === "missing") {
    if (!ensureQdrantCollectionSync(settings, queryVector.length)) {
      return null;
    }
  }
  const response = qdrantRequestSync(
    settings.url,
    `/collections/${encodeURIComponent(settings.collection)}/points/search`,
    {
      method: "POST",
      body: {
        vector: queryVector,
        limit: limit * 3,
        with_payload: true,
        filter: {
          must: [
            {
              key: "projectId",
              match: {
                value: projectId,
              },
            },
          ],
        },
      },
    }
  );
  if (!response?.ok) {
    return null;
  }
  try {
    const parsed = JSON.parse(response.body) as {
      result?: Array<{
        id: string | number;
        score: number;
        payload?: Record<string, unknown>;
      }>;
    };
    return (parsed.result ?? [])
      .map((result) => {
        const payload = result.payload ?? {};
        const metadata =
          payload.metadata && typeof payload.metadata === "object" ? (payload.metadata as Record<string, unknown>) : {};
        return {
          id: asString(payload.chunkId ?? result.id),
          projectId: asString(payload.projectId),
          documentId: asString(payload.documentId),
          path: asString(payload.path),
          content: asString(payload.content),
          startLine: toNumber(payload.startLine),
          endLine: toNumber(payload.endLine),
          tokenCount: toNumber(payload.tokenCount),
          score: result.score * 10,
          metadata,
        } satisfies RetrievalChunk;
      })
      .filter((chunk) => chunk.id.length > 0 && chunk.path.length > 0 && chunk.content.length > 0);
  } catch {
    return null;
  }
}

// Local deterministic hash embedding used as the safe default for the Qdrant
// query vector. This intentionally matches the heuristic adapter exposed by
// the model-runtime package, but is duplicated here so the Qdrant layer can
// stay independent of provider state. The model-runtime heuristic provider
// remains the source of truth for content embeddings produced during indexing.
function hashEmbedText(text: string, dim: number): number[] {
  const vector = Array.from({ length: dim }, () => 0);
  const terms = text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((term) => term.length >= 2);
  for (const term of terms) {
    let hash = 2166136261;
    for (let index = 0; index < term.length; index += 1) {
      hash ^= term.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    const bucket = hash >>> 0;
    vector[bucket % dim] += 1;
    vector[(bucket >>> 5) % dim] += term.length / 8;
    vector[(bucket >>> 11) % dim] += term.includes("auth") ? 1.5 : 0.25;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return magnitude > 0 ? vector.map((value) => value / magnitude) : vector;
}

export interface QueryEmbeddingInput {
  text: string;
  dimension: number;
  // Optional override embedding function. When supplied, takes precedence
  // over the local hash embedder. This is the seam the higher-level runtime
  // can use to plug in a real provider without forcing the Qdrant module to
  // depend on the model-runtime package.
  embed?: (text: string, dimension: number) => number[];
}

export function embedQueryForQdrant(input: QueryEmbeddingInput): number[] {
  if (input.embed) {
    return input.embed(input.text, input.dimension);
  }
  return hashEmbedText(input.text, input.dimension);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.length > 0) return Number(value);
  return 0;
}

// ─── Stateful client ───────────────────────────────────────────────────────
//
// `QdrantClient` is a thin wrapper that remembers the most recent dimension
// state and disables itself if the collection's vector size ever disagrees
// with the embedding dimension the runtime is producing. This is the
// dedicated fix for the "Qdrant dimension mismatch silently fails" gap: a
// mismatched collection now causes the client to switch to `disabled` and
// the search/index flows fall back to SQLite FTS automatically.

export interface QdrantClientOptions {
  settings: QdrantRuntimeSettings;
  initialDimension: number;
}

export class QdrantClient {
  private settings: QdrantRuntimeSettings;
  private dimension: number;
  private lastState: QdrantDimensionState;
  private disabledReason: string | null = null;

  constructor(options: QdrantClientOptions) {
    this.settings = options.settings;
    this.dimension = Math.max(0, options.initialDimension);
    this.lastState = {
      status: "unreachable",
      expected: this.dimension,
      actual: null,
      detail: "client constructed; no probe yet",
    };
    if (!this.settings.enabled) {
      this.disabledReason = "qdrant disabled (AI_QDRANT_ENABLED=false)";
    }
  }

  isEnabled(): boolean {
    return this.disabledReason == null;
  }

  disabledReasonMessage(): string | null {
    return this.disabledReason;
  }

  settings_(): QdrantRuntimeSettings {
    return this.settings;
  }

  setDimension(dimension: number): void {
    this.dimension = Math.max(0, dimension);
  }

  collectionName(): string {
    return this.settings.collection;
  }

  baseUrl(): string | null {
    return this.settings.url;
  }

  probe(): QdrantDimensionState {
    if (!this.settings.enabled || !this.settings.url) {
      this.lastState = {
        status: "unreachable",
        expected: this.dimension,
        actual: null,
        detail: "qdrant disabled",
      };
      return this.lastState;
    }
    if (this.dimension <= 0) {
      this.lastState = {
        status: "unreachable",
        expected: 0,
        actual: null,
        detail: "no embedding dimension available",
      };
      return this.lastState;
    }
    const probed = checkQdrantCollectionDimension(this.settings, this.dimension);
    this.lastState = probed;
    if (probed.status === "mismatch") {
      this.disabledReason = probed.detail;
    } else if (probed.status === "ok" || probed.status === "missing") {
      this.disabledReason = null;
    }
    return probed;
  }

  lastDimensionState(): QdrantDimensionState {
    return this.lastState;
  }

  // Performs the search. When the client is disabled or the dimension does
  // not match, returns null so the caller can fall back to FTS search.
  search(projectId: string, queryVector: number[], limit: number): RetrievalChunk[] | null {
    if (this.disabledReason) {
      return null;
    }
    if (queryVector.length === 0 || queryVector.length !== this.dimension) {
      return null;
    }
    return searchQdrantChunksSync(this.settings, projectId, queryVector, limit);
  }

  // Upserts points. Returns true when the collection is correctly sized for
  // the given points and the request succeeded; false on mismatch, failure,
  // or when the client is disabled.
  upsert(points: QdrantPoint[]): { ok: boolean; disabled: boolean; detail: string } {
    if (this.disabledReason) {
      return { ok: false, disabled: true, detail: this.disabledReason };
    }
    if (points.length === 0) {
      return { ok: true, disabled: false, detail: "no points" };
    }
    const dimension = points[0]?.vector.length ?? 0;
    if (dimension === 0 || !points.every((point) => point.vector.length === dimension)) {
      return { ok: false, disabled: false, detail: "inconsistent vector dimensions" };
    }
    if (this.dimension > 0 && dimension !== this.dimension) {
      this.dimension = dimension;
    }
    const state = checkQdrantCollectionDimension(this.settings, dimension);
    if (state.status === "mismatch") {
      this.disabledReason = state.detail;
      return { ok: false, disabled: true, detail: state.detail };
    }
    const ok = upsertQdrantChunksSync(this.settings, points);
    return { ok, disabled: false, detail: ok ? "ok" : "upsert failed" };
  }
}

// Stable hash for content fingerprinting (used by the indexer to skip
// re-indexing unchanged files). Kept here as a convenience; the indexer
// package also exposes it for direct use.
export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
