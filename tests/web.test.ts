import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeStore, createStore } from "../packages/db/src/store.ts";
import { handleMcpRequest } from "../mcp/server/src/tools.ts";

test("defines the Vite React shell and router surface", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-web-"));
  const indexHtml = await readFile("/home/namik/Documents/code/ai/apps/web/index.html", "utf8");
  assert.ok(indexHtml.includes('id="root"'));
  assert.ok(indexHtml.includes("/src/main.tsx"));

  const appSource = await readFile("/home/namik/Documents/code/ai/apps/web/src/App.tsx", "utf8");
  for (const path of [
    "/dashboard",
    "/projects",
    "/sessions",
    "/tasks",
    "/agents",
    "/ask",
    "/planner",
    "/handoff",
    "/checks",
    "/memory",
    "/retrieval",
    "/retrieval/queries",
    "/skills",
    "/eval",
    "/reviews",
    "/models",
    "/mcp",
    "/settings",
  ]) {
    assert.ok(appSource.includes(path), `expected router surface to include ${path}`);
  }

  const pagesSource = await readFile("/home/namik/Documents/code/ai/apps/web/src/pages.tsx", "utf8");
  for (const name of [
    "AgentRunDetailPage",
    "AgentsPage",
    "EvalPage",
    "MemoryPage",
    "ModelsPage",
    "RetrievalPage",
    "RetrievalQueryDetailPage",
    "SkillsPage",
  ]) {
    assert.ok(pagesSource.includes(name), `expected pages module to export ${name}`);
  }

  await rm(workspace, { recursive: true, force: true });
});

test("logs MCP calls through the shared store", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-web-"));
  const repo = join(workspace, "sample-repo");
  await mkdir(join(repo, "src"), { recursive: true });
  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "sample-repo" });
  await store.indexProject(project.id);
  const mcpCall = handleMcpRequest(store, {
    databasePath: join(workspace, "ai.db"),
    runtimeDir: join(workspace, "runtime"),
    apiUrl: "http://127.0.0.1:4242",
    webPort: 3000,
    apiPort: 4242,
    cloudEnabled: false,
    qdrantEnabled: false,
    qdrantUrl: null,
    qdrantCollection: "ai_chunks",
  }, {
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: {
      name: "ai_search_project",
      arguments: {
        project: project.id,
        query: "auth",
      },
    },
  });
  assert.equal(Boolean(mcpCall?.result), true);
  assert.ok(store.listMcpCalls(10).length > 0);
  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});
