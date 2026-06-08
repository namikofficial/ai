import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EMPTY_SESSION_TIMELINE_COUNTS,
  getTimelineCounts,
  getTimelineItems,
} from "../apps/web/src/timeline.ts";
import { handleMcpRequest } from "../mcp/server/src/tools.ts";
import { createStore, initializeStore } from "../packages/db/src/store.ts";
import type { SessionTimelineResponse, TimelineItem } from "../packages/shared/src/index.ts";

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
    "/prompt-lab",
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

  const pagesSource = await readFile(
    "/home/namik/Documents/code/ai/apps/web/src/pages.tsx",
    "utf8"
  );
  for (const name of [
    "AgentRunDetailPage",
    "AgentsPage",
    "EvalPage",
    "MemoryPage",
    "ModelsPage",
    "PromptLabPage",
    "RetrievalPage",
    "RetrievalQueryDetailPage",
    "SkillsPage",
    "SessionTimelinePanel",
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
  const mcpCall = await handleMcpRequest(
    store,
    {
      databasePath: join(workspace, "ai.db"),
      runtimeDir: join(workspace, "runtime"),
      apiUrl: "http://127.0.0.1:4242",
      webPort: 3000,
      apiPort: 4242,
      cloudEnabled: false,
      qdrantEnabled: false,
      qdrantUrl: null,
      qdrantCollection: "ai_chunks",
    },
    {
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
    }
  );
  assert.equal(Boolean(mcpCall?.result), true);
  assert.ok(store.listMcpCalls(10).length > 0);
  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("session timeline helper handles empty timeline data safely", () => {
  assert.deepEqual(getTimelineItems(null), []);
  assert.deepEqual(getTimelineCounts(null), EMPTY_SESSION_TIMELINE_COUNTS);
});

test("timeline link generation produces correct links and avoids broken links", () => {
  const timeline: SessionTimelineResponse = {
    session: {
      id: "test-session",
      projectId: "test-project",
      title: "test",
      userGoal: "test",
      mode: "local",
      status: "running",
      source: "test",
      startedAt: "",
      finishedAt: null,
      durationMs: null,
      activeTaskId: null,
      modelProfile: null,
      finalSummary: null,
      errorMessage: null,
      createdAt: "",
      updatedAt: "",
    },
    timeline: [],
    counts: EMPTY_SESSION_TIMELINE_COUNTS,
    items: [
      {
        id: "1",
        ts: "2026-01-01T00:00:00.000Z",
        kind: "compiled_prompt",
        title: "Prompt",
        summary: "Compiled prompt summary",
        refs: { promptId: "prompt-1" },
        payload: {},
      },
      {
        id: "2",
        ts: "2026-01-01T00:00:01.000Z",
        kind: "retrieval_query",
        title: "Retrieval",
        summary: "Retrieval query summary",
        refs: { queryId: "query-1" },
        payload: {},
      },
      {
        id: "3",
        ts: "2026-01-01T00:00:02.000Z",
        kind: "agent_run",
        title: "Agent Run",
        summary: "Agent run summary",
        refs: { runId: "run-1" },
        payload: {},
      },
      {
        id: "4",
        ts: "2026-01-01T00:00:03.000Z",
        kind: "model_call",
        title: "Model Call",
        summary: "Model call summary",
        refs: { callId: "call-1" },
        payload: {},
      },
      {
        id: "5",
        ts: "2026-01-01T00:00:04.000Z",
        kind: "context_pack",
        title: "Context Pack",
        summary: "Context pack summary",
        refs: { packId: "pack-1" },
        payload: {},
      },
      {
        id: "6",
        ts: "2026-01-01T00:00:05.000Z",
        kind: "eval",
        title: "Outcome",
        summary: "Outcome summary",
        refs: { outcomeId: "outcome-1" },
        payload: {},
      },
    ],
  };
  const items = getTimelineItems(timeline);

  assert.equal(items[0]?.link, "/prompts/prompt-1");
  assert.equal(items[1]?.link, "/retrieval/queries/query-1");
  assert.equal(items[2]?.link, "/agents/runs/run-1");
  assert.equal(items[3]?.link, undefined);
  assert.equal(items[4]?.link, undefined);
  assert.equal(items[5]?.link, undefined);
});
