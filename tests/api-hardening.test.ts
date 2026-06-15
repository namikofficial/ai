import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { startWorkbenchServer } from "../apps/api/src/server.ts";

async function withServer(fn: (handle: Awaited<ReturnType<typeof startWorkbenchServer>>) => Promise<void>) {
  const tmpRuntime = join(process.cwd(), "tmp-api-hardening");
  rmSync(tmpRuntime, { recursive: true, force: true });
  mkdirSync(tmpRuntime, { recursive: true });

  const handle = await startWorkbenchServer({
    config: {
      runtimeDir: tmpRuntime,
      databasePath: join(tmpRuntime, "test.db"),
      apiPort: 0,
    },
  });

  try {
    await fn(handle);
  } finally {
    await handle.close();
    rmSync(tmpRuntime, { recursive: true, force: true });
  }
}

test("GET /health returns JSON envelope { status: ok, data }", async () => {
  await withServer(async (handle) => {
    const res = await handle.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, "ok");
    assert.ok(body.data);
    assert.equal(typeof body.data.databaseReachable, "boolean");
  });
});

test("GET /dashboard with Accept: text/html returns HTML", async () => {
  await withServer(async (handle) => {
    const res = await handle.inject({
      method: "GET",
      url: "/dashboard",
      headers: { accept: "text/html" },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.toLowerCase().includes("<!doctype"), "Expected HTML doctype");
    assert.ok(res.body.includes("<html"), "Expected HTML root element");
  });
});

test("GET /projects with Accept: application/json returns JSON list", async () => {
  await withServer(async (handle) => {
    const res = await handle.inject({
      method: "GET",
      url: "/projects",
      headers: { accept: "application/json" },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, "ok");
    assert.ok(Array.isArray(body.data));
  });
});

test("POST /projects with JSON body creates project and returns { status: ok, data }", async () => {
  await withServer(async (handle) => {
    const res = await handle.inject({
      method: "POST",
      url: "/projects",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: { path: "/tmp/test-project", name: "test-project" },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, "ok");
    assert.ok(body.data?.id, "Expected project id in response");
    assert.equal(body.data.name, "test-project");
  });
});

test("POST /projects with urlencoded body creates project and returns JSON", async () => {
  await withServer(async (handle) => {
    const res = await handle.inject({
      method: "POST",
      url: "/projects",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: { path: "/tmp/test-project-urlencoded", name: "test-urlencoded" },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, "ok");
    assert.ok(body.data?.id);
    assert.equal(body.data.name, "test-urlencoded");
  });
});

test("POST with malformed JSON returns clean 400 with { status: error }", async () => {
  await withServer(async (handle) => {
    const res = await handle.inject({
      method: "POST",
      url: "/projects",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: "{ invalid json }",
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.status, "error");
    assert.ok(body.error?.message);
    assert.ok(!res.body.includes("Internal Server Error"), "Should not return generic 500 message");
    assert.ok(!res.body.includes("Unexpected token"), "Should not expose raw parse error");
  });
});

// SSE route test omitted: supertest's inject() waits for response body to complete,
// but SSE streams never close (they stay open for live events). SSE hardening is
// verified via code inspection: X-Accel-Buffering: no header is set in sse.ts.

test("unknown route with Accept: application/json returns JSON 404", async () => {
  await withServer(async (handle) => {
    const res = await handle.inject({
      method: "GET",
      url: "/this-route-does-not-exist",
      headers: { accept: "application/json" },
    });
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.equal(body.status, "error");
    assert.ok(body.error?.message);
  });
});

test("unknown route with Accept: text/html returns HTML 404", async () => {
  await withServer(async (handle) => {
    const res = await handle.inject({
      method: "GET",
      url: "/this-route-does-not-exist",
      headers: { accept: "text/html" },
    });
    assert.equal(res.statusCode, 404);
    assert.ok(res.body.includes("<html"), "Expected HTML response");
  });
});
