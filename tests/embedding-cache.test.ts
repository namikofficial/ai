import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runMigrations } from "../packages/db/src/migrate.ts";
import { createEmbeddingCacheRepo, type EmbeddingCacheRepo } from "../packages/db/src/repositories/embedding-cache.ts";
import { embedWithCache, hashEmbeddingInput } from "../packages/embeddings-cache/src/index.ts";

function openTestDb(): { db: DatabaseSync; cleanup: () => Promise<void> } {
  const dir = "";
  // We intentionally keep the DB in memory for these tests so each test
  // gets a fresh schema and a fresh cache.
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  return {
    db,
    async cleanup() {
      db.close();
      if (dir) await rm(dir, { recursive: true, force: true });
    },
  };
}

function assertCloseTo(actual: number[], expected: number[], epsilon = 1e-5): void {
  assert.equal(actual.length, expected.length, `vector length mismatch: ${actual.length} != ${expected.length}`);
  for (let i = 0; i < actual.length; i += 1) {
    assert.ok(
      Math.abs(actual[i] - expected[i]) < epsilon,
      `index ${i}: ${actual[i]} not within ${epsilon} of ${expected[i]}`
    );
  }
}

test("embedding-cache: get/put round-trips a vector through sqlite blob", async () => {
  const { db, cleanup } = openTestDb();
  try {
    const repo: EmbeddingCacheRepo = createEmbeddingCacheRepo(db);
    const key = {
      providerId: "provider_llamacpp_local",
      modelName: "nomic-embed-text",
      dimension: 4,
      contentHash: hashEmbeddingInput("hello world"),
    };
    const stored = repo.put(key, [0.25, -0.5, 1.5, 0]);
    assert.ok(stored.id.startsWith("ec_"));
    const fetched = repo.get(key);
    assert.ok(fetched);
    assertCloseTo(fetched?.embedding ?? [], [0.25, -0.5, 1.5, 0]);
    assert.equal(fetched?.hitCount, 0);
  } finally {
    await cleanup();
  }
});

test("embedding-cache: distinct content_hash gives a distinct entry", async () => {
  const { db, cleanup } = openTestDb();
  try {
    const repo = createEmbeddingCacheRepo(db);
    const base = {
      providerId: "provider_llamacpp_local",
      modelName: "nomic-embed-text",
      dimension: 4,
    };
    repo.put({ ...base, contentHash: hashEmbeddingInput("a") }, [1, 0, 0, 0]);
    repo.put({ ...base, contentHash: hashEmbeddingInput("b") }, [0, 1, 0, 0]);
    assert.equal(repo.count(), 2);
    const a = repo.get({ ...base, contentHash: hashEmbeddingInput("a") });
    const b = repo.get({ ...base, contentHash: hashEmbeddingInput("b") });
    assertCloseTo(a?.embedding ?? [], [1, 0, 0, 0]);
    assertCloseTo(b?.embedding ?? [], [0, 1, 0, 0]);
  } finally {
    await cleanup();
  }
});

test("embedding-cache: recordHit and stats roll up over multiple lookups", async () => {
  const { db, cleanup } = openTestDb();
  try {
    const repo = createEmbeddingCacheRepo(db);
    const stored = repo.put(
      {
        providerId: "provider_llamacpp_local",
        modelName: "nomic-embed-text",
        dimension: 4,
        contentHash: hashEmbeddingInput("hi"),
      },
      [1, 1, 1, 1]
    );
    repo.recordHit(stored.id);
    repo.recordHit(stored.id);
    repo.recordHit(stored.id);
    repo.recordMiss("provider_llamacpp_local", "nomic-embed-text", 4, 5);
    const stats = repo.stats();
    const match = stats.find(
      (entry) => entry.providerId === "provider_llamacpp_local" && entry.modelName === "nomic-embed-text"
    );
    assert.ok(match, "stats row should exist");
    assert.equal(match?.hits, 3);
    assert.equal(match?.misses, 5);
    assert.equal(match?.bypassed, 0);
  } finally {
    await cleanup();
  }
});

test("embedding-cache: repeated miss and bypass batches grow linearly", async () => {
  const { db, cleanup } = openTestDb();
  try {
    const repo = createEmbeddingCacheRepo(db);
    for (let index = 0; index < 64; index += 1) {
      repo.recordMiss("provider_llamacpp_local", "nomic-embed-text", 4, 1);
      repo.recordBypassed("provider_llamacpp_local", "nomic-embed-text", 4, 2);
    }

    const match = repo
      .stats()
      .find((entry) => entry.providerId === "provider_llamacpp_local" && entry.modelName === "nomic-embed-text");
    assert.ok(match, "stats row should exist");
    assert.equal(match?.misses, 64);
    assert.equal(match?.bypassed, 128);
  } finally {
    await cleanup();
  }
});

test("embedding-cache: embedWithCache returns cache hits without invoking the embedder", async () => {
  const { db, cleanup } = openTestDb();
  try {
    const repo = createEmbeddingCacheRepo(db);
    repo.put(
      {
        providerId: "provider_llamacpp_local",
        modelName: "nomic-embed-text",
        dimension: 4,
        contentHash: hashEmbeddingInput("a"),
      },
      [0.1, 0.2, 0.3, 0.4]
    );
    let calls = 0;
    const result = await embedWithCache(
      ["a", "b"],
      async (missing) => {
        calls += 1;
        return {
          embeddings: missing.map(() => [0.5, 0.5, 0.5, 0.5]),
          dimensions: 4,
          modelName: "nomic-embed-text",
          providerId: "provider_llamacpp_local",
        };
      },
      {
        providerId: "provider_llamacpp_local",
        modelName: "nomic-embed-text",
        dimension: 4,
        cache: repo,
      }
    );
    assert.equal(calls, 1, "embedder should be called once for the missing input only");
    assert.equal(result.hitCount, 1);
    assert.equal(result.missCount, 1);
    assertCloseTo(result.embeddings[0], [0.1, 0.2, 0.3, 0.4]);
    assertCloseTo(result.embeddings[1], [0.5, 0.5, 0.5, 0.5]);
    // The miss was just stored; re-running the same input should be a full hit.
    const second = await embedWithCache(
      ["a", "b"],
      async () => {
        throw new Error("embedder should not be called when everything is cached");
      },
      {
        providerId: "provider_llamacpp_local",
        modelName: "nomic-embed-text",
        dimension: 4,
        cache: repo,
      }
    );
    assert.equal(second.hitCount, 2);
    assert.equal(second.missCount, 0);
  } finally {
    await cleanup();
  }
});

test("embedding-cache: bypass mode skips read-through and records bypass stats", async () => {
  const { db, cleanup } = openTestDb();
  try {
    const repo = createEmbeddingCacheRepo(db);
    let calls = 0;
    const result = await embedWithCache(
      ["a", "b", "c"],
      async (inputs) => {
        calls += inputs.length;
        return {
          embeddings: inputs.map(() => [1, 1, 1, 1]),
          dimensions: 4,
          modelName: "nomic-embed-text",
          providerId: "provider_llamacpp_local",
        };
      },
      {
        providerId: "provider_llamacpp_local",
        modelName: "nomic-embed-text",
        dimension: 4,
        cache: repo,
        bypass: true,
      }
    );
    assert.equal(calls, 3);
    assert.equal(result.hitCount, 0);
    assert.equal(result.missCount, 0);
    assert.equal(result.bypassedCount, 3);
    const stats = repo.stats();
    assert.equal(stats[0]?.bypassed, 3);
    assert.equal(repo.count(), 0, "bypass must not populate the cache");
  } finally {
    await cleanup();
  }
});

test("embedding-cache: read-only mode serves hits but never writes", async () => {
  const { db, cleanup } = openTestDb();
  try {
    const repo = createEmbeddingCacheRepo(db);
    const result = await embedWithCache(
      ["x"],
      async (inputs) => ({
        embeddings: inputs.map(() => [2, 2, 2, 2]),
        dimensions: 4,
        modelName: "nomic-embed-text",
        providerId: "provider_llamacpp_local",
      }),
      {
        providerId: "provider_llamacpp_local",
        modelName: "nomic-embed-text",
        dimension: 4,
        cache: repo,
        readOnly: true,
      }
    );
    assert.equal(result.missCount, 1);
    assert.equal(result.hitCount, 0);
    assert.equal(repo.count(), 0, "read-only must not write");
  } finally {
    await cleanup();
  }
});

test("embedding-cache: dimension mismatch keys are isolated", async () => {
  const { db, cleanup } = openTestDb();
  try {
    const repo = createEmbeddingCacheRepo(db);
    const hash = hashEmbeddingInput("same-text");
    repo.put({ providerId: "p", modelName: "m", dimension: 4, contentHash: hash }, [1, 0, 0, 0]);
    repo.put({ providerId: "p", modelName: "m", dimension: 8, contentHash: hash }, [1, 1, 1, 1, 0, 0, 0, 0]);
    assert.equal(repo.count(), 2);
    const four = repo.get({
      providerId: "p",
      modelName: "m",
      dimension: 4,
      contentHash: hash,
    });
    const eight = repo.get({
      providerId: "p",
      modelName: "m",
      dimension: 8,
      contentHash: hash,
    });
    assert.equal(four?.embedding.length, 4);
    assert.equal(eight?.embedding.length, 8);
    assertCloseTo(four?.embedding ?? [], [1, 0, 0, 0]);
    assertCloseTo(eight?.embedding ?? [], [1, 1, 1, 1, 0, 0, 0, 0]);
  } finally {
    await cleanup();
  }
});

test("embedding-cache: purge by olderThanDays evicts stale rows but keeps recent", async () => {
  const { db, cleanup } = openTestDb();
  try {
    const repo = createEmbeddingCacheRepo(db);
    const fresh = repo.put(
      {
        providerId: "p",
        modelName: "m",
        dimension: 4,
        contentHash: hashEmbeddingInput("fresh"),
      },
      [0, 0, 0, 0]
    );
    const stale = repo.put(
      {
        providerId: "p",
        modelName: "m",
        dimension: 4,
        contentHash: hashEmbeddingInput("stale"),
      },
      [1, 1, 1, 1]
    );
    // Backdate the stale row's last_used_at to 60 days ago.
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE embedding_cache SET last_used_at = ? WHERE id = ?").run(sixtyDaysAgo, stale.id);
    const removed = repo.purge({ olderThanDays: 30 });
    assert.equal(removed, 1);
    assert.equal(repo.count(), 1);
    const stillThere = repo.get({
      providerId: "p",
      modelName: "m",
      dimension: 4,
      contentHash: hashEmbeddingInput("fresh"),
    });
    assert.ok(stillThere);
    assert.equal(stillThere?.id, fresh.id);
  } finally {
    await cleanup();
  }
});

test("embedding-cache: hashEmbeddingInput is deterministic and stable", () => {
  const a1 = hashEmbeddingInput("hello world");
  const a2 = hashEmbeddingInput("hello world");
  const b = hashEmbeddingInput("hello world!");
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.equal(a1.length, 64); // sha256 hex
});
