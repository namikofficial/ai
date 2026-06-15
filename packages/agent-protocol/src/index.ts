export type {
  AgentHandoffRecord,
  AgentMessageRecord,
  AgentRisk,
  AgentRunRecord,
  AgentStatus,
  AskMode,
  AskRequest,
  AskResponse,
  ConfigSnapshot,
  ContextBudgetEventRecord,
  ContextPackItemKind,
  ContextPackItemRecord,
  ContextPackRecord,
  ConversationMessageRecord,
  ConversationMessageRole,
  DashboardSnapshot,
  EvalCaseRecord,
  EvalRunRecord,
  EventEnvelope,
  EventLevel,
  EventType,
  FactRecord,
  FactSourceRecord,
  FactStatus,
  HandoffRequest,
  HandoffResponse,
  MemoryCandidateKind,
  MemoryCandidateRecord,
  MemoryCandidateStatus,
  MemoryEntryRecord,
  MemoryScope,
  ModelCallRecord,
  ModelCallStatus,
  ModelHealthCheckRecord,
  ModelHealthStatus,
  ModelProfileRecord,
  ModelProviderKind,
  ModelProviderRecord,
  ModelRole,
  ModelRouteRecord,
  PlanRequest,
  PlanResponse,
  ProjectCreateInput,
  ProjectRecord,
  ProjectRuleRecord,
  ProjectStatus,
  ProjectSummary,
  QueryAnalysis,
  QueryRewriteRecord,
  RetrievalChunk,
  RetrievalDepth,
  RetrievalEvaluationRecord,
  RetrievalFeedbackRating,
  RetrievalFeedbackRecord,
  RetrievalIntentKind,
  RetrievalMissRecord,
  RetrievalMode,
  RetrievalQueryRecord,
  RetrievalResultRecord,
  RetrievalSelectedContextRecord,
  ReviewRecord,
  ReviewRequest,
  ReviewResponse,
  SessionOutcomeKind,
  SessionOutcomeRecord,
  SessionRecord,
  SessionStatus,
  SkillCandidateRecord,
  SkillRecord,
  SkillSourceKind,
  SkillStatus,
  SkillUsageRecord,
  TaskRecord,
  TaskStatus,
} from "../../shared/src/index.ts";
export {
  createEvent,
  createId,
  parseAskRequest,
  parseEventEnvelope,
  parseProjectCreateInput,
  slugifyName,
} from "../../shared/src/index.ts";

import type { EventType } from "../../shared/src/index.ts";

export type AgentId =
  | "orchestrator"
  | "intent_agent"
  | "query_rewriter_agent"
  | "retrieval_agent"
  | "context_agent"
  | "planner_agent"
  | "research_agent"
  | "handoff_agent"
  | "review_agent"
  | "check_agent"
  | "learning_agent"
  | "model_router_agent"
  | "skill_agent"
  | "indexer"
  | "answer_agent"
  | "reflection_agent";

export type AgentToolName =
  | "project.search"
  | "project.read"
  | "project.write"
  | "retrieval.search"
  | "retrieval.rerank"
  | "model.invoke"
  | "memory.read"
  | "memory.write"
  | "facts.read"
  | "facts.write"
  | "session.emit"
  | "skill.use"
  | "skill.suggest"
  | "check.run"
  | "review.create"
  | "task.update"
  | "context.build";

export type AgentRetryPolicy = "none" | "fallback_only" | "exponential";

export interface AgentDescriptor {
  id: AgentId;
  role: string;
  description: string;
  allowedTools: AgentToolName[];
  requiredEvents: EventType[];
  modelRole: ModelRole | null;
  risk: "low" | "medium" | "high";
  timeoutMs: number;
  retry: AgentRetryPolicy;
  tags: string[];
}

const BASE_DESCRIPTORS: AgentDescriptor[] = [
  {
    id: "orchestrator",
    role: "session-coordinator",
    description: "Coordinates session lifecycle, intent classification, sub-agent dispatch, and reflection.",
    allowedTools: ["session.emit", "model.invoke", "task.update", "memory.read", "memory.write"],
    requiredEvents: ["session.created", "session.started", "session.completed", "session.failed"],
    modelRole: "planner",
    risk: "medium",
    timeoutMs: 60_000,
    retry: "fallback_only",
    tags: ["core", "session"],
  },
  {
    id: "intent_agent",
    role: "intent-classifier",
    description: "Classifies the user query into lookup, explain, debug, plan, review, or summary.",
    allowedTools: ["session.emit", "model.invoke"],
    requiredEvents: ["agent.started", "agent.completed", "agent.failed"],
    modelRole: "intent",
    risk: "low",
    timeoutMs: 15_000,
    retry: "exponential",
    tags: ["retrieval", "fast"],
  },
  {
    id: "query_rewriter_agent",
    role: "query-rewriter",
    description: "Generates typo-tolerant rewrites, path/symbol hints, and intent-conditioned variants.",
    allowedTools: ["session.emit", "model.invoke", "memory.read"],
    requiredEvents: ["agent.started", "agent.completed"],
    modelRole: "query_rewrite",
    risk: "low",
    timeoutMs: 15_000,
    retry: "exponential",
    tags: ["retrieval", "rewriting"],
  },
  {
    id: "retrieval_agent",
    role: "retrieval-pipeline",
    description: "Runs hybrid retrieval, rerank, compression, and confidence scoring.",
    allowedTools: ["retrieval.search", "retrieval.rerank", "session.emit", "memory.read", "facts.read"],
    requiredEvents: ["retrieval.started", "retrieval.completed", "retrieval.low_confidence"],
    modelRole: "retrieval_judge",
    risk: "low",
    timeoutMs: 30_000,
    retry: "none",
    tags: ["retrieval", "core"],
  },
  {
    id: "context_agent",
    role: "context-packer",
    description: "Builds a context pack from previous messages, memory, facts, retrieval results, and budget.",
    allowedTools: ["context.build", "session.emit", "memory.read", "facts.read"],
    requiredEvents: ["agent.started", "agent.completed"],
    modelRole: "summarizer",
    risk: "low",
    timeoutMs: 15_000,
    retry: "none",
    tags: ["context", "core"],
  },
  {
    id: "planner_agent",
    role: "task-graph-planner",
    description: "Builds a task graph with risk, expected files, checks, and model recommendation.",
    allowedTools: ["task.update", "session.emit", "model.invoke", "retrieval.search"],
    requiredEvents: ["task.created", "task.started", "task.completed", "task.failed"],
    modelRole: "planner",
    risk: "medium",
    timeoutMs: 60_000,
    retry: "fallback_only",
    tags: ["planning"],
  },
  {
    id: "research_agent",
    role: "research-brief",
    description: "Gathers a research brief with sources, credibility, and contradictions.",
    allowedTools: ["retrieval.search", "session.emit", "model.invoke", "facts.read", "memory.read"],
    requiredEvents: ["agent.started", "agent.completed", "agent.failed"],
    modelRole: "summarizer",
    risk: "low",
    timeoutMs: 60_000,
    retry: "fallback_only",
    tags: ["research"],
  },
  {
    id: "handoff_agent",
    role: "target-handoff",
    description: "Generates a target-specific handoff prompt with context pack, files, and stop conditions.",
    allowedTools: ["context.build", "session.emit", "model.invoke", "task.update"],
    requiredEvents: ["handoff.created"],
    modelRole: "coder_handoff",
    risk: "low",
    timeoutMs: 30_000,
    retry: "none",
    tags: ["handoff"],
  },
  {
    id: "review_agent",
    role: "review-guard",
    description: "Reviews planned vs edited files, scope creep, missing tests, and risky changes.",
    allowedTools: ["review.create", "session.emit", "memory.read", "facts.read"],
    requiredEvents: ["agent.started", "agent.completed"],
    modelRole: "reviewer",
    risk: "low",
    timeoutMs: 30_000,
    retry: "none",
    tags: ["review"],
  },
  {
    id: "check_agent",
    role: "allowlisted-checks",
    description: "Runs allowlisted checks and records failures as memory candidates.",
    allowedTools: ["check.run", "session.emit", "memory.write"],
    requiredEvents: ["check.started", "check.completed", "check.failed"],
    modelRole: "summarizer",
    risk: "medium",
    timeoutMs: 120_000,
    retry: "none",
    tags: ["checks", "safety"],
  },
  {
    id: "learning_agent",
    role: "learning-loop",
    description: "Creates memory candidates, accepts/rejects memory, and proposes skill candidates.",
    allowedTools: ["memory.read", "memory.write", "facts.read", "facts.write", "skill.suggest", "session.emit"],
    requiredEvents: ["lesson.created"],
    modelRole: "reflection",
    risk: "low",
    timeoutMs: 30_000,
    retry: "exponential",
    tags: ["learning", "memory"],
  },
  {
    id: "model_router_agent",
    role: "model-router",
    description: "Selects a model profile per task, runs health checks, and records model calls.",
    allowedTools: ["model.invoke", "session.emit"],
    requiredEvents: ["model.called", "model.completed", "model.failed"],
    modelRole: "answer",
    risk: "low",
    timeoutMs: 15_000,
    retry: "fallback_only",
    tags: ["models", "router"],
  },
  {
    id: "skill_agent",
    role: "skill-suggester",
    description: "Suggests, applies, and deprecates skills based on current task context.",
    allowedTools: ["skill.use", "skill.suggest", "session.emit", "memory.read"],
    requiredEvents: ["agent.started", "agent.completed"],
    modelRole: "summarizer",
    risk: "low",
    timeoutMs: 15_000,
    retry: "none",
    tags: ["skills"],
  },
  {
    id: "indexer",
    role: "indexer",
    description: "Scans the project tree, chunks files, and stores embeddings/FTS rows.",
    allowedTools: ["project.read", "session.emit", "task.update"],
    requiredEvents: ["task.started", "task.completed", "task.failed"],
    modelRole: "embedding",
    risk: "low",
    timeoutMs: 300_000,
    retry: "exponential",
    tags: ["indexing"],
  },
  {
    id: "answer_agent",
    role: "answer-synthesizer",
    description: "Generates the final answer from a context pack with citations and confidence.",
    allowedTools: ["context.build", "session.emit", "model.invoke", "memory.read", "facts.read"],
    requiredEvents: ["agent.started", "agent.completed", "agent.failed"],
    modelRole: "answer",
    risk: "low",
    timeoutMs: 60_000,
    retry: "fallback_only",
    tags: ["answer", "core"],
  },
  {
    id: "reflection_agent",
    role: "reflection",
    description: "Reviews a finished session and creates reviewable memory/skill candidates.",
    allowedTools: ["memory.write", "skill.suggest", "session.emit", "model.invoke"],
    requiredEvents: ["agent.started", "agent.completed"],
    modelRole: "reflection",
    risk: "low",
    timeoutMs: 30_000,
    retry: "exponential",
    tags: ["reflection", "learning"],
  },
];

export const AGENT_REGISTRY: ReadonlyMap<AgentId, AgentDescriptor> = new Map(
  BASE_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor])
);

export function listAgents(): AgentDescriptor[] {
  return Array.from(AGENT_REGISTRY.values());
}

export function getAgent(id: AgentId): AgentDescriptor | null {
  return AGENT_REGISTRY.get(id) ?? null;
}

export function isToolAllowed(id: AgentId, tool: AgentToolName): boolean {
  const agent = AGENT_REGISTRY.get(id);
  if (!agent) return false;
  return agent.allowedTools.includes(tool);
}

export function agentsWithTool(tool: AgentToolName): AgentDescriptor[] {
  return listAgents().filter((agent) => agent.allowedTools.includes(tool));
}

export function agentsWithModelRole(role: ModelRole): AgentDescriptor[] {
  return listAgents().filter((agent) => agent.modelRole === role);
}

export function isAgentId(value: string): value is AgentId {
  return AGENT_REGISTRY.has(value as AgentId);
}

import type {
  ModelInvokeOptions,
  ModelInvokeRequest,
  ModelInvokeResult,
  ModelRuntime,
} from "../../model-runtime/src/index.ts";
import type {
  AgentMessageRecord,
  AgentRunRecord,
  AgentStatus,
  EventEnvelope,
  ModelRole,
} from "../../shared/src/index.ts";
import { createEvent, createId } from "../../shared/src/index.ts";

export interface AgentExecutorHooks {
  recordRun(run: AgentRunRecord): void;
  recordMessage(message: AgentMessageRecord): void;
  emitEvent(event: EventEnvelope): void;
  invokeModel: (
    profileId: string,
    request: ModelInvokeRequest,
    options?: ModelInvokeOptions
  ) => Promise<ModelInvokeResult>;
  now: () => Date;
}

export interface AgentRunInput {
  id?: string;
  sessionId?: string | null;
  taskId?: string | null;
  projectId?: string | null;
  input: Record<string, unknown>;
  profileId?: string | null;
}

export interface AgentRunResult {
  run: AgentRunRecord;
  messages: AgentMessageRecord[];
  result?: ModelInvokeResult;
  error?: string;
}

export class AgentExecutor {
  readonly id: AgentId;
  private readonly runtime: ModelRuntime;
  private readonly hooks: AgentExecutorHooks;

  constructor(id: AgentId, runtime: ModelRuntime, hooks: AgentExecutorHooks) {
    if (!AGENT_REGISTRY.has(id)) {
      throw new Error(`unknown agent: ${id}`);
    }
    this.id = id;
    this.runtime = runtime;
    this.hooks = hooks;
  }

  descriptor(): AgentDescriptor {
    return AGENT_REGISTRY.get(this.id)!;
  }

  validateTool(tool: AgentToolName): boolean {
    return isToolAllowed(this.id, tool);
  }

  private createRun(
    input: AgentRunInput,
    status: AgentStatus,
    startedAt: string,
    finishedAt: string | null,
    output: Record<string, unknown>,
    error: string | null,
    modelRole: ModelRole | null
  ): AgentRunRecord {
    const descriptor = this.descriptor();
    return {
      id: input.id ?? createId("arun"),
      sessionId: input.sessionId ?? null,
      taskId: input.taskId ?? null,
      projectId: input.projectId ?? null,
      agent: descriptor.id,
      role: descriptor.role,
      status,
      input: input.input,
      output,
      modelRole: modelRole ?? descriptor.modelRole,
      risk: descriptor.risk,
      startedAt,
      finishedAt,
      durationMs: finishedAt ? new Date(finishedAt).getTime() - new Date(startedAt).getTime() : null,
      error,
      createdAt: startedAt,
      updatedAt: finishedAt ?? startedAt,
    };
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const descriptor = this.descriptor();
    const startedAt = this.hooks.now().toISOString();
    const messages: AgentMessageRecord[] = [];
    const runId = input.id ?? createId("arun");
    this.hooks.emitEvent(
      createEvent(
        "agent.started",
        { agent: descriptor.id, role: descriptor.role, risk: descriptor.risk, input: input.input },
        {
          sessionId: input.sessionId ?? null,
          taskId: input.taskId ?? null,
          projectId: input.projectId ?? null,
          agent: descriptor.id,
          id: `${runId}_started`,
        }
      )
    );
    if (input.input && typeof input.input === "object" && "tool" in input.input) {
      const toolName = String((input.input as Record<string, unknown>).tool);
      if (!descriptor.allowedTools.includes(toolName as AgentToolName)) {
        const run = this.createRun(
          { ...input, id: runId },
          "failed",
          startedAt,
          this.hooks.now().toISOString(),
          { error: "tool not allowed", tool: toolName },
          `tool ${toolName} not in allowlist`,
          descriptor.modelRole
        );
        this.hooks.recordRun(run);
        this.hooks.emitEvent(
          createEvent(
            "agent.failed",
            { agent: descriptor.id, runId: run.id, reason: "tool-not-allowed", tool: toolName },
            {
              sessionId: input.sessionId ?? null,
              taskId: input.taskId ?? null,
              projectId: input.projectId ?? null,
              agent: descriptor.id,
              level: "warn",
              id: `${runId}_failed_tool`,
            }
          )
        );
        return { run, messages, error: run.error ?? "tool not allowed" };
      }
    }
    const profileId =
      input.profileId ?? (descriptor.modelRole ? this.findProfileIdForRole(descriptor.modelRole) : null);
    if (!profileId) {
      const run = this.createRun(
        { ...input, id: runId },
        "failed",
        startedAt,
        this.hooks.now().toISOString(),
        { error: "no profile for role" },
        `no profile for role ${descriptor.modelRole ?? "none"}`,
        descriptor.modelRole
      );
      this.hooks.recordRun(run);
      this.hooks.emitEvent(
        createEvent(
          "agent.failed",
          { agent: descriptor.id, runId: run.id, reason: "no-profile" },
          {
            sessionId: input.sessionId ?? null,
            taskId: input.taskId ?? null,
            projectId: input.projectId ?? null,
            agent: descriptor.id,
            level: "warn",
            id: `${runId}_failed_profile`,
          }
        )
      );
      return { run, messages, error: run.error ?? "no profile" };
    }
    const systemMessage: AgentMessageRecord = {
      id: `${runId}_msg_in`,
      agentRunId: runId,
      direction: "in",
      role: "system",
      content: `Agent ${descriptor.id} (${descriptor.role}) starting`,
      meta: { profileId, risk: descriptor.risk, timeoutMs: descriptor.timeoutMs },
      ts: startedAt,
      createdAt: startedAt,
    };
    this.hooks.recordMessage(systemMessage);
    messages.push(systemMessage);

    const request: ModelInvokeRequest = {
      role: descriptor.modelRole ?? "answer",
      modelName: profileId,
      messages: [
        {
          role: "system",
          content: `You are the ${descriptor.id} agent. ${descriptor.description}`,
        },
        { role: "user", content: JSON.stringify(input.input) },
      ],
    };
    const start = this.hooks.now().getTime();
    let result: ModelInvokeResult | null = null;
    let error: string | null = null;
    try {
      result = await this.runWithRetry(profileId, request, descriptor.timeoutMs, input, runId);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const finishedAt = this.hooks.now().toISOString();
    const durationMs = this.hooks.now().getTime() - start;
    const status: AgentStatus = error ? "failed" : "completed";
    const run = this.createRun(
      { ...input, id: runId },
      status,
      startedAt,
      finishedAt,
      result ? { text: result.text, modelRole: descriptor.modelRole, profileId } : { error },
      error,
      descriptor.modelRole
    );
    this.hooks.recordRun(run);
    const outMessage: AgentMessageRecord = {
      id: `${runId}_msg_out`,
      agentRunId: runId,
      direction: "out",
      role: "assistant",
      content: result ? result.text : `error: ${error ?? "unknown"}`,
      meta: {
        profileId,
        modelRole: descriptor.modelRole,
        promptTokens: result?.promptTokens ?? 0,
        completionTokens: result?.completionTokens ?? 0,
        latencyMs: result?.latencyMs ?? durationMs,
        status: result?.status ?? "failed",
      },
      ts: finishedAt,
      createdAt: finishedAt,
    };
    this.hooks.recordMessage(outMessage);
    messages.push(outMessage);
    this.hooks.emitEvent(
      createEvent(
        status === "completed" ? "agent.completed" : "agent.failed",
        { agent: descriptor.id, runId: run.id, profileId, durationMs, status, error },
        {
          sessionId: input.sessionId ?? null,
          taskId: input.taskId ?? null,
          projectId: input.projectId ?? null,
          agent: descriptor.id,
          level: status === "completed" ? "info" : "warn",
          id: `${runId}_done`,
        }
      )
    );
    return { run, messages, result: result ?? undefined, error: error ?? undefined };
  }

  private findProfileIdForRole(role: ModelRole): string | null {
    const profiles = this.runtime.listProfiles().filter((profile) => profile.role === role && profile.enabled);
    if (profiles.length === 0) return null;
    return profiles[0].id;
  }

  private async runWithRetry(
    profileId: string,
    request: ModelInvokeRequest,
    timeoutMs: number,
    input: AgentRunInput,
    runId: string
  ): Promise<ModelInvokeResult> {
    const descriptor = this.descriptor();
    const maxAttempts = descriptor.retry === "exponential" ? 3 : 1;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await this.runWithTimeout(profileId, request, timeoutMs, input, runId);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (descriptor.retry === "none") throw lastError;
        if (descriptor.retry === "fallback_only") {
          const fallbackId = this.runtime
            .listProfiles()
            .find(
              (profile) =>
                profile.role === descriptor.modelRole &&
                profile.localOnly &&
                profile.enabled &&
                profile.id !== profileId
            )?.id;
          if (fallbackId) {
            return await this.runWithTimeout(fallbackId, request, timeoutMs, input, runId);
          }
          throw lastError;
        }
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
      }
    }
    throw lastError ?? new Error("agent retries exhausted");
  }

  private async runWithTimeout(
    profileId: string,
    request: ModelInvokeRequest,
    timeoutMs: number,
    input: AgentRunInput,
    runId: string
  ): Promise<ModelInvokeResult> {
    const agentId = this.id;
    return await new Promise<ModelInvokeResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`agent timeout after ${timeoutMs}ms`)), timeoutMs);
      this.hooks
        .invokeModel(profileId, request, {
          sessionId: input.sessionId ?? null,
          taskId: input.taskId ?? null,
          recordCall: (payload) => {
            this.hooks.emitEvent(
              createEvent(
                payload.status === "ok"
                  ? "model.completed"
                  : payload.status === "blocked"
                    ? "tool.blocked"
                    : "model.failed",
                {
                  profileId: payload.profileId,
                  role: payload.role,
                  latencyMs: payload.latencyMs,
                  status: payload.status,
                  error: payload.error,
                },
                {
                  sessionId: payload.sessionId ?? null,
                  taskId: payload.taskId ?? null,
                  agent: agentId,
                  level: payload.status === "ok" ? "info" : "warn",
                  id: `${runId}_model_${payload.profileId}`,
                }
              )
            );
          },
        })
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }
}

export function createAgentExecutor(input: {
  agentId: AgentId;
  runtime: ModelRuntime;
  hooks: AgentExecutorHooks;
}): AgentExecutor {
  return new AgentExecutor(input.agentId, input.runtime, input.hooks);
}
