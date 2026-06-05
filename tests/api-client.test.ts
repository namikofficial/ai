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
      },
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
