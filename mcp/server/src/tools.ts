import { parseDevRequest } from "../../../packages/agent-protocol/src/dev.ts";
import { resolveProjectConfig } from "../../../packages/config/src/index.ts";
import type { createStore } from "../../../packages/db/src/store.ts";
import { cancelDevRun, runDevWorkflow } from "../../../packages/dev-agent/src/index.ts";
import {
  readProjectChecksConfig,
  runAllowedChecks,
  runValidationPipeline,
} from "../../../packages/execution-engine/src/index.ts";
import { createModelRuntime } from "../../../packages/model-runtime/src/index.ts";
import { compileSessionContextPreview } from "../../../packages/session-context/src/index.ts";
import type { ConfigSnapshot } from "../../../packages/shared/src/index.ts";
import { createEvent } from "../../../packages/shared/src/index.ts";

type Store = ReturnType<typeof createStore>;

type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function err(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

function textResult(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function canonicalApiUrl(config: ConfigSnapshot): URL {
  const url = new URL(config.apiUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error("MCP workflow tools require a loopback Workbench API URL");
  }
  return url;
}

async function requestWorkbenchApi(
  config: ConfigSnapshot,
  path: string,
  input: { method?: "GET" | "POST"; body?: Record<string, unknown>; timeoutMs?: number } = {}
): Promise<unknown> {
  const url = new URL(path, canonicalApiUrl(config));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 5_000);
  timer.unref?.();
  try {
    const response = await fetch(url, {
      method: input.method ?? "GET",
      signal: controller.signal,
      headers: { accept: "application/json", ...(input.body ? { "content-type": "application/json" } : {}) },
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
    });
    const envelope = (await response.json()) as { status?: unknown; data?: unknown; error?: { message?: unknown } };
    if (!response.ok || envelope.status !== "ok") {
      const message = typeof envelope.error?.message === "string" ? envelope.error.message : `HTTP ${response.status}`;
      throw new Error(`Workbench API rejected MCP request: ${message}`);
    }
    return envelope.data;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Workbench API request timed out");
    }
    if (error instanceof Error && error.message.startsWith("Workbench API rejected")) throw error;
    throw new Error(`Workbench API unavailable: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

function assertExecutionProject(output: unknown, projectId: string): void {
  const record = asRecord(output);
  const execution = asRecord(record.execution);
  if (asString(execution.projectId) !== projectId) {
    throw new Error("workflow execution belongs to a different project");
  }
}

function toolDescriptors(): ToolDescriptor[] {
  return [
    {
      name: "ai_list_projects",
      description: "List projects from the canonical Workbench registry (read-only).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "ai_select_project",
      description: "Select or pin a canonical Workbench project (mutating and audit logged).",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          pinScope: { type: "string", enum: ["workspace", "session", "persistent"] },
        },
        required: ["projectId"],
      },
    },
    {
      name: "ai_get_active_context",
      description: "Return canonical active context and durable project selection (read-only).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "ai_explain_active_context",
      description: "Explain active-context evidence, rejected candidates, confidence and selection (read-only).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "ai_get_project_status",
      description: "Return canonical project, Git, work, check, service, index and runtime status (read-only).",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" } },
        required: ["projectId"],
      },
    },
    {
      name: "ai_get_runtime_health",
      description: "Return normalized Workbench runtime health and component readiness (read-only).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "ai_get_project_memory",
      description: "Return canonical project memory, lessons and rules (read-only).",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" } },
        required: ["projectId"],
      },
    },
    {
      name: "ai_explain_retrieval",
      description: "Run inspectable project retrieval and return ranked, selected and dropped evidence (read-only).",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          query: { type: "string" },
          mode: { type: "string", enum: ["local", "hybrid", "cloud"] },
          depth: { type: "string", enum: ["shallow", "standard", "deep"] },
          limit: { type: "number" },
        },
        required: ["projectId", "query"],
      },
    },
    {
      name: "ai_search_project",
      description: "Search a project for relevant chunks.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          query: { type: "string" },
          limit: { type: "number" },
        },
        required: ["project", "query"],
      },
    },
    {
      name: "ai_ask_rag",
      description: "Ask a local-retrieval question against a project.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          question: { type: "string" },
          sessionId: { type: "string" },
          mode: { type: "string", enum: ["local", "cloud", "hybrid"] },
          depth: { type: "string", enum: ["shallow", "standard", "deep"] },
        },
        required: ["project", "question"],
      },
    },
    {
      name: "ai_create_session",
      description: "Create a canonical project-scoped session (mutating).",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          goal: { type: "string" },
          title: { type: "string" },
        },
        required: ["project", "goal"],
      },
    },
    {
      name: "ai_append_session_message",
      description: "Append a user, assistant, or agent message to a canonical shared session (mutating).",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          role: { type: "string", enum: ["user", "assistant", "agent"] },
          content: { type: "string" },
          agent: { type: "string" },
          parentMessageId: { type: "string" },
        },
        required: ["sessionId", "role", "content"],
      },
    },
    {
      name: "ai_get_session_context",
      description:
        "Preview compiled shared-session context, provenance, exclusions, budget, and index freshness (read-only).",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          query: { type: "string" },
          tokenBudget: { type: "number" },
        },
        required: ["sessionId"],
      },
    },
    {
      name: "ai_get_session_context_scope",
      description:
        "Read the canonical per-session context policy enforced by preview and Ask, including source flags, paths, and token budget (read-only).",
      inputSchema: {
        type: "object",
        properties: { sessionId: { type: "string" } },
        required: ["sessionId"],
      },
    },
    {
      name: "ai_resume_session",
      description: "Resume a canonical shared session while preserving its project scope (mutating).",
      inputSchema: {
        type: "object",
        properties: { sessionId: { type: "string" } },
        required: ["sessionId"],
      },
    },
    {
      name: "ai_save_session_memory",
      description: "Save an explicit session outcome as durable project memory (mutating).",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          importance: { type: "number" },
        },
        required: ["sessionId", "body"],
      },
    },
    {
      name: "ai_create_plan",
      description: "Generate a task graph for a project goal.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          goal: { type: "string" },
          sessionId: { type: "string" },
          risk: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["project", "goal"],
      },
    },
    {
      name: "ai_get_current_task",
      description: "Return the current active or next task for a session.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
        },
        required: ["sessionId"],
      },
    },
    {
      name: "ai_get_next_subtask",
      description: "Return the next queued subtask for a session.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
        },
        required: ["sessionId"],
      },
    },
    {
      name: "ai_get_subtask_context",
      description: "Return the session, task, files, chunks, and lessons needed to work on a subtask.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          taskId: { type: "string" },
        },
        required: ["sessionId"],
      },
    },
    {
      name: "ai_create_handoff",
      description: "Generate a target-specific handoff prompt.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          project: { type: "string" },
          target: { type: "string", enum: ["opencode", "codex", "manual", "clipboard", "file"] },
          subtask: { type: "string" },
        },
        required: ["sessionId", "project", "target", "subtask"],
      },
    },
    {
      name: "ai_mark_subtask_done",
      description: "Mark a subtask as completed.",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          result: {},
        },
        required: ["taskId"],
      },
    },
    {
      name: "ai_mark_subtask_failed",
      description: "Mark a subtask as failed.",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          error: { type: "string" },
        },
        required: ["taskId"],
      },
    },
    {
      name: "ai_get_recent_lessons",
      description: "Return recent lessons for a project or globally.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          limit: { type: "number" },
        },
      },
    },
    {
      name: "ai_reflect_session",
      description: "Create a reflection lesson from a session summary.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
        },
        required: ["sessionId"],
      },
    },
    {
      name: "ai_list_sessions",
      description: "List tracked sessions.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          limit: { type: "number" },
        },
      },
    },
    {
      name: "ai_get_session_trace",
      description: "Return the event trace for a session.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
        },
        required: ["sessionId"],
      },
    },
    {
      name: "ai_list_actions",
      description: "List canonical manifest workflows for an explicit project (read-only).",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" } },
        required: ["projectId"],
      },
    },
    {
      name: "ai_get_action_execution",
      description: "Get a canonical workflow execution and approval state for an explicit project (read-only).",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" }, executionId: { type: "string" } },
        required: ["projectId", "executionId"],
      },
    },
    {
      name: "ai_run_action",
      description:
        "Request a canonical project workflow (mutating). Read-only workflows execute; mutating workflows stop for independent user approval.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          workflowId: { type: "string" },
          sessionId: { type: "string" },
          taskId: { type: "string" },
        },
        required: ["projectId", "workflowId"],
      },
    },
    {
      name: "ai_cancel_action",
      description: "Cancel a running canonical workflow after verifying its explicit project scope (mutating).",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" }, executionId: { type: "string" } },
        required: ["projectId", "executionId"],
      },
    },
    {
      name: "ai_run_check",
      description: "Record and run an allowlisted check.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          projectId: { type: "string" },
          sessionId: { type: "string" },
        },
        required: ["name"],
      },
    },
    {
      name: "ai_run_validation",
      description:
        "Run the full validation pipeline for an AI-generated patch (format -> lint -> typecheck -> test -> semgrep -> osv -> playwright) and store each result as a memory event.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          sessionId: { type: "string" },
          checks: { type: "array", items: { type: "string" } },
          continueOnFailure: { type: "boolean" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "ai_dev_start",
      description:
        "Start a safe local dev-agent run. Creates an isolated workspace, runs allowlisted checks, and stops for approval unless policy allows apply.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          goal: { type: "string" },
          sessionId: { type: "string" },
          mode: { type: "string", enum: ["local", "hybrid", "cloud"] },
          approvalPolicy: { type: "string", enum: ["auto", "manual", "high_risk_only"] },
          approveEdits: { type: "boolean" },
          checks: { type: "array", items: { type: "string" } },
          maxRepairs: { type: "number" },
        },
        required: ["project", "goal"],
      },
    },
    {
      name: "ai_dev_status",
      description: "Return a dev run with edits, workspace, approvals, patches, and command records.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
        },
        required: ["runId"],
      },
    },
    {
      name: "ai_dev_diff",
      description: "Return the stored diff for a dev run.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
        },
        required: ["runId"],
      },
    },
    {
      name: "ai_dev_cancel",
      description: "Cancel a dev run without applying changes to the original project.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
          reason: { type: "string" },
        },
        required: ["runId"],
      },
    },
    {
      name: "ai_get_context_pack",
      description: "Return a context pack by id, including its items and budget events.",
      inputSchema: {
        type: "object",
        properties: {
          contextPackId: { type: "string" },
        },
        required: ["contextPackId"],
      },
    },
    {
      name: "ai_list_memory_candidates",
      description: "List memory candidates filtered by project and status.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          status: { type: "string", enum: ["pending", "accepted", "rejected"] },
          limit: { type: "number" },
        },
      },
    },
    {
      name: "ai_accept_memory_candidate",
      description: "Accept a pending memory candidate and create a memory entry.",
      inputSchema: {
        type: "object",
        properties: {
          candidateId: { type: "string" },
          notes: { type: "string" },
        },
        required: ["candidateId"],
      },
    },
    {
      name: "ai_list_skill_candidates",
      description: "List skill candidates filtered by status.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["pending", "active", "rejected", "deprecated"] },
          limit: { type: "number" },
        },
      },
    },
    {
      name: "ai_accept_skill_candidate",
      description: "Accept a pending skill candidate and create a skill.",
      inputSchema: {
        type: "object",
        properties: {
          candidateId: { type: "string" },
        },
        required: ["candidateId"],
      },
    },
    {
      name: "ai_reject_memory_candidate",
      description: "Reject a pending memory candidate with optional reason.",
      inputSchema: {
        type: "object",
        properties: {
          candidateId: { type: "string" },
          reason: { type: "string" },
        },
        required: ["candidateId"],
      },
    },
    {
      name: "ai_reject_skill_candidate",
      description: "Reject a pending skill candidate.",
      inputSchema: {
        type: "object",
        properties: {
          candidateId: { type: "string" },
          reason: { type: "string" },
        },
        required: ["candidateId"],
      },
    },
    {
      name: "ai_get_model_calls",
      description: "Return model call records for a session, optionally filtered by role.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          role: { type: "string" },
          limit: { type: "number" },
        },
        required: ["sessionId"],
      },
    },
    {
      name: "ai_get_retrieval_query",
      description: "Return a retrieval query, its results, selected context, feedback, and misses.",
      inputSchema: {
        type: "object",
        properties: {
          retrievalQueryId: { type: "string" },
        },
        required: ["retrievalQueryId"],
      },
    },
    {
      name: "ai_record_feedback",
      description:
        "Record retrieval feedback (good/bad chunk or missed path) so future rerank calls are tuned. Triggers chunk_path_boost updates.",
      inputSchema: {
        type: "object",
        properties: {
          retrievalQueryId: { type: "string" },
          chunkId: { type: "string" },
          rating: { type: "string", enum: ["good", "bad", "missed"] },
          missedPath: { type: "string" },
          notes: { type: "string" },
        },
        required: ["retrievalQueryId", "rating"],
      },
    },
  ];
}

function logMcpCall(
  store: Store,
  input: {
    toolName: string;
    sessionId?: string | null;
    projectId?: string | null;
    payload: Record<string, unknown>;
    blocked?: boolean;
    output?: unknown;
  }
): void {
  store.createMcpCall({
    toolName: input.toolName,
    sessionId: input.sessionId ?? null,
    projectId: input.projectId ?? null,
    inputJson: JSON.stringify(input.payload),
    outputJson: input.output == null ? null : JSON.stringify(input.output),
    blocked: input.blocked ?? false,
  });
}

async function handleTool(
  store: Store,
  config: ConfigSnapshot,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (name) {
    case "ai_list_projects":
      return store.listProjects();
    case "ai_select_project": {
      const projectId = asString(args.projectId).trim();
      if (!projectId || !store.getProject(projectId)) throw new Error(`Unknown project: ${projectId}`);
      const pinScope =
        args.pinScope === "workspace" || args.pinScope === "session" || args.pinScope === "persistent"
          ? args.pinScope
          : null;
      return requestWorkbenchApi(config, "/context/selection", {
        method: "POST",
        body: { projectId, source: "mcp", pinScope },
      });
    }
    case "ai_get_active_context":
      return {
        context: store.activeContext.getContext(),
        selection: store.projectRegistry.getSelection(),
      };
    case "ai_explain_active_context": {
      const context = store.activeContext.getContext();
      return {
        context,
        selection: store.projectRegistry.getSelection(),
        winningEvidence: context?.evidence ?? [],
        rejectedCandidates: context?.rejectedCandidates ?? [],
        confirmationRecommended: context?.confirmationRecommended ?? true,
      };
    }
    case "ai_get_project_status": {
      const projectId = asString(args.projectId).trim();
      if (!projectId || !store.getProject(projectId)) throw new Error(`Unknown project: ${projectId}`);
      return requestWorkbenchApi(config, `/project-status?projectId=${encodeURIComponent(projectId)}`);
    }
    case "ai_get_runtime_health": {
      const diagnostics = asRecord(await requestWorkbenchApi(config, "/diagnostics"));
      return diagnostics.runtime ?? null;
    }
    case "ai_get_project_memory": {
      const projectId = asString(args.projectId).trim();
      if (!projectId || !store.getProject(projectId)) throw new Error(`Unknown project: ${projectId}`);
      return requestWorkbenchApi(config, `/projects/${encodeURIComponent(projectId)}/memory`);
    }
    case "ai_explain_retrieval": {
      const projectId = asString(args.projectId).trim();
      const query = asString(args.query).trim();
      if (!projectId || !store.getProject(projectId)) throw new Error(`Unknown project: ${projectId}`);
      if (!query) throw new Error("query is required");
      return requestWorkbenchApi(config, "/retrieval/explain", {
        method: "POST",
        body: {
          projectId,
          query,
          mode: args.mode === "cloud" || args.mode === "hybrid" ? args.mode : "local",
          depth: args.depth === "shallow" || args.depth === "deep" ? args.depth : "standard",
          limit: Math.max(1, Math.min(50, Math.trunc(asNumber(args.limit, 8)))),
        },
      });
    }
    case "ai_list_actions": {
      const projectId = asString(args.projectId).trim();
      if (!projectId || !store.getProject(projectId)) throw new Error(`Unknown project: ${projectId}`);
      return requestWorkbenchApi(config, `/actions?projectId=${encodeURIComponent(projectId)}`);
    }
    case "ai_get_action_execution": {
      const projectId = asString(args.projectId).trim();
      const executionId = asString(args.executionId).trim();
      if (!projectId || !store.getProject(projectId)) throw new Error(`Unknown project: ${projectId}`);
      if (!executionId) throw new Error("executionId is required");
      const output = await requestWorkbenchApi(config, `/actions/executions/${encodeURIComponent(executionId)}`);
      assertExecutionProject(output, projectId);
      return output;
    }
    case "ai_run_action": {
      const projectId = asString(args.projectId).trim();
      const workflowId = asString(args.workflowId).trim();
      if (!projectId || !store.getProject(projectId)) throw new Error(`Unknown project: ${projectId}`);
      if (!workflowId) throw new Error("workflowId is required");
      return requestWorkbenchApi(config, `/actions/${encodeURIComponent(workflowId)}/run`, {
        method: "POST",
        timeoutMs: 10 * 60_000,
        body: {
          projectId,
          ...(args.sessionId ? { sessionId: asString(args.sessionId) } : {}),
          ...(args.taskId ? { taskId: asString(args.taskId) } : {}),
        },
      });
    }
    case "ai_cancel_action": {
      const projectId = asString(args.projectId).trim();
      const executionId = asString(args.executionId).trim();
      if (!projectId || !store.getProject(projectId)) throw new Error(`Unknown project: ${projectId}`);
      if (!executionId) throw new Error("executionId is required");
      const current = await requestWorkbenchApi(config, `/actions/executions/${encodeURIComponent(executionId)}`);
      assertExecutionProject(current, projectId);
      return requestWorkbenchApi(config, `/actions/executions/${encodeURIComponent(executionId)}/cancel`, {
        method: "POST",
      });
    }
    case "ai_search_project": {
      const project = asString(args.project);
      const query = asString(args.query);
      return {
        project,
        query,
        chunks: store.searchChunks(project, query, { limit: asNumber(args.limit, 8) }),
      };
    }
    case "ai_ask_rag": {
      return store.ask({
        project: asString(args.project),
        question: asString(args.question),
        sessionId: args.sessionId ? asString(args.sessionId) : null,
        mode: args.mode === "cloud" || args.mode === "hybrid" ? args.mode : "local",
        depth: args.depth === "shallow" || args.depth === "deep" ? args.depth : "standard",
      });
    }
    case "ai_create_session": {
      const projectId = asString(args.project);
      if (!store.getProject(projectId)) throw new Error(`Unknown project: ${projectId}`);
      const goal = asString(args.goal).trim();
      if (!goal) throw new Error("goal is required");
      const session = store.createSession({
        projectId,
        title: asString(args.title, `Session: ${goal}`).slice(0, 240),
        userGoal: goal.slice(0, 32_000),
        mode: "plan",
        source: "mcp",
      });
      store.appendEvent(
        createEvent(
          "session.created",
          { title: session.title, mode: session.mode },
          {
            sessionId: session.id,
            projectId,
            agent: "mcp",
          }
        )
      );
      return session;
    }
    case "ai_append_session_message": {
      const sessionId = asString(args.sessionId);
      const session = store.getSession(sessionId);
      if (!session) throw new Error(`Unknown session: ${sessionId}`);
      if (args.role !== "user" && args.role !== "assistant" && args.role !== "agent") {
        throw new Error("role must be user, assistant, or agent");
      }
      const content = asString(args.content).trim();
      if (!content) throw new Error("content is required");
      if (content.length > 200_000) throw new Error("content exceeds 200000 characters");
      const parentMessageId = args.parentMessageId ? asString(args.parentMessageId) : null;
      if (parentMessageId) {
        const parent = store.conversation.getMessage(parentMessageId);
        if (!parent || parent.sessionId !== sessionId)
          throw new Error("parent message does not belong to this session");
      }
      const message = store.conversation.appendMessage({
        sessionId,
        projectId: session.projectId,
        role: args.role,
        content,
        agent: args.agent ? asString(args.agent).slice(0, 120) : "mcp",
        parentMessageId,
        meta: { client: "mcp" },
      });
      store.appendEvent(
        createEvent(
          "session.message_appended",
          { messageId: message.id, role: message.role, tokenCount: message.tokenCount },
          { sessionId, projectId: session.projectId, agent: message.agent }
        )
      );
      return message;
    }
    case "ai_get_session_context": {
      const sessionId = asString(args.sessionId);
      const preview = await compileSessionContextPreview(store, {
        sessionId,
        query: args.query ? asString(args.query) : null,
        tokenBudget: asNumber(args.tokenBudget, 8_000),
      });
      if (!preview) throw new Error(`Unknown session: ${sessionId}`);
      return preview;
    }
    case "ai_get_session_context_scope": {
      const sessionId = asString(args.sessionId);
      const session = store.getSession(sessionId);
      if (!session) throw new Error(`Unknown session: ${sessionId}`);
      const scope = store.getSessionContextScope(sessionId);
      if (!scope) throw new Error(`Session context scope unavailable: ${sessionId}`);
      return scope;
    }
    case "ai_resume_session": {
      const sessionId = asString(args.sessionId);
      const session = store.getSession(sessionId);
      if (!session) throw new Error(`Unknown session: ${sessionId}`);
      if (session.status === "running") return session;
      const resumed = store.updateSession(sessionId, {
        status: "running",
        finishedAt: null,
        durationMs: null,
        errorMessage: null,
      });
      store.appendEvent(createEvent("session.resumed", {}, { sessionId, projectId: session.projectId, agent: "mcp" }));
      return resumed;
    }
    case "ai_save_session_memory": {
      const sessionId = asString(args.sessionId);
      const session = store.getSession(sessionId);
      if (!session) throw new Error(`Unknown session: ${sessionId}`);
      if (!session.projectId) throw new Error("Session has no project scope");
      const body = asString(args.body).trim();
      if (!body) throw new Error("body is required");
      if (body.length > 100_000) throw new Error("body exceeds 100000 characters");
      const lesson = store.createLesson({
        projectId: session.projectId,
        sessionId,
        title: asString(args.title, `Session outcome: ${session.title}`).slice(0, 240),
        body,
        tags: Array.isArray(args.tags)
          ? args.tags
              .map(String)
              .map((tag) => tag.slice(0, 80))
              .slice(0, 20)
          : ["session"],
        importance: Math.min(5, Math.max(1, asNumber(args.importance, 3))),
      });
      store.appendEvent(
        createEvent(
          "lesson.created",
          { lessonId: lesson.id, title: lesson.title, source: "mcp-session" },
          { sessionId, projectId: session.projectId, agent: "mcp" }
        )
      );
      return lesson;
    }
    case "ai_create_plan":
      return (
        await store.createPlan({
          project: asString(args.project),
          goal: asString(args.goal),
          sessionId: args.sessionId ? asString(args.sessionId) : null,
          risk: args.risk === "low" || args.risk === "high" ? args.risk : "medium",
        })
      ).response;
    case "ai_get_current_task":
      return store.getCurrentTask(asString(args.sessionId));
    case "ai_get_next_subtask":
      return store.getNextSubtask(asString(args.sessionId));
    case "ai_get_subtask_context":
      return store.getSubtaskContext(asString(args.sessionId), args.taskId == null ? null : asString(args.taskId));
    case "ai_create_handoff":
      return await store.createHandoff({
        sessionId: asString(args.sessionId),
        project: asString(args.project),
        target:
          args.target === "opencode" || args.target === "codex" || args.target === "clipboard" || args.target === "file"
            ? args.target
            : "manual",
        subtask: asString(args.subtask),
      });
    case "ai_mark_subtask_done": {
      const taskId = asString(args.taskId);
      const result = store.updateTask(taskId, {
        status: "completed",
        resultJson: JSON.stringify(args.result ?? {}),
      });
      return result;
    }
    case "ai_mark_subtask_failed": {
      const taskId = asString(args.taskId);
      const task = store.updateTask(taskId, {
        status: "failed",
        resultJson: JSON.stringify({ error: asString(args.error, "failed") }),
      });
      return task;
    }
    case "ai_get_recent_lessons": {
      const project = args.project ? asString(args.project) : "";
      return project
        ? store.listProjectLessons(project, asNumber(args.limit, 10))
        : store.listRecentLessons(asNumber(args.limit, 10));
    }
    case "ai_reflect_session": {
      const sessionId = asString(args.sessionId);
      const session = store.getSession(sessionId);
      if (!session) {
        throw new Error(`Unknown session: ${sessionId}`);
      }
      const job = store.enqueueJob({
        type: "session.reflect",
        payload: { sessionId, source: "mcp" },
      });
      store.appendEvent(
        createEvent(
          "session.reflected",
          { sessionId, projectId: session.projectId, queuedJobId: job.id, source: "mcp" },
          { sessionId, projectId: session.projectId, agent: "mcp" }
        )
      );
      return {
        queued: true,
        jobId: job.id,
        sessionId,
        note: "session.reflect job queued; the worker will build memory/skill candidates and emit a session.reflected event when finished",
      };
    }
    case "ai_list_sessions":
      return args.project
        ? store.listProjectSessions(asString(args.project), asNumber(args.limit, 20))
        : store.listSessions(asNumber(args.limit, 20));
    case "ai_get_session_trace": {
      const sessionId = asString(args.sessionId);
      const session = store.getSession(sessionId);
      if (!session) {
        throw new Error(`Unknown session: ${sessionId}`);
      }
      const retrievals = store.retrieval.listQueriesForSession(sessionId, 200);
      const contextPacks = store.context.listPacksForSession(sessionId, 50);
      const agentRuns = store.agents.listRuns(sessionId, 200);
      const agentMessages = agentRuns.flatMap((run) => store.agents.listMessages(run.id, 200));
      const memoryCandidates = session.projectId
        ? store.memory.listCandidates(undefined, session.projectId, 200)
        : store.memory.listCandidates(undefined, null, 200);
      const projectId = session.projectId;
      const memoryEntries = projectId
        ? store.memory.listEntries(projectId, undefined, 200)
        : store.memory.listEntries(null, undefined, 200);
      const facts = projectId ? store.memory.listFacts(projectId, 200) : store.memory.listFacts(null, 200);
      const rules = projectId ? store.memory.listProjectRules(projectId, 200) : [];
      const skills = store.skills.listSkills(undefined, 200);
      const reviews = projectId ? store.listReviews(projectId, 200) : store.listReviews(null, 200);
      const checks = store.listCheckRuns(200);
      const answerEvaluations = store.evals.listAnswerEvaluations(200);
      const outcomes = store.evals.listOutcomes(sessionId, 20);
      const compiledPrompts = store.listCompiledPrompts(sessionId, 200);
      return {
        session,
        conversation: store.conversation.listMessages(sessionId, 500),
        retrievals: retrievals.map((query) => ({
          query,
          results: store.retrieval.listResults(query.id, 200),
          selectedContext: store.retrieval.listSelectedContext(query.id),
          feedback: store.retrieval.listFeedback(query.id, 50),
          misses: store.retrieval.listMisses(query.id),
        })),
        contextPacks: contextPacks.map((pack) => ({
          pack,
          items: store.context.listItems(pack.id),
          budgetEvents: store.context.listBudgetEvents(pack.id),
        })),
        agentRuns,
        agentMessages,
        modelCalls: store.models.listCalls(sessionId, 500),
        memoryCandidates,
        memoryEntries,
        facts,
        rules,
        skills,
        reviews,
        checks,
        answerEvaluations,
        outcomes,
        compiledPrompts,
        events: store.listEvents(sessionId, asNumber(args.limit, 500)),
      };
    }
    case "ai_run_check": {
      const nameValue = asString(args.name);
      const projectIdentifier = args.projectId ? asString(args.projectId) : "";
      const sessionId = args.sessionId ? asString(args.sessionId) : null;
      const session = sessionId ? store.getSession(sessionId) : null;
      const project = projectIdentifier
        ? store.getProject(projectIdentifier)
        : session?.projectId
          ? store.getProject(session.projectId)
          : null;
      if (!project) {
        const startedAt = new Date().toISOString();
        return store.createCheckRun({
          name: nameValue,
          projectId: projectIdentifier || null,
          sessionId,
          status: "blocked",
          command: nameValue,
          output: null,
          errorOutput: "ai_run_check requires a resolvable projectId or a sessionId linked to a project.",
          exitCode: null,
          startedAt,
          finishedAt: new Date().toISOString(),
        });
      }
      const projectConfig = readProjectChecksConfig(resolveProjectConfig(project.path).raw);
      const [result] = await runAllowedChecks({
        cwd: project.path,
        commandNames: [nameValue],
        projectConfig,
        timeoutMs: 10 * 60_000,
      });
      if (!result) {
        throw new Error(`No check result for ${nameValue}`);
      }
      const check = store.createCheckRun({
        name: nameValue,
        projectId: project.id,
        sessionId,
        status: result.status === "cancelled" ? "failed" : result.status,
        command: result.command,
        output: result.stdout,
        errorOutput: result.stderr || result.blockedReason,
        exitCode: result.exitCode,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
      });
      if (sessionId) {
        store.appendEvent(
          createEvent(
            result.status === "completed" ? "check.completed" : "check.failed",
            {
              checkId: check.id,
              name: check.name,
              command: check.command,
              status: check.status,
              exitCode: check.exitCode,
              durationMs: result.durationMs,
              parsedErrors: result.parsedErrors,
              affectedFiles: result.affectedFiles,
            },
            { sessionId, projectId: project.id, agent: "mcp", level: result.status === "completed" ? "info" : "warn" }
          )
        );
      }
      return {
        ...check,
        durationMs: result.durationMs,
        parsedErrors: result.parsedErrors,
        affectedFiles: result.affectedFiles,
      };
    }
    case "ai_run_validation": {
      const projectIdentifier = args.projectId ? asString(args.projectId) : "";
      const sessionId = args.sessionId ? asString(args.sessionId) : null;
      const session = sessionId ? store.getSession(sessionId) : null;
      const project = projectIdentifier
        ? store.getProject(projectIdentifier)
        : session?.projectId
          ? store.getProject(session.projectId)
          : null;
      if (!project) {
        throw new Error("ai_run_validation requires a resolvable projectId or a sessionId linked to a project.");
      }
      const projectConfig = readProjectChecksConfig(resolveProjectConfig(project.path).raw);
      const checks = Array.isArray(args.checks)
        ? (args.checks as string[]).filter((c) => typeof c === "string")
        : undefined;
      const continueOnFailure = args.continueOnFailure === true;
      const pipeline = await runValidationPipeline({
        cwd: project.path,
        projectConfig,
        checks,
        continueOnFailure,
        timeoutMs: 10 * 60_000,
      });
      for (const result of pipeline.results) {
        const summary =
          result.status === "completed" && result.exitCode === 0
            ? `${result.command} passed`
            : `${result.command} ${result.status}${result.exitCode != null ? ` (exit ${result.exitCode})` : ""}: ${(
                result.parsedErrors[0] ?? result.stderr ?? result.blockedReason ?? ""
              ).slice(0, 500)}`;
        store.memory.writeMemoryEvent({
          projectId: project.id,
          sessionId,
          type: "validation_result",
          command: result.command,
          status: result.status,
          summary,
          sourceRef: project.path,
          evidence: {
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            parsedErrors: result.parsedErrors,
            affectedFiles: result.affectedFiles,
            blockedReason: result.blockedReason,
          },
        });
      }
      if (sessionId) {
        store.appendEvent(
          createEvent(
            pipeline.allPassed ? "validation.passed" : "validation.failed",
            {
              projectId: project.id,
              allPassed: pipeline.allPassed,
              stoppedAt: pipeline.stoppedAt,
              results: pipeline.results.map((r) => ({
                name: r.name,
                status: r.status,
                exitCode: r.exitCode,
              })),
            },
            { sessionId, projectId: project.id, agent: "mcp", level: pipeline.allPassed ? "info" : "warn" }
          )
        );
      }
      return {
        projectId: project.id,
        allPassed: pipeline.allPassed,
        stoppedAt: pipeline.stoppedAt,
        results: pipeline.results.map((r) => ({
          name: r.name,
          command: r.command,
          status: r.status,
          exitCode: r.exitCode,
          durationMs: r.durationMs,
          parsedErrors: r.parsedErrors,
          affectedFiles: r.affectedFiles,
          blockedReason: r.blockedReason,
        })),
      };
    }
    case "ai_dev_start": {
      const devRequest = parseDevRequest({
        project: asString(args.project),
        goal: asString(args.goal),
        mode: args.mode,
        approvalPolicy: args.approvalPolicy,
        approveEdits: args.approveEdits === true,
        checks: Array.isArray(args.checks) ? args.checks : undefined,
        maxRepairs: typeof args.maxRepairs === "number" ? args.maxRepairs : undefined,
      });
      const project = store.getProject(devRequest.project);
      if (!project) {
        throw new Error(`Unknown project: ${devRequest.project}`);
      }
      const requestedSessionId = args.sessionId ? asString(args.sessionId) : null;
      const existingSession = requestedSessionId ? store.getSession(requestedSessionId) : null;
      if (requestedSessionId && !existingSession) throw new Error(`Unknown session: ${requestedSessionId}`);
      if (existingSession && existingSession.projectId !== project.id) {
        throw new Error(`Session ${existingSession.id} does not belong to project ${project.id}`);
      }
      const session = existingSession
        ? store.updateSession(existingSession.id, {
            status: "running",
            finishedAt: null,
            durationMs: null,
            errorMessage: null,
            modelProfile: "dev-editor-local",
          })
        : store.createSession({
            projectId: project.id,
            title: devRequest.goal.slice(0, 80),
            userGoal: devRequest.goal,
            mode: "dev",
            source: "mcp",
            modelProfile: "dev-editor-local",
          });
      await store.ensureRuntimeDirs(config.runtimeDir);
      let previousExecutionEventId: string | null = null;
      const result = await runDevWorkflow({
        request: devRequest,
        project: {
          id: project.id,
          name: project.name,
          path: project.path,
          config: resolveProjectConfig(project.path).raw,
        },
        runtime: {
          devRuns: store.dev,
          execution: store.execution,
          retrieval: store.retrieval,
          models: store.models,
          conversation: store.conversation,
          modelRuntime: createModelRuntime({
            providers: store.models.listProviders().map((provider) => ({
              id: provider.id,
              kind: provider.kind,
              displayName: provider.displayName,
              baseUrl: provider.baseUrl,
              apiKeyEnv: provider.apiKeyEnv,
              enabled: provider.enabled,
            })),
            profiles: store.models.listProfiles(),
            cloudEnabled: config.cloudEnabled,
          }),
        },
        runtimeDir: config.runtimeDir,
        sessionId: session.id,
        source: "mcp",
        emit: (executionEvent) => {
          const event = createEvent(executionEvent.kind, executionEvent.data, {
            id: executionEvent.id,
            sessionId: executionEvent.sessionId,
            projectId: executionEvent.projectId,
            runId: executionEvent.runId,
            agent: "mcp",
            sourceService: "mcp",
            originSource: "mcp",
            level: executionEvent.level,
            summary: executionEvent.message,
            correlationId: executionEvent.runId,
            causationId: previousExecutionEventId,
            ts: executionEvent.ts,
          });
          store.appendEvent(event);
          previousExecutionEventId = event.id;
        },
      });
      return result.result;
    }
    case "ai_dev_status": {
      const runId = asString(args.runId);
      const run = store.dev.getRunWithEdits(runId);
      if (!run) {
        throw new Error(`Unknown dev run: ${runId}`);
      }
      return {
        run,
        workspace: store.execution.getWorkspaceForRun(run.id),
        approvals: store.execution.listApprovals(run.id),
        patches: store.execution.listPatches(run.id),
        commands: store.execution.listCommands(run.id),
      };
    }
    case "ai_dev_diff": {
      const runId = asString(args.runId);
      const run = store.dev.getRun(runId);
      if (!run) {
        throw new Error(`Unknown dev run: ${runId}`);
      }
      return {
        runId: run.id,
        status: run.status,
        summary: run.summary,
        diffSummary: run.diffSummary,
        diffText: run.diffText,
        filesEdited: run.filesEdited,
        filesCreated: run.filesCreated,
      };
    }
    case "ai_dev_cancel": {
      const outcome = await cancelDevRun({
        runId: asString(args.runId),
        runtime: { devRuns: store.dev, execution: store.execution },
        reason: typeof args.reason === "string" ? args.reason : "cancelled from MCP",
      });
      if (!outcome.ok) {
        throw new Error(outcome.error ?? "cancel failed");
      }
      if (outcome.run) {
        store.appendEvent(
          createEvent(
            "run.cancelled",
            { reason: typeof args.reason === "string" ? args.reason : "cancelled from MCP" },
            {
              sessionId: outcome.run.sessionId,
              projectId: outcome.run.projectId,
              runId: outcome.run.id,
              agent: "mcp",
              sourceService: "mcp",
              originSource: "mcp",
              summary: outcome.run.summary,
              correlationId: outcome.run.id,
            }
          )
        );
      }
      return outcome.run;
    }
    case "ai_get_context_pack": {
      const packId = asString(args.contextPackId);
      const pack = store.context.getPack(packId);
      if (!pack) {
        throw new Error(`Unknown context pack: ${packId}`);
      }
      return {
        pack,
        items: store.context.listItems(packId),
        budgetEvents: store.context.listBudgetEvents(packId),
      };
    }
    case "ai_list_memory_candidates": {
      const projectId = args.project ? asString(args.project) : null;
      const statusValue = args.status;
      const statusFilter =
        statusValue === "pending" || statusValue === "accepted" || statusValue === "rejected" ? statusValue : undefined;
      return store.memory.listCandidates(statusFilter, projectId, asNumber(args.limit, 50));
    }
    case "ai_accept_memory_candidate": {
      const candidateId = asString(args.candidateId);
      const before = store.memory.listCandidates(undefined, undefined, 1000).find((entry) => entry.id === candidateId);
      if (!before) {
        throw new Error(`Unknown memory candidate: ${candidateId}`);
      }
      if (before.status !== "pending") {
        return {
          entry: null,
          candidate: before,
          note: `Candidate already ${before.status}; no change.`,
        };
      }
      const notes = args.notes ? asString(args.notes) : null;
      const entry = store.memory.acceptCandidate(candidateId, notes);
      const after =
        store.memory.listCandidates(undefined, undefined, 1000).find((entry) => entry.id === candidateId) ?? before;
      store.appendEvent(
        createEvent(
          "lesson.created",
          { kind: "memory", source: "mcp", candidateId },
          {
            sessionId: before.sessionId,
            projectId: before.projectId,
            agent: "mcp",
          }
        )
      );
      return { entry, candidate: after };
    }
    case "ai_list_skill_candidates": {
      const statusValue = args.status;
      const statusFilter =
        statusValue === "pending" ||
        statusValue === "active" ||
        statusValue === "rejected" ||
        statusValue === "deprecated"
          ? statusValue
          : "pending";
      return store.skills.listCandidates(statusFilter, asNumber(args.limit, 50));
    }
    case "ai_accept_skill_candidate": {
      const candidateId = asString(args.candidateId);
      const candidates = store.skills.listCandidates("pending", 1000);
      const before = candidates.find((entry) => entry.id === candidateId);
      if (!before) {
        throw new Error(`Unknown pending skill candidate: ${candidateId}`);
      }
      const skill = store.skills.acceptCandidate(candidateId);
      const allCandidates = store.skills.listCandidates(undefined, 1000);
      const after = allCandidates.find((entry) => entry.id === candidateId) ?? before;
      store.appendEvent(
        createEvent(
          "lesson.created",
          { kind: "skill", source: "mcp", candidateId },
          {
            projectId: before.projectId,
            agent: "mcp",
          }
        )
      );
      return { skill, candidate: after };
    }
    case "ai_reject_memory_candidate": {
      const candidateId = asString(args.candidateId);
      const reason = args.reason ? asString(args.reason) : null;
      const before = store.memory.listCandidates(undefined, undefined, 1000).find((entry) => entry.id === candidateId);
      if (!before) {
        throw new Error(`Unknown memory candidate: ${candidateId}`);
      }
      if (before.status !== "pending") {
        return { candidate: before, note: `Candidate already ${before.status}; no change.` };
      }
      store.memory.reviewCandidate(candidateId, "rejected", reason);
      const after =
        store.memory.listCandidates(undefined, undefined, 1000).find((entry) => entry.id === candidateId) ?? before;
      store.appendEvent(
        createEvent(
          "lesson.created",
          { kind: "memory_rejected", source: "mcp", candidateId, reason },
          {
            sessionId: before.sessionId,
            projectId: before.projectId,
            agent: "mcp",
          }
        )
      );
      return { candidate: after };
    }
    case "ai_reject_skill_candidate": {
      const candidateId = asString(args.candidateId);
      const reason = args.reason ? asString(args.reason) : null;
      const candidates = store.skills.listCandidates("pending", 1000);
      const candidate = candidates.find((entry) => entry.id === candidateId);
      if (!candidate) {
        throw new Error(`Unknown pending skill candidate: ${candidateId}`);
      }
      const updated = store.skills.reviewCandidate(candidateId, "rejected");
      store.appendEvent(
        createEvent(
          "lesson.created",
          { kind: "skill_rejected", source: "mcp", candidateId, reason },
          {
            projectId: candidate.projectId,
            agent: "mcp",
          }
        )
      );
      return { candidate: updated };
    }
    case "ai_get_model_calls": {
      const sessionId = asString(args.sessionId);
      const role = args.role ? asString(args.role) : null;
      const calls = store.models.listCalls(sessionId, asNumber(args.limit, 200));
      const filtered = role ? calls.filter((entry) => entry.role === role) : calls;
      return filtered;
    }
    case "ai_get_retrieval_query": {
      const queryId = asString(args.retrievalQueryId);
      const query = store.retrieval.getQuery(queryId);
      if (!query) {
        throw new Error(`Unknown retrieval query: ${queryId}`);
      }
      return {
        query,
        results: store.retrieval.listResults(queryId, 200),
        selectedContext: store.retrieval.listSelectedContext(queryId),
        feedback: store.retrieval.listFeedback(queryId, 50),
        misses: store.retrieval.listMisses(queryId),
      };
    }
    case "ai_record_feedback": {
      const retrievalQueryId = asString(args.retrievalQueryId);
      const ratingInput = asString(args.rating);
      const rating = ratingInput === "good" || ratingInput === "bad" || ratingInput === "missed" ? ratingInput : null;
      if (!rating) {
        throw new Error(`Invalid rating: must be 'good', 'bad', or 'missed'`);
      }
      const chunkId = typeof args.chunkId === "string" && args.chunkId.length > 0 ? args.chunkId : null;
      const missedPath = typeof args.missedPath === "string" && args.missedPath.length > 0 ? args.missedPath : null;
      if (rating !== "missed" && !chunkId) {
        throw new Error(`'good' and 'bad' feedback require a chunkId; 'missed' requires a missedPath`);
      }
      if (rating === "missed" && !missedPath) {
        throw new Error(`'missed' feedback requires a missedPath`);
      }
      const query = store.retrieval.getQuery(retrievalQueryId);
      if (!query) {
        throw new Error(`Unknown retrieval query: ${retrievalQueryId}`);
      }
      const feedback = store.retrieval.recordFeedback({
        retrievalQueryId,
        chunkId,
        rating,
        missedPath,
        notes: typeof args.notes === "string" ? args.notes : null,
      });
      const pathBoosts = query.projectId ? store.retrieval.listPathBoosts(query.projectId, 200) : [];
      const matchingBoost = chunkId
        ? pathBoosts.find((b) => {
            const chunkRow = store.db
              .prepare(
                "SELECT d.path AS path FROM rag_chunks c JOIN rag_documents d ON d.id = c.document_id WHERE c.id = ?"
              )
              .get(chunkId) as { path: string | null } | undefined;
            return chunkRow?.path === b.path;
          })
        : missedPath
          ? pathBoosts.find((b) => b.path === missedPath)
          : undefined;
      store.appendEvent(
        createEvent(
          "lesson.created",
          { kind: "retrieval_feedback", source: "mcp", retrievalQueryId, rating },
          { projectId: query.projectId, sessionId: query.sessionId, agent: "mcp" }
        )
      );
      return {
        feedback,
        pathBoost: matchingBoost ?? null,
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export function getToolDescriptors(): ToolDescriptor[] {
  return toolDescriptors();
}

export async function handleMcpRequest(
  store: Store,
  config: ConfigSnapshot,
  request: JsonRpcRequest
): Promise<JsonRpcResponse | null> {
  if (request.method === "initialize") {
    return ok(request.id ?? null, {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: { listChanged: false },
      },
      serverInfo: {
        name: "ai-workbench",
        version: "0.1.0",
      },
    });
  }

  if (request.method === "initialized" || request.method === "notifications/initialized" || request.method === "ping") {
    return request.id == null ? null : ok(request.id, {});
  }

  if (request.method === "tools/list") {
    return ok(request.id ?? null, { tools: toolDescriptors() });
  }

  if (request.method === "tools/call") {
    const params = asRecord(request.params);
    const toolName = asString(params.name);
    const args = asRecord(params.arguments);
    const allowed = new Set(toolDescriptors().map((tool) => tool.name));
    if (!allowed.has(toolName)) {
      logMcpCall(store, {
        toolName,
        sessionId: args.sessionId ? asString(args.sessionId) : null,
        projectId: args.project ? asString(args.project) : args.projectId ? asString(args.projectId) : null,
        payload: args,
        blocked: true,
        output: { error: `Unknown tool: ${toolName}` },
      });
      return err(request.id ?? null, -32602, `Unknown tool: ${toolName}`);
    }
    try {
      const output = await handleTool(store, config, toolName, args);
      logMcpCall(store, {
        toolName,
        sessionId: args.sessionId ? asString(args.sessionId) : null,
        projectId: args.project ? asString(args.project) : args.projectId ? asString(args.projectId) : null,
        payload: args,
        output,
      });
      store.appendEvent(
        createEvent(
          "tool.completed",
          { tool: toolName, args },
          {
            sessionId: args.sessionId ? asString(args.sessionId) : null,
            projectId: args.project ? asString(args.project) : args.projectId ? asString(args.projectId) : null,
            agent: "mcp",
          }
        )
      );
      return ok(request.id ?? null, textResult(output));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logMcpCall(store, {
        toolName,
        sessionId: args.sessionId ? asString(args.sessionId) : null,
        projectId: args.project ? asString(args.project) : args.projectId ? asString(args.projectId) : null,
        payload: args,
        blocked: true,
        output: { error: message },
      });
      store.appendEvent(
        createEvent(
          "tool.failed",
          { tool: toolName, error: message },
          {
            sessionId: args.sessionId ? asString(args.sessionId) : null,
            projectId: args.project ? asString(args.project) : args.projectId ? asString(args.projectId) : null,
            agent: "mcp",
            level: "error",
          }
        )
      );
      return err(request.id ?? null, -32000, message);
    }
  }

  if (request.method === "shutdown") {
    return ok(request.id ?? null, {});
  }

  if (request.id == null) {
    return null;
  }

  return err(request.id, -32601, `Unknown method: ${request.method}`);
}
