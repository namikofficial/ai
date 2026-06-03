export {
  createEvent,
  createId,
  parseAskRequest,
  parseEventEnvelope,
  parseProjectCreateInput,
  slugifyName,
} from "../../shared/src/index.ts";

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

import type { EventType, ModelRole } from "../../shared/src/index.ts";

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
  BASE_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]),
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
