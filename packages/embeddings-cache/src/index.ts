// Embedding cache wrapper.
//
// Every embedding call in the system goes through this module so that
// repeated requests for the same text are answered from SQLite instead
// of re-running the model. The cache is keyed on the full embedding
// identity: (providerId, modelName, dimension, contentHash). Changing
// any of those values - e.g. switching the embedding model - naturally
// invalidates the cache because the UNIQUE key changes.
//
// Bypassing the cache is supported and recorded in the stats table so
// callers (e.g. the rerank path) can opt out without losing visibility.

import { createHash } from "node:crypto";
import type { EmbeddingCacheKey, EmbeddingCacheRepo } from "../../db/src/repositories/embedding-cache.ts";

export interface EmbeddingBatchResult {
  embeddings: number[][];
  dimensions: number;
  modelName: string;
  providerId: string;
}

export interface CachedEmbeddingBatchResult extends EmbeddingBatchResult {
  hitCount: number;
  missCount: number;
  bypassedCount: number;
}

export interface EmbeddingCacheOptions {
  providerId: string;
  modelName: string;
  dimension: number;
  cache: EmbeddingCacheRepo;
  /**
   * When true, the cache is read-through but never written. This is
   * useful for models that already manage their own caching or for
   * callers that explicitly want to bypass the persistent cache.
   */
  readOnly?: boolean;
  /**
   * When true, the cache is completely bypassed and the underlying
   * embedder is called for every input. Stats are still recorded so
   * the dashboard can show "we ran N embeddings that bypassed the
   * cache this session".
   */
  bypass?: boolean;
}

export function hashEmbeddingInput(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function buildCacheKey(input: {
  providerId: string;
  modelName: string;
  dimension: number;
  contentHash: string;
}): EmbeddingCacheKey {
  return {
    providerId: input.providerId,
    modelName: input.modelName,
    dimension: input.dimension,
    contentHash: input.contentHash,
  };
}

export type Embedder = (input: string[]) => Promise<EmbeddingBatchResult>;

export async function embedWithCache(
  inputs: string[],
  embedder: Embedder,
  options: EmbeddingCacheOptions
): Promise<CachedEmbeddingBatchResult> {
  if (options.bypass) {
    options.cache.recordBypassed(options.providerId, options.modelName, options.dimension, inputs.length);
    const result = await embedder(inputs);
    return { ...result, hitCount: 0, missCount: 0, bypassedCount: inputs.length };
  }

  const hashes = inputs.map(hashEmbeddingInput);
  const lookup = hashes.map((hash) =>
    options.cache.get(
      buildCacheKey({
        providerId: options.providerId,
        modelName: options.modelName,
        dimension: options.dimension,
        contentHash: hash,
      })
    )
  );
  const cached = lookup.map((entry) => entry?.embedding ?? null);
  const hitCount = cached.filter((value) => value != null).length;
  const missingIndices: number[] = [];
  for (let index = 0; index < cached.length; index += 1) {
    if (cached[index] == null) missingIndices.push(index);
  }
  const output: number[][] = cached.map((value) => (value != null ? value.slice() : []));
  let dimensions = 0;
  for (const value of cached) {
    if (value != null) {
      dimensions = value.length;
      break;
    }
  }

  if (missingIndices.length > 0) {
    const missingInputs = missingIndices.map((index) => inputs[index]);
    const result = await embedder(missingInputs);
    if (dimensions === 0) {
      dimensions = result.dimensions > 0 ? result.dimensions : options.dimension;
    }
    for (let i = 0; i < missingIndices.length; i += 1) {
      const index = missingIndices[i];
      const embedding = result.embeddings[i] ?? [];
      output[index] = embedding;
      if (!options.readOnly) {
        const hash = hashes[index];
        if (embedding.length > 0 && hash) {
          options.cache.put(
            buildCacheKey({
              providerId: options.providerId,
              modelName: options.modelName,
              dimension: options.dimension,
              contentHash: hash,
            }),
            embedding
          );
        }
      }
    }
  }

  for (let i = 0; i < lookup.length; i += 1) {
    const entry = lookup[i];
    if (entry) options.cache.recordHit(entry.id);
  }
  if (missingIndices.length > 0) {
    options.cache.recordMiss(options.providerId, options.modelName, options.dimension, missingIndices.length);
  }

  return {
    embeddings: output,
    dimensions,
    modelName: options.modelName,
    providerId: options.providerId,
    hitCount,
    missCount: missingIndices.length,
    bypassedCount: 0,
  };
}
