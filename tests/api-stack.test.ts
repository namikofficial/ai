import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startWorkbenchServer } from "../apps/api/src/server.ts";
import { resolveConfig } from "../packages/config/src/index.ts";
import { createModelRuntime } from "../packages/model-runtime/src/index.ts";
import { initializeStore, createStore } from "../packages/db/src/store.ts";

test("startWorkbenchServer wires the intelligence stack by default", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-api-stack-"));
  const config = resolveConfig({
    databasePath: join(workspace, "ai.db"),
    runtimeDir: join(workspace, "runtime"),
  });
  await mkdir(config.runtimeDir, { recursive: true });

  const handle = await startWorkbenchServer({ config, inProcess: true });
  try {
    const inject = await handle.inject({
      method: "GET",
      url: "/dashboard",
      headers: { accept: "application/json" },
    });
    assert.equal(inject.statusCode, 200);
  } finally {
    await handle.close();
  }
  await rm(workspace, { recursive: true, force: true });
});

test("API /retrieval/explain uses the full pipeline", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-api-explain-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(
    join(repo, "src", "auth.ts"),
    "export function handleLogin() { return { route: '/api/auth/login' }; }\n",
  );

  const config = resolveConfig({
    databasePath: join(workspace, "ai.db"),
    runtimeDir: join(workspace, "runtime"),
  });
  await mkdir(config.runtimeDir, { recursive: true });

  const store = createStore(initializeStore(config.databasePath));
  const project = store.createProject({ path: repo, name: "repo" });
  await store.indexProject(project.id);
  store.db.close();

  const handle = await startWorkbenchServer({ config, inProcess: true });
  try {
    const inject = await handle.inject({
      method: "POST",
      url: "/retrieval/explain",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: { project: project.id, query: "how does login work", mode: "local", depth: "standard", limit: 8 },
    });
    assert.equal(inject.statusCode, 200);
    const body = JSON.parse(inject.body) as { status: string; data: { query: string; ranked: unknown[]; selected: unknown[]; confidence: number } };
    assert.equal(body.status, "ok");
    assert.equal(body.data.query, "how does login work");
    assert.ok(Array.isArray(body.data.ranked));
    assert.ok(Array.isArray(body.data.selected));
    assert.ok(body.data.confidence >= 0 && body.data.confidence <= 1);
    assert.ok((body.data.ranked as unknown[]).length >= 1, "expected at least one ranked chunk");
  } finally {
    await handle.close();
  }
  await rm(workspace, { recursive: true, force: true });
});

test("startWorkbenchServer respects an explicit intelligence stack override", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-api-stack-2-"));
  const config = resolveConfig({
    databasePath: join(workspace, "ai.db"),
    runtimeDir: join(workspace, "runtime"),
  });
  await mkdir(config.runtimeDir, { recursive: true });

  const runtime = createModelRuntime({
    providers: [],
    profiles: [],
    cloudEnabled: false,
  });
  const handle = await startWorkbenchServer({
    config,
    inProcess: true,
    intelligenceStack: { runtime, providers: [], profiles: [] },
  });
  try {
    const inject = await handle.inject({
      method: "GET",
      url: "/dashboard",
      headers: { accept: "application/json" },
    });
    assert.equal(inject.statusCode, 200);
  } finally {
    await handle.close();
  }
  await rm(workspace, { recursive: true, force: true });
});

test("API POST /reviews enqueues a review.reflect worker job", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-api-reviews-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "x.ts"), "export const x = 1;\n");

  const config = resolveConfig({
    databasePath: join(workspace, "ai.db"),
    runtimeDir: join(workspace, "runtime"),
  });
  await mkdir(config.runtimeDir, { recursive: true });

  const store = createStore(initializeStore(config.databasePath));
  const project = store.createProject({ path: repo, name: "repo" });
  store.db.close();

  const handle = await startWorkbenchServer({ config, inProcess: true });
  try {
    const inject = await handle.inject({
      method: "POST",
      url: "/reviews",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: { project: project.id, title: "First review", notes: "Test", checks: "typecheck,tests" },
    });
    assert.equal(inject.statusCode, 200);
    const body = JSON.parse(inject.body) as { status: string; data: { result: { id: string }; jobId: string } };
    assert.equal(body.status, "ok");
    assert.ok(body.data.result.id);
    assert.ok(body.data.jobId, "API should return a jobId for the queued review.reflect job");

    const verifyingStore = createStore(initializeStore(config.databasePath));
    try {
      const job = verifyingStore.db
        .prepare("SELECT * FROM jobs WHERE id = ?")
        .get(body.data.jobId) as { id: string; type: string; status: string; payload_json: string } | undefined;
      assert.ok(job);
      assert.equal(job!.type, "review.reflect");
      assert.equal(job!.status, "queued");
      const payload = JSON.parse(job!.payload_json) as { reviewId: string; source: string };
      assert.equal(payload.reviewId, body.data.result.id);
      assert.equal(payload.source, "api");
    } finally {
      verifyingStore.db.close();
    }
  } finally {
    await handle.close();
  }
  await rm(workspace, { recursive: true, force: true });
});
