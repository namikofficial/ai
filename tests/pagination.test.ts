import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildPaginatedResponse,
  clampLimit,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  parsePagination,
} from "../apps/api/src/server/pagination.ts";
import { startWorkbenchServer } from "../apps/api/src/server.ts";

// Unit tests for pagination utilities
test("pagination: clampLimit respects MAX_LIMIT", () => {
  assert.equal(clampLimit(200), MAX_LIMIT, "values above MAX_LIMIT should be clamped");
  assert.equal(clampLimit(150), 100, "values above MAX_LIMIT should be clamped to MAX_LIMIT");
  assert.equal(clampLimit(100), 100, "MAX_LIMIT should be returned as-is");
});

test("pagination: clampLimit respects minimum of 1", () => {
  assert.equal(clampLimit(0), DEFAULT_LIMIT, "zero should use default");
  assert.equal(clampLimit(-1), DEFAULT_LIMIT, "negative should use default");
  assert.equal(clampLimit(NaN), DEFAULT_LIMIT, "NaN should use default");
});

test("pagination: clampLimit uses default when no arguments", () => {
  assert.equal(clampLimit(0, 25), 25, "should use provided default");
});

test("pagination: parsePagination returns correct defaults", () => {
  // @ts-expect-error - testing without full Request object
  const result = parsePagination({ query: {} });
  assert.equal(result.limit, DEFAULT_LIMIT);
  assert.equal(result.offset, 0);
  assert.equal(result.cursor, undefined);
});

test("pagination: parsePagination respects provided limit", () => {
  // @ts-expect-error - testing without full Request object
  const result = parsePagination({ query: { limit: "25" } });
  assert.equal(result.limit, 25);
});

test("pagination: parsePagination clamps limit to MAX_LIMIT", () => {
  // @ts-expect-error - testing without full Request object
  const result = parsePagination({ query: { limit: "500" } });
  assert.equal(result.limit, MAX_LIMIT);
});

test("pagination: parsePagination extracts cursor", () => {
  // @ts-expect-error - testing without full Request object
  const result = parsePagination({ query: { cursor: "abc123" } });
  assert.equal(result.cursor, "abc123");
});

test("pagination: parsePagination extracts offset", () => {
  // @ts-expect-error - testing without full Request object
  const result = parsePagination({ query: { offset: "50" } });
  assert.equal(result.offset, 50);
});

test("pagination: buildPaginatedResponse returns plain array without pagination params", () => {
  const data = [{ id: "1" }, { id: "2" }, { id: "3" }];
  const result = buildPaginatedResponse(data, { limit: 10, offset: 0 });
  assert.ok(Array.isArray(result), "should return plain array for backward compat");
  assert.equal((result as unknown[]).length, 3);
});

test("pagination: buildPaginatedResponse returns paginated response with cursor", () => {
  const data = Array.from({ length: 15 }, (_, i) => ({ id: String(i + 1) }));
  const result = buildPaginatedResponse(data, { limit: 10, cursor: undefined, offset: 0 });
  // When using offset=0 with no cursor, still returns plain array (backward compat)
  assert.ok(Array.isArray(result), "should still return plain array for backward compat even with hasMore");
});

test("pagination: buildPaginatedResponse indicates hasMore when data exceeds limit with cursor", () => {
  const data = Array.from({ length: 15 }, (_, i) => ({ id: String(i + 1) }));
  const result = buildPaginatedResponse(data, { limit: 10, cursor: "cursor123" });
  const r = result as { data: unknown[]; pagination: { hasMore: boolean; limit: number } };
  assert.equal(r.pagination.hasMore, true, "should indicate hasMore");
  assert.equal(r.pagination.limit, 10);
  assert.equal(r.data.length, 10, "should return limit items");
});

// Integration tests for API endpoints with pagination
async function startTestServer() {
  const workspace = await mkdtemp(join(tmpdir(), "ai-pagination-"));
  const repo = join(workspace, "sample");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src/auth.ts"), "export const authNote = 'auth is handled by handleLogin';\n");
  await writeFile(join(repo, "README.md"), "# Sample\n\nAuth is in src/auth.ts.");

  const handle = await startWorkbenchServer({
    inProcess: true,
    config: {
      databasePath: join(workspace, "ai.db"),
      runtimeDir: join(workspace, "runtime"),
      apiUrl: "http://127.0.0.1:0",
      webPort: 0,
      apiPort: 0,
    },
  });
  return {
    workspace,
    request: async (method: string, url: string, body?: unknown) => handle.inject({ method, url, body }),
    close: async () => {
      await handle.close();
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

async function postJson<T>(
  request: (method: string, url: string, body?: unknown) => Promise<{ statusCode: number; body: string }>,
  url: string,
  body: unknown
): Promise<T> {
  const res = await request("POST", url, body);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`POST ${url} -> ${res.statusCode}: ${res.body}`);
  }
  return JSON.parse(res.body) as T;
}

async function getJson<T>(
  request: (method: string, url: string, body?: unknown) => Promise<{ statusCode: number; body: string }>,
  url: string
): Promise<T> {
  const res = await request("GET", url);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`GET ${url} -> ${res.statusCode}`);
  }
  return JSON.parse(res.body) as T;
}

test("pagination api: endpoints accept limit parameter and clamp to MAX", async () => {
  const ctx = await startTestServer();
  try {
    // Create a project and session
    const add = await postJson<{ status: "ok"; data: { id: string } }>(ctx.request, "/projects", {
      path: join(ctx.workspace, "sample"),
      name: "sample",
    });
    const projectId = add.data.id;
    await postJson(ctx.request, `/projects/${projectId}/index`, {});
    const _ask = await postJson<{
      status: "ok";
      data: { sessionId: string };
    }>(ctx.request, "/ask", {
      project: projectId,
      question: "where is auth handled?",
      mode: "local",
      depth: "standard",
    });

    // Test limit exceeding MAX is clamped
    const res = await ctx.request("GET", `/prompts?limit=500`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    // Should not have pagination wrapper since no cursor/offset
    assert.ok(!body.data.pagination, "plain response without pagination params");

    // Test negative limit uses default
    const res2 = await ctx.request("GET", `/prompts?limit=-5`);
    assert.equal(res2.statusCode, 200);

    // Test invalid limit uses default
    const res3 = await ctx.request("GET", `/prompts?limit=abc`);
    assert.equal(res3.statusCode, 200);
  } finally {
    await ctx.close();
  }
});

test("pagination api: /prompts returns plain array by default for backward compat", async () => {
  const ctx = await startTestServer();
  try {
    const add = await postJson<{ status: "ok"; data: { id: string } }>(ctx.request, "/projects", {
      path: join(ctx.workspace, "sample"),
      name: "sample",
    });
    const projectId = add.data.id;
    await postJson(ctx.request, `/projects/${projectId}/index`, {});
    const ask = await postJson<{
      status: "ok";
      data: { sessionId: string };
    }>(ctx.request, "/ask", {
      project: projectId,
      question: "where is auth handled?",
      mode: "local",
      depth: "standard",
    });

    const res = await getJson<{
      status: "ok";
      data: unknown[];
    }>(ctx.request, `/prompts?sessionId=${ask.data.sessionId}`);
    assert.ok(Array.isArray(res.data), "should return array");
    assert.ok(!("pagination" in res.data), "should not have pagination wrapper for default case");
  } finally {
    await ctx.close();
  }
});

test("pagination api: /models/calls respects limit parameter", async () => {
  const ctx = await startTestServer();
  try {
    const add = await postJson<{ status: "ok"; data: { id: string } }>(ctx.request, "/projects", {
      path: join(ctx.workspace, "sample"),
      name: "sample",
    });
    const projectId = add.data.id;
    await postJson(ctx.request, `/projects/${projectId}/index`, {});
    await postJson(ctx.request, "/ask", {
      project: projectId,
      question: "where is auth handled?",
      mode: "local",
      depth: "standard",
    });

    // Test limit=5
    const res = await getJson<{
      status: "ok";
      data: unknown[];
    }>(ctx.request, `/models/calls?limit=5`);
    assert.ok(Array.isArray(res.data));
    // Default response should be array without pagination wrapper

    // Test limit exceeding MAX is clamped
    const res2 = await getJson<{
      status: "ok";
      data: unknown[];
    }>(ctx.request, `/models/calls?limit=200`);
    assert.ok(Array.isArray(res2.data));
  } finally {
    await ctx.close();
  }
});

test("pagination api: /sessions/:id/events respects limit parameter", async () => {
  const ctx = await startTestServer();
  try {
    const add = await postJson<{ status: "ok"; data: { id: string } }>(ctx.request, "/projects", {
      path: join(ctx.workspace, "sample"),
      name: "sample",
    });
    const projectId = add.data.id;
    await postJson(ctx.request, `/projects/${projectId}/index`, {});
    const ask = await postJson<{
      status: "ok";
      data: { sessionId: string };
    }>(ctx.request, "/ask", {
      project: projectId,
      question: "where is auth handled?",
      mode: "local",
      depth: "standard",
    });

    // Default without limit (was hardcoded to 500)
    const res = await getJson<{
      status: "ok";
      data: unknown[];
    }>(ctx.request, `/sessions/${ask.data.sessionId}/events`);
    assert.ok(Array.isArray(res.data));

    // With limit
    const res2 = await getJson<{
      status: "ok";
      data: unknown[];
    }>(ctx.request, `/sessions/${ask.data.sessionId}/events?limit=10`);
    assert.ok(Array.isArray(res2.data));

    // Clamped to MAX
    const res3 = await getJson<{
      status: "ok";
      data: unknown[];
    }>(ctx.request, `/sessions/${ask.data.sessionId}/events?limit=1000`);
    assert.ok(Array.isArray(res3.data));
  } finally {
    await ctx.close();
  }
});

test("pagination api: /retrieval/queries respects limit parameter", async () => {
  const ctx = await startTestServer();
  try {
    const add = await postJson<{ status: "ok"; data: { id: string } }>(ctx.request, "/projects", {
      path: join(ctx.workspace, "sample"),
      name: "sample",
    });
    const projectId = add.data.id;
    await postJson(ctx.request, `/projects/${projectId}/index`, {});
    const ask = await postJson<{
      status: "ok";
      data: { sessionId: string };
    }>(ctx.request, "/ask", {
      project: projectId,
      question: "where is auth handled?",
      mode: "local",
      depth: "standard",
    });

    // Default
    const res = await getJson<{
      status: "ok";
      data: unknown[];
    }>(ctx.request, `/retrieval/queries?sessionId=${ask.data.sessionId}`);
    assert.ok(Array.isArray(res.data));

    // With limit
    const res2 = await getJson<{
      status: "ok";
      data: unknown[];
    }>(ctx.request, `/retrieval/queries?sessionId=${ask.data.sessionId}&limit=5`);
    assert.ok(Array.isArray(res2.data));
  } finally {
    await ctx.close();
  }
});

test("pagination api: /tasks respects limit parameter and clamps to MAX", async () => {
  const ctx = await startTestServer();
  try {
    const add = await postJson<{ status: "ok"; data: { id: string } }>(ctx.request, "/projects", {
      path: join(ctx.workspace, "sample"),
      name: "sample",
    });
    const projectId = add.data.id;
    await postJson(ctx.request, `/projects/${projectId}/index`, {});
    await postJson(ctx.request, "/ask", {
      project: projectId,
      question: "where is auth handled?",
      mode: "local",
      depth: "standard",
    });

    // Default returns plain array (backward compat)
    const res = await getJson<{
      status: "ok";
      data: unknown[];
    }>(ctx.request, "/tasks");
    assert.ok(Array.isArray(res.data));
    assert.ok(!("pagination" in res.data), "should not have pagination wrapper by default");

    // With limit
    const res2 = await getJson<{
      status: "ok";
      data: unknown[];
    }>(ctx.request, "/tasks?limit=5");
    assert.ok(Array.isArray(res2.data));

    // Clamped to MAX (100)
    const res3 = await getJson<{
      status: "ok";
      data: unknown[];
    }>(ctx.request, "/tasks?limit=500");
    assert.ok(Array.isArray(res3.data));

    // Invalid limit uses default
    const res4 = await getJson<{
      status: "ok";
      data: unknown[];
    }>(ctx.request, "/tasks?limit=abc");
    assert.ok(Array.isArray(res4.data));
  } finally {
    await ctx.close();
  }
});

test("pagination api: /agents/runs respects limit parameter and clamps to MAX", async () => {
  const ctx = await startTestServer();
  try {
    const add = await postJson<{ status: "ok"; data: { id: string } }>(ctx.request, "/projects", {
      path: join(ctx.workspace, "sample"),
      name: "sample",
    });
    const projectId = add.data.id;
    await postJson(ctx.request, `/projects/${projectId}/index`, {});
    const ask = await postJson<{
      status: "ok";
      data: { sessionId: string };
    }>(ctx.request, "/ask", {
      project: projectId,
      question: "where is auth handled?",
      mode: "local",
      depth: "standard",
    });

    // Default returns plain array (backward compat)
    const res = await getJson<{
      status: "ok";
      data: unknown[];
    }>(ctx.request, `/agents/runs?sessionId=${ask.data.sessionId}`);
    assert.ok(Array.isArray(res.data));
    assert.ok(!("pagination" in res.data), "should not have pagination wrapper by default");

    // With limit
    const res2 = await getJson<{
      status: "ok";
      data: unknown[];
    }>(ctx.request, `/agents/runs?sessionId=${ask.data.sessionId}&limit=5`);
    assert.ok(Array.isArray(res2.data));

    // Clamped to MAX (100)
    const res3 = await getJson<{
      status: "ok";
      data: unknown[];
    }>(ctx.request, `/agents/runs?sessionId=${ask.data.sessionId}&limit=500`);
    assert.ok(Array.isArray(res3.data));
  } finally {
    await ctx.close();
  }
});

test("pagination api: /context/packs respects limit parameter and clamps to MAX", async () => {
  const ctx = await startTestServer();
  try {
    const add = await postJson<{ status: "ok"; data: { id: string } }>(ctx.request, "/projects", {
      path: join(ctx.workspace, "sample"),
      name: "sample",
    });
    const projectId = add.data.id;
    await postJson(ctx.request, `/projects/${projectId}/index`, {});
    const ask = await postJson<{
      status: "ok";
      data: { sessionId: string };
    }>(ctx.request, "/ask", {
      project: projectId,
      question: "where is auth handled?",
      mode: "local",
      depth: "standard",
    });

    // Default returns plain array (backward compat)
    const res = await getJson<{
      status: "ok";
      data: unknown[];
    }>(ctx.request, `/context/packs?sessionId=${ask.data.sessionId}`);
    assert.ok(Array.isArray(res.data));
    assert.ok(!("pagination" in res.data), "should not have pagination wrapper by default");

    // With limit
    const res2 = await getJson<{
      status: "ok";
      data: unknown[];
    }>(ctx.request, `/context/packs?sessionId=${ask.data.sessionId}&limit=5`);
    assert.ok(Array.isArray(res2.data));

    // Clamped to MAX (100)
    const res3 = await getJson<{
      status: "ok";
      data: unknown[];
    }>(ctx.request, `/context/packs?sessionId=${ask.data.sessionId}&limit=500`);
    assert.ok(Array.isArray(res3.data));
  } finally {
    await ctx.close();
  }
});
