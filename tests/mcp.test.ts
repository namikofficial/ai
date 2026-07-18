import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkbenchServer } from "../apps/api/src/server.ts";
import { handleMcpRequest } from "../mcp/server/src/tools.ts";
import { resolveConfig } from "../packages/config/src/index.ts";
import type { ProjectManifest } from "../packages/contracts/src/index.ts";
import { createStore, initializeStore } from "../packages/db/src/store.ts";

const contractFixture = JSON.parse(
  await readFile(new URL("./fixtures/contracts/v1-control-plane.json", import.meta.url), "utf8")
) as { ProjectManifest: ProjectManifest };

function mcpText(response: Awaited<ReturnType<typeof handleMcpRequest>>): unknown {
  const result = response?.result as { content?: Array<{ text?: string }> } | undefined;
  return JSON.parse(result?.content?.[0]?.text ?? "null");
}

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

test("MCP clients share canonical sessions, messages, and context previews", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-mcp-session-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "context.ts"), "export const canonicalContext = true;\n");
  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "session repo" });
  await store.indexProject(project.id);
  const config = resolveConfig({
    databasePath: join(workspace, "ai.db"),
    runtimeDir: join(workspace, "runtime"),
    apiUrl: "http://127.0.0.1:4242",
    webPort: 4242,
    apiPort: 4242,
  });

  try {
    const createdResponse = await handleMcpRequest(store, config, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "ai_create_session",
        arguments: { project: project.id, goal: "Explain canonicalContext", title: "Shared MCP session" },
      },
    });
    const createdResult = createdResponse?.result as { content: Array<{ text: string }> };
    const session = JSON.parse(createdResult.content[0].text) as { id: string; projectId: string };
    assert.equal(session.projectId, project.id);

    const appendedResponse = await handleMcpRequest(store, config, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "ai_append_session_message",
        arguments: { sessionId: session.id, role: "user", content: "Where is canonicalContext defined?" },
      },
    });
    assert.equal(Boolean(appendedResponse?.error), false);
    assert.equal(store.conversation.listMessages(session.id).length, 1);

    const contextResponse = await handleMcpRequest(store, config, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "ai_get_session_context",
        arguments: { sessionId: session.id, query: "canonicalContext", tokenBudget: 4000 },
      },
    });
    const contextResult = contextResponse?.result as { content: Array<{ text: string }> };
    const context = JSON.parse(contextResult.content[0].text) as {
      schemaVersion: number;
      selectedFiles: string[];
      included: Array<{ reason: string }>;
    };
    assert.equal(context.schemaVersion, 1);
    assert.ok(context.selectedFiles.includes("src/context.ts"));
    assert.ok(context.included.every((item) => item.reason.length > 0));

    const scopeResponse = await handleMcpRequest(store, config, {
      jsonrpc: "2.0",
      id: "scope",
      method: "tools/call",
      params: {
        name: "ai_get_session_context_scope",
        arguments: { sessionId: session.id },
      },
    });
    const scope = mcpText(scopeResponse) as { sessionId: string; includeRetrieval: boolean; tokenBudget: number };
    assert.equal(scope.sessionId, session.id);
    assert.equal(scope.includeRetrieval, true);
    assert.ok(scope.tokenBudget >= 1000);

    const planResponse = await handleMcpRequest(store, config, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "ai_create_plan",
        arguments: { project: project.id, sessionId: session.id, goal: "Document canonicalContext", risk: "low" },
      },
    });
    const planResult = planResponse?.result as { content: Array<{ text: string }> };
    const plan = JSON.parse(planResult.content[0].text) as { sessionId: string; taskGraph: unknown[] };
    assert.equal(plan.sessionId, session.id);
    assert.ok(plan.taskGraph.length > 0);

    const memoryResponse = await handleMcpRequest(store, config, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "ai_save_session_memory",
        arguments: { sessionId: session.id, title: "MCP continuity", body: "The canonical session was reused." },
      },
    });
    assert.equal(Boolean(memoryResponse?.error), false);
    assert.ok(store.listProjectLessons(project.id, 20).some((lesson) => lesson.title === "MCP continuity"));
    assert.ok(store.listMcpCalls(20).some((call) => call.toolName === "ai_get_session_context"));
    assert.ok(store.listMcpCalls(20).some((call) => call.toolName === "ai_get_session_context_scope"));
  } finally {
    store.db.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("MCP workflow tools use the canonical API, preserve project scope, and cannot self-approve", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-mcp-workflows-"));
  const repo = join(workspace, "repo");
  const otherRepo = join(workspace, "other");
  await mkdir(repo, { recursive: true });
  await mkdir(otherRepo, { recursive: true });
  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "MCP workflow project" });
  const otherProject = store.createProject({ path: otherRepo, name: "Other MCP project" });
  const session = store.createSession({
    projectId: project.id,
    title: "MCP workflow session",
    userGoal: "run canonical workflow",
    mode: "check",
    source: "test",
  });
  const otherSession = store.createSession({
    projectId: otherProject.id,
    title: "Other MCP workflow session",
    userGoal: "remain in the other project",
    mode: "check",
    source: "test",
  });
  const manifest: ProjectManifest = {
    ...contractFixture.ProjectManifest,
    id: project.id,
    name: project.name,
    path: repo,
    repositoryRoot: repo,
    approvedRoots: [repo],
    commands: {
      version: {
        id: "version",
        name: "Git version",
        description: "Read Git version",
        category: "utility",
        executable: "git",
        arguments: ["--version"],
        workingDirectory: null,
        environmentRefs: [],
        interactive: false,
        executionMode: "direct",
        mutation: "read_only",
        timeoutSeconds: 10,
        retryLimit: 0,
        retryDelaySeconds: 0,
        expectedArtifacts: [],
        successCriteria: [],
        recoveryWorkflowIds: [],
        requiresCapabilities: [],
        visibleWhen: [],
      },
      mutate: {
        id: "mutate",
        name: "Mutating request",
        description: "Requires independent approval",
        category: "git",
        executable: "git",
        arguments: ["tag", "never-executed-without-approval"],
        workingDirectory: null,
        environmentRefs: [],
        interactive: false,
        executionMode: "direct",
        mutation: "project_write",
        timeoutSeconds: 10,
        retryLimit: 0,
        retryDelaySeconds: 0,
        expectedArtifacts: [],
        successCriteria: [],
        recoveryWorkflowIds: [],
        requiresCapabilities: [],
        visibleWhen: [],
      },
    },
  };
  store.projectRegistry.saveApprovedManifest(project.id, manifest, "test");
  const apiHandle = await startWorkbenchServer({
    store,
    config: { databasePath: join(workspace, "ai.db"), runtimeDir: join(workspace, "runtime"), apiPort: 0 },
  });
  const config = resolveConfig({
    databasePath: join(workspace, "ai.db"),
    runtimeDir: join(workspace, "runtime"),
    apiUrl: apiHandle.url,
    apiPort: 0,
  });
  try {
    const descriptors = await handleMcpRequest(store, config, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const descriptorText = JSON.stringify(descriptors?.result);
    assert.match(descriptorText, /ai_list_actions/);
    assert.match(descriptorText, /ai_run_action/);
    assert.doesNotMatch(descriptorText, /ai_approve_action/);

    const listed = await handleMcpRequest(store, config, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "ai_list_actions", arguments: { projectId: project.id } },
    });
    assert.deepEqual((mcpText(listed) as Array<{ workflowId: string }>).map((action) => action.workflowId).sort(), [
      "mutate",
      "version",
    ]);

    const run = await handleMcpRequest(store, config, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "ai_run_action",
        arguments: { projectId: project.id, workflowId: "version", sessionId: session.id },
      },
    });
    const completed = mcpText(run) as { execution: { id: string; state: string; projectId: string } };
    assert.equal(completed.execution.state, "completed");
    assert.equal(completed.execution.projectId, project.id);

    const status = await handleMcpRequest(store, config, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "ai_get_action_execution",
        arguments: { projectId: project.id, executionId: completed.execution.id },
      },
    });
    assert.equal((mcpText(status) as { execution: { id: string } }).execution.id, completed.execution.id);

    const pending = await handleMcpRequest(store, config, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "ai_run_action", arguments: { projectId: project.id, workflowId: "mutate" } },
    });
    const pendingPayload = mcpText(pending) as { execution: { state: string }; approval: { status: string } };
    assert.equal(pendingPayload.execution.state, "waiting");
    assert.equal(pendingPayload.approval.status, "pending");

    const crossSession = await handleMcpRequest(store, config, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "ai_run_action",
        arguments: { projectId: project.id, workflowId: "version", sessionId: otherSession.id },
      },
    });
    assert.match(crossSession?.error?.message ?? "", /different project/);

    const confused = await handleMcpRequest(store, config, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "ai_get_action_execution",
        arguments: { projectId: otherProject.id, executionId: completed.execution.id },
      },
    });
    assert.match(confused?.error?.message ?? "", /different project/);
    assert.ok(store.listMcpCalls(20).some((call) => call.toolName === "ai_run_action" && !call.blocked));
  } finally {
    await apiHandle.close();
  }

  const unavailable = await handleMcpRequest(store, config, {
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: { name: "ai_list_actions", arguments: { projectId: project.id } },
  });
  assert.match(unavailable?.error?.message ?? "", /Workbench API unavailable/);
  const externalConfig = { ...config, apiUrl: "https://example.com" };
  const external = await handleMcpRequest(store, externalConfig, {
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { name: "ai_list_actions", arguments: { projectId: project.id } },
  });
  assert.match(external?.error?.message ?? "", /loopback Workbench API/);
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

test("MCP dev tools start, inspect, diff, and cancel a dev run", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-mcp-dev-"));
  const repo = join(workspace, "repo");
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "README.md"), "# Repo\n");
  await writeFile(
    join(repo, ".ai-workbench.json"),
    JSON.stringify({
      checks: {
        node_version: "node --version",
      },
      dev: {
        defaultChecks: ["node_version"],
        maxRepairLoops: 0,
        requireApprovalFor: ["env", "migrations", "auth", "db", "package"],
      },
    })
  );

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

  try {
    const startResponse = await handleMcpRequest(store, config, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "ai_dev_start",
        arguments: {
          project: project.id,
          goal: "append a status note to README",
          checks: ["node_version"],
          maxRepairs: 0,
        },
      },
    });
    const startResult = startResponse?.result as { content: Array<{ type: string; text: string }> };
    const startPayload = JSON.parse(startResult.content[0].text) as {
      runId: string;
      status: string;
      workspacePath: string | null;
      diff: string;
    };
    assert.ok(startPayload.runId);
    assert.equal(startPayload.status, "awaiting_approval");
    assert.ok(startPayload.workspacePath?.includes("dev-runs"));
    assert.match(startPayload.diff, /README\.md/);

    const statusResponse = await handleMcpRequest(store, config, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "ai_dev_status",
        arguments: { runId: startPayload.runId },
      },
    });
    const statusResult = statusResponse?.result as { content: Array<{ type: string; text: string }> };
    const statusPayload = JSON.parse(statusResult.content[0].text) as {
      run: { id: string; status: string };
      workspace: { path: string } | null;
      commands: Array<{ status: string; command: string }>;
    };
    assert.equal(statusPayload.run.id, startPayload.runId);
    assert.equal(statusPayload.run.status, "awaiting_approval");
    assert.ok(statusPayload.workspace?.path.includes("workspace"));
    assert.ok(statusPayload.commands.some((command) => command.command === "node --version"));

    const diffResponse = await handleMcpRequest(store, config, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "ai_dev_diff",
        arguments: { runId: startPayload.runId },
      },
    });
    const diffResult = diffResponse?.result as { content: Array<{ type: string; text: string }> };
    const diffPayload = JSON.parse(diffResult.content[0].text) as { diffText: string };
    assert.match(diffPayload.diffText, /README\.md/);

    const cancelResponse = await handleMcpRequest(store, config, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "ai_dev_cancel",
        arguments: { runId: startPayload.runId, reason: "test cleanup" },
      },
    });
    const cancelResult = cancelResponse?.result as { content: Array<{ type: string; text: string }> };
    const cancelPayload = JSON.parse(cancelResult.content[0].text) as { status: string; errorMessage: string };
    assert.equal(cancelPayload.status, "cancelled");
    assert.match(cancelPayload.errorMessage, /test cleanup/);
    const runEvents = store.listEvents().filter((event) => event.runId === startPayload.runId);
    assert.ok(runEvents.some((event) => event.type === "approval.required"));
    assert.ok(runEvents.some((event) => event.type === "run.cancelled"));
    assert.ok(runEvents.every((event) => event.schemaVersion === 1));
    assert.ok(runEvents.every((event) => event.correlationId === startPayload.runId));
    assert.equal(runEvents.at(1)?.causationId, runEvents.at(0)?.id ?? null);
  } finally {
    store.db.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
