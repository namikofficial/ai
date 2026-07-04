import type { createStore } from "../../../packages/db/src/store.ts";
import { resolveProjectConfig } from "../../../packages/config/src/index.ts";
import type { ConfigSnapshot, ProjectSummary, SessionRecord, TaskRecord } from "../../../packages/shared/src/index.ts";
import { createEvent } from "../../../packages/shared/src/index.ts";
import { readProjectChecksConfig, runAllowedChecks } from "../../../packages/execution-engine/src/index.ts";

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
      return (
        await store.createPlan({
          project: asString(args.project),
          goal: asString(args.goal),
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
        status: result.status,
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
