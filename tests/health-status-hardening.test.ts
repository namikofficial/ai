import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { startWorkbenchServer } from "../apps/api/src/server.ts";
import { runtimeHealthSchema } from "../packages/contracts/src/index.ts";

test("api: health and status are read-only and redacted", async () => {
  const tmpRuntime = join(process.cwd(), "tmp-api-test");
  rmSync(tmpRuntime, { recursive: true, force: true });
  mkdirSync(tmpRuntime, { recursive: true });

  const handle = await startWorkbenchServer({
    config: {
      runtimeDir: tmpRuntime,
      databasePath: join(tmpRuntime, "test.db"),
      apiPort: 0, // dynamic
    },
  });

  try {
    // Health check
    const healthRes = await handle.inject({ method: "GET", url: "/health" });
    if (healthRes.statusCode !== 200) {
      console.log("API ERROR BODY:", healthRes.body);
    }
    assert.equal(healthRes.statusCode, 200);
    const health = JSON.parse(healthRes.body);
    assert.equal(health.status, "ok");
    assert.ok(health.data.databasePath.includes(".../test.db"));
    assert.ok(health.data.runtimeDir.includes(".../tmp-api-test"));
    assert.equal(health.data.databaseReachable, true);

    // Status check
    const statusRes = await handle.inject({ method: "GET", url: "/status" });
    assert.equal(statusRes.statusCode, 200);
    const status = JSON.parse(statusRes.body);
    assert.equal(status.status, "ok");
    assert.ok(status.data.health.databasePath.includes(".../test.db"));

    // Verify no mutation (basic check: project count should be 0)
    assert.equal(health.data.projectCount, 0);
  } finally {
    await handle.close();
    rmSync(tmpRuntime, { recursive: true, force: true });
  }
});

test("api: core readiness remains available when optional local runtimes are offline", async () => {
  const tmpRuntime = join(process.cwd(), "tmp-runtime-health-test");
  rmSync(tmpRuntime, { recursive: true, force: true });
  mkdirSync(tmpRuntime, { recursive: true });
  const previousModelUrl = process.env.AI_LOCAL_BASE_URL;
  const previousEmbeddingUrl = process.env.AI_EMBEDDING_BASE_URL;
  process.env.AI_LOCAL_BASE_URL = "http://127.0.0.1:1/v1";
  process.env.AI_EMBEDDING_BASE_URL = "http://127.0.0.1:1/v1";

  const handle = await startWorkbenchServer({
    config: {
      runtimeDir: tmpRuntime,
      databasePath: join(tmpRuntime, "test.db"),
      apiPort: 0,
      qdrantEnabled: false,
      qdrantUrl: null,
    },
  });

  try {
    const readyRes = await handle.inject({ method: "GET", url: "/ready" });
    assert.equal(readyRes.statusCode, 200);
    assert.deepEqual(JSON.parse(readyRes.body).data, { ready: true, databaseReachable: true });

    const runtimeRes = await handle.inject({ method: "GET", url: "/runtime/health" });
    assert.equal(runtimeRes.statusCode, 200);
    const runtime = runtimeHealthSchema.parse(JSON.parse(runtimeRes.body).data);
    assert.equal(runtime.ready, true);
    assert.equal(runtime.state, "stale");
    assert.equal(runtime.components.find((component) => component.id === "sqlite")?.ready, true);
    assert.equal(runtime.components.find((component) => component.id === "model-manager")?.state, "offline");
    assert.equal(runtime.components.find((component) => component.id === "qdrant")?.state, "unknown");

    const deepRes = await handle.inject({ method: "GET", url: "/health/deep" });
    assert.equal(deepRes.statusCode, 200);
    const deep = JSON.parse(deepRes.body).data;
    assert.equal(deep.ready, true);
    assert.equal(deep.healthStatus, "degraded");
  } finally {
    await handle.close();
    if (previousModelUrl === undefined) delete process.env.AI_LOCAL_BASE_URL;
    else process.env.AI_LOCAL_BASE_URL = previousModelUrl;
    if (previousEmbeddingUrl === undefined) delete process.env.AI_EMBEDDING_BASE_URL;
    else process.env.AI_EMBEDDING_BASE_URL = previousEmbeddingUrl;
    rmSync(tmpRuntime, { recursive: true, force: true });
  }
});
