import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EMPTY_SESSION_TIMELINE_COUNTS, getTimelineCounts, getTimelineItems } from "../apps/web/src/timeline.ts";
import { handleMcpRequest } from "../mcp/server/src/tools.ts";
import { createStore, initializeStore } from "../packages/db/src/store.ts";
import type { SessionTimelineResponse } from "../packages/shared/src/index.ts";

test("DevPage exposes an Apply action for approved runs and keeps approve/cancel gated on awaiting_approval", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-web-dev-"));
  const pagesSource = await readFile("/home/namik/Documents/code/ai/apps/web/src/pages.tsx", "utf8");

  // Apply handler must call the api client and refresh detail + diff.
  assert.match(pagesSource, /handleApply/, "DevPage should define handleApply");
  assert.match(pagesSource, /api\.applyDevRun\(runId\)/, "DevPage must invoke api.applyDevRun(runId)");
  assert.match(pagesSource, /api\.getDevRun\(/, "DevPage must refresh dev run detail");
  assert.match(pagesSource, /api\.getDevRunDiff\(/, "DevPage must refresh dev run diff");

  // Approve/Cancel must live inside the awaiting_approval branch and Apply
  // must live inside its own approved branch — verify by isolating each branch
  // via regex.
  const applyBranch = pagesSource.match(/\{status === "approved" && \(([\s\S]*?)\)\}/);
  assert.ok(applyBranch, "Apply button branch must be gated on status === 'approved'");
  assert.match(applyBranch[1], /"Apply"/, "Apply branch must render an Apply button");

  const approveBranch = pagesSource.match(/\{status === "awaiting_approval" && \(([\s\S]*?)\)\}/);
  assert.ok(approveBranch, "approve/cancel branch must be gated on status === 'awaiting_approval'");
  assert.match(approveBranch[1], />\s*Approve\s*</, "approve branch must contain Approve button");
  assert.match(approveBranch[1], />\s*Cancel\s*</, "approve branch must contain Cancel button");
  assert.ok(
    !/>\s*Approve\s*</.test(applyBranch[1] ?? "") && !/>\s*Cancel\s*</.test(applyBranch[1] ?? ""),
    "Approve/Cancel must not appear inside the approved branch"
  );

  // The rendered Run Status panel must surface applied files and the final
  // status when the run is applied.
  assert.match(pagesSource, /applied files:/, "Run Status must show applied files");
  assert.match(pagesSource, /final status: applied/, "Run Status must show final status");

  // The handleApply handler must sequentially call applyDevRun and refresh.
  const handleApplyMatch = pagesSource.match(/const handleApply = async \(\) => \{([\s\S]*?)\};/);
  assert.ok(handleApplyMatch, "handleApply must be a defined function");
  const handleApplyBody = handleApplyMatch[1];
  const applyIdx = handleApplyBody.search(/api\.applyDevRun/);
  const refreshIdx = handleApplyBody.search(/refreshRunDetail/);
  assert.ok(applyIdx >= 0, "handleApply must call api.applyDevRun");
  assert.ok(refreshIdx >= 0, "handleApply must call refreshRunDetail to refresh detail + diff");
  assert.ok(refreshIdx > applyIdx, "refresh must occur after the apply call");

  await rm(workspace, { recursive: true, force: true });
});

test("ChecksPage wires the project selector and Execute/Record actions to the api client", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-web-checks-"));
  const pagesSource = await readFile("/home/namik/Documents/code/ai/apps/web/src/pages.tsx", "utf8");

  assert.match(pagesSource, /api\.executeCheck\(\{ name, projectId \}\)/, "ChecksPage must call api.executeCheck");
  assert.match(
    pagesSource,
    /api\.runCheck\(\{ name, projectId: projectId \|\| null \}\)/,
    "ChecksPage must keep legacy api.runCheck as record-only"
  );
  assert.match(pagesSource, /Execute check/, "ChecksPage must render the Execute check button");
  assert.match(pagesSource, /Record check only/, "ChecksPage must render the Record check only secondary action");

  await rm(workspace, { recursive: true, force: true });
});

test("WorkflowExecutionReviewPage renders isolated diff and explicit cleanup approval controls", async () => {
  const pagesSource = await readFile("/home/namik/Documents/code/ai/apps/web/src/pages.tsx", "utf8");
  for (const method of [
    "getActionExecutionArtifactDiff",
    "requestActionArtifactCleanup",
    "approveActionArtifactCleanup",
    "rejectActionArtifactCleanup",
  ]) {
    assert.ok(pagesSource.includes(`.${method}(`), `Workflow review must call api.${method}`);
  }
  assert.match(pagesSource, /Isolated workspace diff/);
  assert.match(pagesSource, /Approve reviewed cleanup/);
  assert.match(pagesSource, /Keep workspace/);
});

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

  const pagesSource = await readFile("/home/namik/Documents/code/ai/apps/web/src/pages.tsx", "utf8");
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

test("project deep links synchronize canonical selection and flow into work surfaces", async () => {
  const appSource = await readFile("/home/namik/Documents/code/ai/apps/web/src/App.tsx", "utf8");
  const pagesSource = await readFile("/home/namik/Documents/code/ai/apps/web/src/pages.tsx", "utf8");
  for (const suffix of ["work", "ask", "planner", "checks", "dev"]) {
    assert.ok(appSource.includes(`/projects/:projectId/${suffix}`), `missing project deep link for ${suffix}`);
  }
  assert.match(appSource, /api\.selectProject\(routeProjectId, null, "workbench_route"\)/);
  assert.match(appSource, /api\.getRegistry\(\)/);
  assert.match(appSource, /className="context-strip"/);
  assert.match(appSource, /path="\/runs\/:runId" element=\{<RunReviewPage \/>\}/);
  assert.match(appSource, /path="\/workflow-executions\/:executionId" element=\{<WorkflowExecutionReviewPage \/>\}/);
  assert.ok((pagesSource.match(/projectId: routeProjectId/g) ?? []).length >= 4);
  assert.match(pagesSource, /routeProjectId \?\? selectedProjectId/);
  assert.match(pagesSource, /function ProjectWorkPage/);
  assert.match(pagesSource, /api\.listDevRuns\(projectId\)/);
  assert.match(pagesSource, /function RunReviewPage/);
  const runReview = pagesSource.slice(
    pagesSource.indexOf("function RunReviewPage"),
    pagesSource.indexOf("function DevPage")
  );
  assert.ok(runReview.indexOf('title="Diff"') < runReview.indexOf('title="Checks and warnings"'));
  assert.match(runReview, /api\.approveDevRun\(runId\)/);
  assert.match(runReview, /api\.applyDevRun\(runId\)/);
  assert.match(pagesSource, /function WorkflowExecutionReviewPage/);
  assert.match(pagesSource, /api\.getActionExecutionArtifacts\(executionId\)/);
  assert.match(pagesSource, /api\.recoverActionExecution\(executionId, workflowId, "workbench-web"\)/);
  assert.match(pagesSource, /Review execution evidence/);
  assert.match(pagesSource, /api\s*\.getSessionContext\(\s*result\.sessionId/);
  assert.match(pagesSource, /api\s*\.saveSessionMemory\(\s*result\.sessionId/);
  assert.match(pagesSource, /api\.plan\(\{ project, goal, risk, sessionId: inheritedSessionId \}\)/);
  assert.match(pagesSource, /sessionId: inheritedSessionId/);
  assert.match(pagesSource, /Turn into plan/);
  assert.match(pagesSource, /Start development run/);
  assert.match(appSource, /path="\/handoffs\/:handoffId" element=\{<HandoffDetailPage \/>\}/);
  assert.match(appSource, /path="\/projects\/:projectId\/handoff" element=\{<HandoffPage \/>\}/);
  assert.match(pagesSource, /function HandoffDetailPage/);
  assert.match(pagesSource, /searchParams\.get\("session"\)/);
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
