import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { listMigrations, runMigrations } from "../packages/db/src/migrate.ts";

test("migrations list includes 0001, 0002, and 0003_intelligence", () => {
  const migrations = listMigrations();
  const versions = migrations.map((entry) => entry.version);
  assert.ok(versions.includes("0001_init"));
  assert.ok(versions.includes("0002_observability"));
  assert.ok(versions.includes("0003_intelligence"));
});

test("migrations apply cleanly and create the new intelligence tables", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ai-mig-"));
  const dbPath = join(dir, "ai.db");
  const db = new DatabaseSync(dbPath);
  try {
    const result = runMigrations(db);
    assert.equal(result.applied.length, 3);
    assert.equal(result.skipped.length, 0);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
    const tableNames = tables.map((row) => row.name);
    assert.ok(tableNames.includes("chunk_path_boosts"), "chunk_path_boosts table must exist");
    assert.ok(tableNames.includes("retrieval_path_feedback"), "retrieval_path_feedback table must exist");
    assert.ok(tableNames.includes("retrieval_query_rewrites_used"), "retrieval_query_rewrites_used table must exist");
    assert.ok(tableNames.includes("context_pack_dependencies"), "context_pack_dependencies table must exist");

    const ragChunksColumns = db.prepare("PRAGMA table_info(rag_chunks)").all() as Array<{ name: string }>;
    const ragChunksNames = ragChunksColumns.map((c) => c.name);
    assert.ok(ragChunksNames.includes("embedding_model"), "rag_chunks.embedding_model column must exist");
    assert.ok(ragChunksNames.includes("embedding_dim"), "rag_chunks.embedding_dim column must exist");
    assert.ok(ragChunksNames.includes("embedding_provider"), "rag_chunks.embedding_provider column must exist");
  } finally {
    db.close();
  }
});

test("migrations are idempotent: second run skips all", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ai-mig-2-"));
  const dbPath = join(dir, "ai.db");
  const db = new DatabaseSync(dbPath);
  try {
    const first = runMigrations(db);
    assert.ok(first.applied.length >= 3);
    const second = runMigrations(db);
    assert.equal(second.applied.length, 0);
    assert.equal(second.skipped.length, first.applied.length);
  } finally {
    db.close();
  }
});
