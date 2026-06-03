import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeStore, createStore } from "../packages/db/src/store.ts";

test("applies the migration and stores projects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ai-db-"));
  const dbPath = join(dir, "ai.db");
  await writeFile(
    join(dir, "README.md"),
    [
      "# Temp Project",
      "",
      "Auth is documented here.",
    ].join("\n"),
  );
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(
    join(dir, "src", "auth.ts"),
    [
      "export function authenticateUser() {",
      "  return true;",
      "}",
    ].join("\n"),
  );
  const store = createStore(initializeStore(dbPath));

  const project = store.createProject({ path: dir, name: "temp-project" });
  assert.equal(project.name, "temp-project");
  assert.equal(store.listProjects().length, 1);

  await store.indexProject(project.id);
  const chunks = store.searchChunks(project.id, "readme", { limit: 4 });
  assert.ok(chunks.length > 0);
  assert.equal(chunks[0].path, "README.md");

  const session = store.createSession({
    projectId: project.id,
    title: "Test session",
    userGoal: "verify persistence",
    mode: "local",
    source: "test",
  });

  store.appendEvent({
    id: "evt_test",
    type: "session.started",
    sessionId: session.id,
    taskId: null,
    projectId: project.id,
    agent: "test",
    level: "info",
    ts: new Date().toISOString(),
    payload: { ok: true },
  });

  const events = store.listEvents(session.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "session.started");

  store.db.close();
  await rm(dir, { recursive: true, force: true });
});

test("falls back when qdrant is enabled but unavailable", async () => {
  const previousQdrantEnabled = process.env.AI_QDRANT_ENABLED;
  const previousQdrantUrl = process.env.AI_QDRANT_URL;
  const previousQdrantCollection = process.env.AI_QDRANT_COLLECTION;

  process.env.AI_QDRANT_ENABLED = "true";
  process.env.AI_QDRANT_URL = "http://127.0.0.1:1";
  process.env.AI_QDRANT_COLLECTION = "ai-test-fallback";

  const dir = await mkdtemp(join(tmpdir(), "ai-db-qdrant-"));
  const dbPath = join(dir, "ai.db");
  await writeFile(
    join(dir, "README.md"),
    [
      "# Qdrant Fallback Project",
      "",
      "This README should still be indexed locally.",
    ].join("\n"),
  );

  try {
    const store = createStore(initializeStore(dbPath));
    const project = store.createProject({ path: dir, name: "qdrant-fallback" });
    await store.indexProject(project.id);
    const chunks = store.searchChunks(project.id, "README", { limit: 4 });
    assert.ok(chunks.length > 0);
    assert.equal(chunks[0].path, "README.md");
    store.db.close();
  } finally {
    if (previousQdrantEnabled === undefined) delete process.env.AI_QDRANT_ENABLED;
    else process.env.AI_QDRANT_ENABLED = previousQdrantEnabled;
    if (previousQdrantUrl === undefined) delete process.env.AI_QDRANT_URL;
    else process.env.AI_QDRANT_URL = previousQdrantUrl;
    if (previousQdrantCollection === undefined) delete process.env.AI_QDRANT_COLLECTION;
    else process.env.AI_QDRANT_COLLECTION = previousQdrantCollection;
    await rm(dir, { recursive: true, force: true });
  }
});
