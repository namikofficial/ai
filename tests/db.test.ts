import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStore, initializeStore } from "../packages/db/src/store.ts";
import { createEvent } from "../packages/shared/src/index.ts";

async function startQdrantStub(vectorSize: number): Promise<{
  url: string;
  counts: { gets: number; puts: number; searches: number };
  close(): Promise<void>;
}> {
  const counts = { gets: 0, puts: 0, searches: 0 };
  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    if (req.method === "GET" && url.startsWith("/collections/")) {
      counts.gets += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result: { config: { params: { vectors: { size: vectorSize } } } } }));
      return;
    }
    if (req.method === "POST" && url.includes("/points/search")) {
      counts.searches += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result: [] }));
      return;
    }
    if (req.method === "PUT") {
      counts.puts += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result: true }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const addr = (server as any).address?.();
  const address = addr && typeof addr === "object" ? addr : null;
  if (!address) {
    throw new Error("failed to start qdrant stub");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    counts,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("applies the migration and stores projects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ai-db-"));
  const dbPath = join(dir, "ai.db");
  await writeFile(join(dir, "README.md"), ["# Temp Project", "", "Auth is documented here."].join("\n"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(
    join(dir, "src", "auth.ts"),
    ["export function authenticateUser() {", "  return true;", "}"].join("\n")
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

  store.appendEvent(
    createEvent(
      "session.started",
      { ok: true },
      { id: "evt_test", sessionId: session.id, projectId: project.id, agent: "test" }
    )
  );

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
    ["# Qdrant Fallback Project", "", "This README should still be indexed locally."].join("\n")
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

test("keeps indexing and FTS working when qdrant is disabled", async () => {
  const previousQdrantEnabled = process.env.AI_QDRANT_ENABLED;
  const previousQdrantUrl = process.env.AI_QDRANT_URL;
  const previousQdrantCollection = process.env.AI_QDRANT_COLLECTION;

  process.env.AI_QDRANT_ENABLED = "false";
  process.env.AI_QDRANT_URL = "http://127.0.0.1:1";
  process.env.AI_QDRANT_COLLECTION = "ai-disabled";

  const dir = await mkdtemp(join(tmpdir(), "ai-db-disabled-"));
  const dbPath = join(dir, "ai.db");
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(
    join(dir, "README.md"),
    ["# Disabled Qdrant Project", "", "This README should still be indexed locally."].join("\n")
  );

  try {
    const store = createStore(initializeStore(dbPath));
    const project = store.createProject({ path: dir, name: "qdrant-disabled" });
    await store.indexProject(project.id);

    const chunks = store.searchChunks(project.id, "README", { limit: 4 });
    assert.ok(chunks.length > 0, "indexing should still work without qdrant");
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

test("uses FTS fallback when qdrant collection dimension mismatches embedding dimension", async () => {
  const previousQdrantEnabled = process.env.AI_QDRANT_ENABLED;
  const previousQdrantUrl = process.env.AI_QDRANT_URL;
  const previousQdrantCollection = process.env.AI_QDRANT_COLLECTION;
  const previousEmbeddingDim = process.env.AI_EMBEDDING_DIM;

  const stub = await startQdrantStub(384);
  process.env.AI_QDRANT_ENABLED = "true";
  process.env.AI_QDRANT_URL = stub.url;
  process.env.AI_QDRANT_COLLECTION = "ai-test-dimension";
  process.env.AI_EMBEDDING_DIM = "384";

  const dir = await mkdtemp(join(tmpdir(), "ai-db-dim-"));
  const dbPath = join(dir, "ai.db");
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(
    join(dir, "README.md"),
    ["# Dimension Mismatch Project", "", "Auth is documented here and should still be found by FTS."].join("\n")
  );
  await writeFile(join(dir, "src", "auth.ts"), "export const authNote = 'auth handled here';\n");

  try {
    const store = createStore(initializeStore(dbPath));
    const project = store.createProject({ path: dir, name: "dimension-mismatch" });
    await store.indexProject(project.id);
    assert.ok(stub.counts.gets >= 1, "qdrant collection should be probed");
    assert.equal(stub.counts.puts, 0, "qdrant upsert should be skipped on dimension mismatch");

    const chunks = store.searchChunks(project.id, "auth handled", { limit: 4 });
    assert.ok(chunks.length > 0, "FTS should still return chunks");
    assert.ok(chunks[0].path.includes("auth"), "FTS should still surface auth-related content");
    store.db.close();
  } finally {
    await stub.close();
    if (previousQdrantEnabled === undefined) delete process.env.AI_QDRANT_ENABLED;
    else process.env.AI_QDRANT_ENABLED = previousQdrantEnabled;
    if (previousQdrantUrl === undefined) delete process.env.AI_QDRANT_URL;
    else process.env.AI_QDRANT_URL = previousQdrantUrl;
    if (previousQdrantCollection === undefined) delete process.env.AI_QDRANT_COLLECTION;
    else process.env.AI_QDRANT_COLLECTION = previousQdrantCollection;
    if (previousEmbeddingDim === undefined) delete process.env.AI_EMBEDDING_DIM;
    else process.env.AI_EMBEDDING_DIM = previousEmbeddingDim;
    await rm(dir, { recursive: true, force: true });
  }
});

test("stores and lists validation memory events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ai-db-memory-events-"));
  const dbPath = join(dir, "ai.db");
  try {
    const store = createStore(initializeStore(dbPath));
    const project = store.createProject({ path: dir, name: "memory-events-project" });

    const written = store.memory.writeMemoryEvent({
      projectId: project.id,
      type: "validation_result",
      command: "pnpm test",
      status: "failed",
      summary: "tenant owner login test fails because subAccountId filter excludes tenant-level owner",
      sourceRef: dir,
      evidence: { exitCode: 1, affectedFiles: ["src/auth.ts"] },
    });
    assert.ok(written.id.startsWith("mevt_"));

    const events = store.memory.listMemoryEvents({ projectId: project.id, type: "validation_result" });
    assert.equal(events.length, 1);
    assert.equal(events[0].command, "pnpm test");
    assert.equal(events[0].status, "failed");
    assert.match(events[0].summary ?? "", /subAccountId filter/);
    assert.deepEqual(events[0].evidence.affectedFiles, ["src/auth.ts"]);
    store.db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stores and queries temporal memory graph with validity windows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ai-db-graph-"));
  const dbPath = join(dir, "ai.db");
  try {
    const store = createStore(initializeStore(dbPath));
    const project = store.createProject({ path: dir, name: "graph-project" });

    const owner = store.memory.writeMemoryNode({
      projectId: project.id,
      entity: "owner",
      entityType: "role",
      label: "tenant owner",
      value: "can login with PIN",
    });
    const pin = store.memory.writeMemoryNode({
      projectId: project.id,
      entity: "pin_login",
      entityType: "feature",
      label: "PIN login",
      value: "enabled",
    });
    store.memory.writeMemoryEdge({
      projectId: project.id,
      sourceNodeId: owner.id,
      targetNodeId: pin.id,
      relation: "uses",
    });
    // A node that expired before now should be excluded from the default asOf view.
    store.memory.writeMemoryNode({
      projectId: project.id,
      entity: "legacy_owner",
      entityType: "role",
      label: "legacy owner",
      value: "deprecated",
      validAt: "2000-01-01T00:00:00.000Z",
      invalidAt: "2001-01-01T00:00:00.000Z",
    });

    const graph = store.memory.listMemoryGraph({ projectId: project.id });
    assert.equal(graph.nodes.length, 2, "expired node must be excluded by default asOf");
    assert.equal(graph.edges.length, 1);
    assert.ok(graph.nodes.some((n) => n.entity === "owner"));
    assert.ok(graph.edges[0].relation === "uses");

    const ownerOnly = store.memory.listMemoryGraph({ projectId: project.id, entity: "owner" });
    assert.equal(ownerOnly.nodes.length, 1);
    store.db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("records temporal facts with validity windows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ai-db-fact-validity-"));
  const dbPath = join(dir, "ai.db");
  try {
    const store = createStore(initializeStore(dbPath));
    const project = store.createProject({ path: dir, name: "fact-validity" });
    store.memory.recordFact({
      projectId: project.id,
      key: "deploy_window",
      value: "enabled",
      kind: "policy",
      confidence: 0.9,
      sourceKind: "reflection",
      validAt: "2030-01-01T00:00:00.000Z",
      invalidAt: null,
    });
    const facts = store.memory.listFacts(project.id);
    assert.equal(facts.length, 1);
    assert.equal(facts[0].validAt, "2030-01-01T00:00:00.000Z");
    assert.equal(facts[0].invalidAt, null);
    store.db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
