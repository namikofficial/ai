import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleMcpRequest } from "../mcp/server/src/tools.ts";
import { resolveConfig } from "../packages/config/src/index.ts";
import { createStore, initializeStore } from "../packages/db/src/store.ts";

test("serves MCP tools and logs calls", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-mcp-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "auth.ts"), "export const auth = true;\n");

  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "repo" });
  await store.indexProject(project.id);

  const config = resolveConfig({
    databasePath: join(workspace, "ai.db"),
    runtimeDir: join(workspace, "runtime"),
    apiUrl: "http://127.0.0.1:4242",
    webPort: 4242,
    apiPort: 4242,
  });

  const listResponse = await handleMcpRequest(store, config, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });
  assert.ok(listResponse?.result);
  assert.ok(JSON.stringify(listResponse?.result).includes("ai_create_plan"));

  const callResponse = await handleMcpRequest(store, config, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "ai_search_project",
      arguments: {
        project: project.id,
        query: "auth",
      },
    },
  });
  const callResult = callResponse?.result as { content: Array<{ type: string; text: string }> };
  assert.equal(callResult.content[0].type, "text");
  assert.ok(callResult.content[0].text.includes("auth"));

  const blockedResponse = await handleMcpRequest(store, config, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "not_a_tool",
      arguments: {},
    },
  });
  assert.equal(Boolean(blockedResponse?.error), true);
  assert.ok(store.listMcpCalls(10).length >= 2);
  const callId = store.listMcpCalls(10)[0]?.id;
  assert.equal(store.getMcpCall(callId ?? "")?.id, callId);

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("ai_run_check executes allowlisted project checks and blocks unknown checks", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-mcp-check-"));
  const repo = join(workspace, "repo");
  await mkdir(repo, { recursive: true });
  await writeFile(
    join(repo, ".ai-workbench.json"),
    JSON.stringify({
      checks: {
        node_version: "node --version",
      },
    })
  );

  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "repo" });
  const session = store.createSession({
    projectId: project.id,
    title: "check session",
    userGoal: "run checks",
    mode: "check",
    source: "test",
  });
  const config = resolveConfig({
    databasePath: join(workspace, "ai.db"),
    runtimeDir: join(workspace, "runtime"),
    apiUrl: "http://127.0.0.1:4242",
    webPort: 4242,
    apiPort: 4242,
  });

  try {
    const runResponse = await handleMcpRequest(store, config, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "ai_run_check",
        arguments: {
          name: "node_version",
          projectId: project.id,
          sessionId: session.id,
        },
      },
    });
    const runResult = runResponse?.result as { content: Array<{ type: string; text: string }> };
    const runPayload = JSON.parse(runResult.content[0].text) as {
      status: string;
      output: string;
      command: string;
      durationMs: number;
    };
    assert.equal(runPayload.status, "completed");
    assert.equal(runPayload.command, "node --version");
    assert.match(runPayload.output, /^v\d+/);
    assert.equal(typeof runPayload.durationMs, "number");

    const stored = store.listCheckRuns(10)[0];
    assert.equal(stored?.status, "completed");
    assert.equal(stored?.command, "node --version");
    assert.ok(store.listEvents(session.id, 10).some((event) => event.type === "check.completed"));

    const blockedResponse = await handleMcpRequest(store, config, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "ai_run_check",
        arguments: {
          name: "rm -rf /",
          projectId: project.id,
        },
      },
    });
    const blockedResult = blockedResponse?.result as { content: Array<{ type: string; text: string }> };
    const blockedPayload = JSON.parse(blockedResult.content[0].text) as {
      status: string;
      errorOutput: string;
      exitCode: number | null;
    };
    assert.equal(blockedPayload.status, "blocked");
    assert.match(blockedPayload.errorOutput, /allowlist/);
    assert.equal(blockedPayload.exitCode, null);
  } finally {
    store.db.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
