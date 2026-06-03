import type { ConfigSnapshot, ProjectSummary, SessionRecord, TaskRecord } from "../../../packages/shared/src/index.ts";
import { createEvent } from "../../../packages/shared/src/index.ts";
import type { createStore } from "../../../packages/db/src/store.ts";

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

function toolDescriptors(): ToolDescriptor[] {
  return [
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
          mode: { type: "string", enum: ["local", "cloud", "hybrid"] },
          depth: { type: "string", enum: ["shallow", "standard", "deep"] },
        },
        required: ["project", "question"],
      },
    },
    {
      name: "ai_create_session",
      description: "Create a new tracked session.",
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
      name: "ai_create_plan",
      description: "Generate a task graph for a project goal.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          goal: { type: "string" },
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
  ];
}

function logMcpCall(store: Store, input: {
  toolName: string;
  sessionId?: string | null;
  projectId?: string | null;
  payload: Record<string, unknown>;
  blocked?: boolean;
  output?: unknown;
}): void {
  store.createMcpCall({
    toolName: input.toolName,
    sessionId: input.sessionId ?? null,
    projectId: input.projectId ?? null,
    inputJson: JSON.stringify(input.payload),
    outputJson: input.output == null ? null : JSON.stringify(input.output),
    blocked: input.blocked ?? false,
  });
}

function handleTool(store: Store, config: ConfigSnapshot, name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case "ai_search_project": {
      const project = asString(args.project);
      const query = asString(args.query);
      return { project, query, chunks: store.searchChunks(project, query, { limit: asNumber(args.limit, 8) }) };
    }
    case "ai_ask_rag": {
      return store.ask({
        project: asString(args.project),
        question: asString(args.question),
        mode: args.mode === "cloud" || args.mode === "hybrid" ? args.mode : "local",
        depth: args.depth === "shallow" || args.depth === "deep" ? args.depth : "standard",
      });
    }
    case "ai_create_session": {
      const session = store.createSession({
        projectId: asString(args.project),
        title: asString(args.title, `Session: ${asString(args.goal)}`),
        userGoal: asString(args.goal),
        mode: "plan",
        source: "mcp",
      });
      return session;
    }
    case "ai_create_plan":
      return store.createPlan({
        project: asString(args.project),
        goal: asString(args.goal),
        risk: args.risk === "low" || args.risk === "high" ? args.risk : "medium",
      }).response;
    case "ai_get_current_task":
      return store.getCurrentTask(asString(args.sessionId));
    case "ai_get_next_subtask":
      return store.getNextSubtask(asString(args.sessionId));
    case "ai_get_subtask_context":
      return store.getSubtaskContext(asString(args.sessionId), args.taskId == null ? null : asString(args.taskId));
    case "ai_create_handoff":
      return store.createHandoff({
        sessionId: asString(args.sessionId),
        project: asString(args.project),
        target: args.target === "opencode" || args.target === "codex" || args.target === "clipboard" || args.target === "file" ? args.target : "manual",
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
      return project ? store.listProjectLessons(project, asNumber(args.limit, 10)) : store.listRecentLessons(asNumber(args.limit, 10));
    }
    case "ai_reflect_session": {
      const session = store.getSession(asString(args.sessionId));
      if (!session) {
        throw new Error(`Unknown session: ${asString(args.sessionId)}`);
      }
      return store.createLesson({
        projectId: session.projectId,
        sessionId: session.id,
        title: `Reflection: ${session.title}`,
        body: session.finalSummary ?? session.userGoal,
        tags: ["reflection", "mcp"],
        importance: 3,
      });
    }
    case "ai_list_sessions":
      return args.project ? store.listProjectSessions(asString(args.project), asNumber(args.limit, 20)) : store.listSessions(asNumber(args.limit, 20));
    case "ai_get_session_trace":
      return {
        session: store.getSession(asString(args.sessionId)),
        events: store.listEvents(asString(args.sessionId), asNumber(args.limit, 200)),
      };
    case "ai_run_check": {
      const allowlisted = new Set(["typecheck", "tests", "build", "lint"]);
      const nameValue = asString(args.name);
      return store.createCheckRun({
        name: nameValue,
        projectId: args.projectId ? asString(args.projectId) : null,
        sessionId: args.sessionId ? asString(args.sessionId) : null,
        status: allowlisted.has(nameValue) ? "completed" : "blocked",
        command: nameValue,
        output: allowlisted.has(nameValue) ? `Recorded allowlisted check ${nameValue}.` : null,
        errorOutput: allowlisted.has(nameValue) ? null : `Check ${nameValue} is not allowlisted.`,
        exitCode: allowlisted.has(nameValue) ? 0 : 1,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export function getToolDescriptors(): ToolDescriptor[] {
  return toolDescriptors();
}

export function handleMcpRequest(store: Store, config: ConfigSnapshot, request: JsonRpcRequest): JsonRpcResponse | null {
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
      const output = handleTool(store, config, toolName, args);
      logMcpCall(store, {
        toolName,
        sessionId: args.sessionId ? asString(args.sessionId) : null,
        projectId: args.project ? asString(args.project) : args.projectId ? asString(args.projectId) : null,
        payload: args,
        output,
      });
      store.appendEvent(
        createEvent("tool.completed", { tool: toolName, args }, {
          sessionId: args.sessionId ? asString(args.sessionId) : null,
          projectId: args.project ? asString(args.project) : args.projectId ? asString(args.projectId) : null,
          agent: "mcp",
        }),
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
        createEvent("tool.failed", { tool: toolName, error: message }, {
          sessionId: args.sessionId ? asString(args.sessionId) : null,
          projectId: args.project ? asString(args.project) : args.projectId ? asString(args.projectId) : null,
          agent: "mcp",
          level: "error",
        }),
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
