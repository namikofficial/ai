import type { DatabaseSync } from "node:sqlite";
import { asNumber, asString, newId, now } from "./_shared.ts";

export interface CachedEmbedding {
  id: string;
  providerId: string;
  modelName: string;
  dimension: number;
  contentHash: string;
  embedding: number[];
  hitCount: number;
  createdAt: string;
  lastUsedAt: string;
}

export interface EmbeddingCacheKey {
  providerId: string;
  modelName: string;
  dimension: number;
  contentHash: string;
}

export interface EmbeddingCacheStats {
  providerId: string;
  modelName: string;
  dimension: number;
  hits: number;
  misses: number;
  bypassed: number;
  updatedAt: string;
}

interface CachedRow {
  id: string;
  provider_id: string;
  model_name: string;
  dimension: number;
  content_hash: string;
  embedding_blob: Uint8Array;
  hit_count: number;
  created_at: string;
  last_used_at: string;
}

function blobToFloats(blob: Uint8Array): number[] {
  if (blob.byteLength === 0 || blob.byteLength % 4 !== 0) return [];
  // Copy into a freshly aligned ArrayBuffer so Float32Array can be
  // constructed safely even when the underlying buffer has a
  // non-zero byteOffset (which is the case for sqlite BLOB results).
  const aligned = new ArrayBuffer(blob.byteLength);
  new Uint8Array(aligned).set(blob);
  const view = new Float32Array(aligned);
  return Array.from(view);
}

function floatsToBytes(values: number[]): Uint8Array {
  const view = new Float32Array(values);
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function rowBlobToBytes(row: CachedRow): Uint8Array {
  const value = (row as unknown as { embedding_blob: unknown }).embedding_blob;
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return new Uint8Array(value as number[]);
  if (value == null) return new Uint8Array();
  return new Uint8Array(0);
}

function rowToEmbedding(row: CachedRow): CachedEmbedding {
  return {
    id: asString(row.id),
    providerId: asString(row.provider_id),
    modelName: asString(row.model_name),
    dimension: asNumber(row.dimension),
    contentHash: asString(row.content_hash),
    embedding: blobToFloats(rowBlobToBytes(row)),
    hitCount: asNumber(row.hit_count),
    createdAt: asString(row.created_at),
    lastUsedAt: asString(row.last_used_at),
  };
}

export interface EmbeddingCacheRepo {
  get(key: EmbeddingCacheKey): CachedEmbedding | null;
  put(key: EmbeddingCacheKey, embedding: number[]): CachedEmbedding;
  touch(id: string): void;
  recordHit(id: string): void;
  recordBypassed(providerId: string, modelName: string, dimension: number, count: number): void;
  recordMiss(providerId: string, modelName: string, dimension: number, count: number): void;
  purge(opts: { olderThanDays?: number; modelName?: string | null; providerId?: string | null }): number;
  count(): number;
  stats(): EmbeddingCacheStats[];
}

export function createEmbeddingCacheRepo(db: DatabaseSync): EmbeddingCacheRepo {
  function ensureStatsRow(providerId: string, modelName: string, dimension: number): EmbeddingCacheStats {
    const ts = now();
    const existing = db
      .prepare(
        "SELECT hits, misses, bypassed, updated_at FROM embedding_cache_stats WHERE provider_id = ? AND model_name = ? AND dimension = ?"
      )
      .get(providerId, modelName, dimension) as
      | { hits: number; misses: number; bypassed: number; updated_at: string }
      | undefined;
    if (existing) {
      return {
        providerId,
        modelName,
        dimension,
        hits: asNumber(existing.hits),
        misses: asNumber(existing.misses),
        bypassed: asNumber(existing.bypassed),
        updatedAt: asString(existing.updated_at),
      };
    }
    db.prepare(
      "INSERT OR IGNORE INTO embedding_cache_stats (id, provider_id, model_name, dimension, hits, misses, bypassed, updated_at) VALUES (?, ?, ?, ?, 0, 0, 0, ?)"
    ).run(newId("ecstats"), providerId, modelName, dimension, ts);
    return { providerId, modelName, dimension, hits: 0, misses: 0, bypassed: 0, updatedAt: ts };
  }

  return {
    get(key) {
      const row = db
        .prepare(
          "SELECT id, provider_id, model_name, dimension, content_hash, embedding_blob, hit_count, created_at, last_used_at FROM embedding_cache WHERE provider_id = ? AND model_name = ? AND dimension = ? AND content_hash = ?"
        )
        .get(key.providerId, key.modelName, key.dimension, key.contentHash) as CachedRow | undefined;
      if (!row) return null;
      return rowToEmbedding(row);
    },
    put(key, embedding) {
      const ts = now();
      const id = newId("ec");
      const blob = floatsToBytes(embedding);
      db.prepare(
        "INSERT OR REPLACE INTO embedding_cache (id, provider_id, model_name, dimension, content_hash, embedding_blob, hit_count, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, COALESCE((SELECT hit_count FROM embedding_cache WHERE provider_id = ? AND model_name = ? AND dimension = ? AND content_hash = ?), 0), ?, ?)"
      ).run(
        id,
        key.providerId,
        key.modelName,
        key.dimension,
        key.contentHash,
        blob,
        key.providerId,
        key.modelName,
        key.dimension,
        key.contentHash,
        ts,
        ts
      );
      return {
        id,
        providerId: key.providerId,
        modelName: key.modelName,
        dimension: key.dimension,
        contentHash: key.contentHash,
        embedding: embedding.slice(),
        hitCount: 0,
        createdAt: ts,
        lastUsedAt: ts,
      };
    },
    touch(id) {
      db.prepare("UPDATE embedding_cache SET last_used_at = ? WHERE id = ?").run(now(), id);
    },
    recordHit(id) {
      db.prepare("UPDATE embedding_cache SET hit_count = hit_count + 1, last_used_at = ? WHERE id = ?").run(now(), id);
      const row = db
        .prepare("SELECT provider_id, model_name, dimension FROM embedding_cache WHERE id = ?")
        .get(id) as { provider_id: string; model_name: string; dimension: number } | undefined;
      if (!row) return;
      const stats = ensureStatsRow(row.provider_id, row.model_name, row.dimension);
      db.prepare(
        "UPDATE embedding_cache_stats SET hits = ?, updated_at = ? WHERE provider_id = ? AND model_name = ? AND dimension = ?"
      ).run(stats.hits + 1, now(), row.provider_id, row.model_name, row.dimension);
    },
    recordBypassed(providerId, modelName, dimension, count) {
      if (count <= 0) return;
      const stats = ensureStatsRow(providerId, modelName, dimension);
      db.prepare(
        "UPDATE embedding_cache_stats SET bypassed = bypassed + ?, updated_at = ? WHERE provider_id = ? AND model_name = ? AND dimension = ?"
      ).run(stats.bypassed + count, now(), providerId, modelName, dimension);
    },
    recordMiss(providerId, modelName, dimension, count) {
      if (count <= 0) return;
      const stats = ensureStatsRow(providerId, modelName, dimension);
      db.prepare(
        "UPDATE embedding_cache_stats SET misses = misses + ?, updated_at = ? WHERE provider_id = ? AND model_name = ? AND dimension = ?"
      ).run(stats.misses + count, now(), providerId, modelName, dimension);
    },
    purge(opts) {
      if (opts.olderThanDays && opts.olderThanDays > 0) {
        const cutoff = new Date(Date.now() - opts.olderThanDays * 24 * 60 * 60 * 1000).toISOString();
        const result = db.prepare("DELETE FROM embedding_cache WHERE last_used_at < ?").run(cutoff);
        return Number(result.changes);
      }
      const conditions: string[] = [];
      const args: Array<string | number> = [];
      if (opts.providerId) {
        conditions.push("provider_id = ?");
        args.push(opts.providerId);
      }
      if (opts.modelName) {
        conditions.push("model_name = ?");
        args.push(opts.modelName);
      }
      if (conditions.length === 0) return 0;
      const result = db
        .prepare(`DELETE FROM embedding_cache WHERE ${conditions.join(" AND ")}`)
        .run(...args);
      return Number(result.changes);
    },
    count() {
      const row = db.prepare("SELECT COUNT(*) AS count FROM embedding_cache").get() as { count: number };
      return asNumber(row.count);
    },
    stats() {
      const rows = db
        .prepare(
          "SELECT provider_id, model_name, dimension, hits, misses, bypassed, updated_at FROM embedding_cache_stats ORDER BY updated_at DESC"
        )
        .all() as Array<{
        provider_id: string;
        model_name: string;
        dimension: number;
        hits: number;
        misses: number;
        bypassed: number;
        updated_at: string;
      }>;
      return rows.map((row) => ({
        providerId: asString(row.provider_id),
        modelName: asString(row.model_name),
        dimension: asNumber(row.dimension),
        hits: asNumber(row.hits),
        misses: asNumber(row.misses),
        bypassed: asNumber(row.bypassed),
        updatedAt: asString(row.updated_at),
      }));
    },
  };
}
