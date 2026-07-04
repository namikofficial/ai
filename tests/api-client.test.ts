import assert from "node:assert/strict";
import test from "node:test";
import { createApiClient } from "../packages/api-client/src/index.ts";

test("api client serializes project symbols query params explicitly", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    return new Response(
      JSON.stringify({
        status: "ok",
        data: {
          project: { id: "project-1", path: "/repo", name: "repo" },
          symbols: [],
          query: "",
          limit: 0,
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  }) as typeof fetch;

  try {
    const api = createApiClient({ baseUrl: "http://127.0.0.1:4242" });
    const response = await api.listProjectSymbols("project-1", { query: "", limit: 0 });
    assert.equal(response.data.query, "");
    assert.equal(response.data.limit, 0);
    assert.equal(calls[0], "http://127.0.0.1:4242/projects/project-1/symbols?query=&limit=0");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("api client exposes executeCheck for POST /checks/execute", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return new Response(
      JSON.stringify({
        status: "ok",
        data: {
          id: "check_1",
          name: "typecheck",
          status: "completed",
          command: "pnpm typecheck",
          output: "ok",
          errorOutput: null,
          exitCode: 0,
          durationMs: 1234,
          parsedErrors: [],
          affectedFiles: ["src/foo.ts"],
          startedAt: null,
          finishedAt: null,
          createdAt: "",
          updatedAt: "",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const api = createApiClient({ baseUrl: "http://127.0.0.1:4242" });
    const response = await api.executeCheck({ name: "typecheck", projectId: "project-1" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "http://127.0.0.1:4242/checks/execute");
    assert.equal(calls[0]!.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), {
      name: "typecheck",
      projectId: "project-1",
    });
    assert.equal(response.data.durationMs, 1234);
    assert.deepEqual(response.data.affectedFiles, ["src/foo.ts"]);
    assert.deepEqual(response.data.parsedErrors, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("api client applyDevRun targets /dev/runs/:runId/apply and returns applied files", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return new Response(
      JSON.stringify({
        status: "ok",
        data: {
          run: {
            id: "run_1",
            status: "applied",
            appliedFiles: ["src/a.ts", "src/b.ts"],
            appliedAt: "2026-07-04T00:00:00.000Z",
          },
          applied: ["src/a.ts", "src/b.ts"],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const api = createApiClient({ baseUrl: "http://127.0.0.1:4242" });
    const response = await api.applyDevRun("run_1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "http://127.0.0.1:4242/dev/runs/run_1/apply");
    assert.equal(calls[0]?.init?.method, "POST");
    const data = response.data as { run: { status: string; appliedFiles: string[] }; applied: string[] };
    assert.equal(data.run.status, "applied");
    assert.deepEqual(data.run.appliedFiles, ["src/a.ts", "src/b.ts"]);
    assert.deepEqual(data.applied, ["src/a.ts", "src/b.ts"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
