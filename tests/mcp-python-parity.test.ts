import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkbenchServer } from "../apps/api/src/server.ts";
import { getToolDescriptors, handleMcpRequest } from "../mcp/server/src/tools.ts";
import { resolveConfig } from "../packages/config/src/index.ts";
import { createStore, initializeStore } from "../packages/db/src/store.ts";

function mcpText(response: Awaited<ReturnType<typeof handleMcpRequest>>): unknown {
  const result = response?.result as { content?: Array<{ text?: string }> } | undefined;
  return JSON.parse(result?.content?.[0]?.text ?? "null");
}

const LEGACY_TOOL_REPLACEMENTS: Record<string, string[]> = {
  rag_status: ["ai_get_runtime_health", "ai_get_project_status"],
  rag_search: ["ai_search_project", "ai_explain_retrieval"],
  rag_deep: ["ai_ask_rag"],
  rag_agent_context: ["ai_get_session_context"],
  rag_plan_task: ["ai_create_plan"],
  rag_should_use_graph: ["ai_create_plan"],
  rag_next_subtask: ["ai_get_next_subtask"],
  rag_subtask_context: ["ai_get_subtask_context"],
  rag_subtask_running: ["ai_get_current_task"],
  rag_subtask_done: ["ai_mark_subtask_done"],
  rag_subtask_failed: ["ai_mark_subtask_failed"],
  rag_task_status: ["ai_get_current_task", "ai_get_project_status"],
  rag_task_step: ["ai_get_current_task", "ai_get_next_subtask"],
  rag_task_continue: ["ai_get_next_subtask", "ai_get_subtask_context"],
  rag_reflect_run: ["ai_reflect_session"],
  rag_learn_from_outcome: ["ai_reflect_session", "ai_save_session_memory"],
  rag_edit_scope: ["ai_get_session_context"],
  rag_missing_context: ["ai_get_session_context"],
  rag_find_tests: ["ai_get_session_context", "ai_search_project"],
  rag_explain_file: ["ai_get_session_context", "ai_explain_retrieval"],
  rag_record_outcome: ["ai_mark_subtask_done", "ai_save_session_memory"],
  rag_suggest_commands: ["ai_list_actions", "ai_run_check"],
  rag_perf_report: ["ai_get_retrieval_query", "ai_explain_retrieval"],
  rag_eval_query: ["ai_explain_retrieval"],
  rag_context_git_refresh: ["ai_get_project_status"],
  rag_memory_status: ["ai_get_project_memory", "ai_get_project_status"],
  rag_memory_pack: ["ai_get_session_context"],
};

test("canonical MCP descriptors cover every legacy Python MCP capability", () => {
  const canonical = new Set(getToolDescriptors().map((tool) => tool.name));
  assert.equal(Object.keys(LEGACY_TOOL_REPLACEMENTS).length, 27);
  for (const [legacyTool, replacements] of Object.entries(LEGACY_TOOL_REPLACEMENTS)) {
    assert.ok(replacements.length > 0, `${legacyTool} has no canonical replacement`);
    for (const replacement of replacements) {
      assert.ok(canonical.has(replacement), `${legacyTool} replacement ${replacement} is not exposed`);
    }
  }
});

test("MCP client reads canonical control-plane state and retrieval without legacy caches", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-mcp-python-parity-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "context.ts"), "export const canonicalContext = true;\n");
  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "Parity project" });
  await store.indexProject(project.id);
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
  const call = (id: number, name: string, args: Record<string, unknown> = {}) =>
    handleMcpRequest(store, config, {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    });
  try {
    const projects = mcpText(await call(1, "ai_list_projects")) as Array<{ id: string }>;
    assert.equal(projects[0]?.id, project.id);

    const selection = mcpText(
      await call(2, "ai_select_project", { projectId: project.id, pinScope: "persistent" })
    ) as { projectId: string; pinScope: string };
    assert.equal(selection.projectId, project.id);
    assert.equal(selection.pinScope, "persistent");

    const active = mcpText(await call(3, "ai_get_active_context")) as {
      selection: { projectId: string };
    };
    assert.equal(active.selection.projectId, project.id);

    const explanation = mcpText(await call(4, "ai_explain_active_context")) as {
      selection: { projectId: string };
      rejectedCandidates: unknown[];
    };
    assert.equal(explanation.selection.projectId, project.id);
    assert.ok(Array.isArray(explanation.rejectedCandidates));

    const status = mcpText(await call(5, "ai_get_project_status", { projectId: project.id })) as {
      project: { id: string };
    };
    assert.equal(status.project.id, project.id);

    const runtime = mcpText(await call(6, "ai_get_runtime_health")) as { components: unknown[] };
    assert.ok(Array.isArray(runtime.components));

    const memory = mcpText(await call(7, "ai_get_project_memory", { projectId: project.id })) as {
      memory: unknown[];
      lessons: unknown[];
      rules: unknown[];
    };
    assert.ok(Array.isArray(memory.memory));
    assert.ok(Array.isArray(memory.lessons));
    assert.ok(Array.isArray(memory.rules));

    const retrieval = mcpText(
      await call(8, "ai_explain_retrieval", { projectId: project.id, query: "canonical context", limit: 4 })
    ) as { ranked: unknown[]; selected: unknown[]; dropped: unknown[] };
    assert.ok(Array.isArray(retrieval.ranked));
    assert.ok(Array.isArray(retrieval.selected));
    assert.ok(Array.isArray(retrieval.dropped));
    assert.ok(store.listMcpCalls(20).every((entry) => !entry.blocked));
    await access(join(workspace, "runtime", "cache", "desktop", "project-registry-v1.json"));
    await access(join(workspace, "runtime", "cache", "desktop", "project-status-v1.json"));
  } finally {
    await apiHandle.close();
    store.db.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
