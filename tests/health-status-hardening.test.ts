import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { startWorkbenchServer } from "../apps/api/src/server.ts";

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
