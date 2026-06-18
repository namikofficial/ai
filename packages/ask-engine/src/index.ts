import { buildContextPack } from "../../context-engine/src/index.ts";
import type {
  ModelInvokeOptions,
  ModelInvokeRequest,
  ModelInvokeResult,
  ModelRuntime,
} from "../../model-runtime/src/index.ts";
import {
  buildAnswerFromCompiledPrompt,
  type CompiledPrompt,
  type CompilePromptInput,
  type ContextPackItemForPrompt,
  compilePrompt,
} from "../../prompt-compiler/src/index.ts";
import type { RankedChunk } from "../../retrieval-engine/src/index.ts";
import { analyzeQuery, classifyIntent, rewriteQuery, runRetrievalPipeline } from "../../retrieval-engine/src/index.ts";
import { buildRetrievalPipelineInput, type RetrievalPipelineSource } from "../../retrieval-engine/src/pipeline.ts";
import type {
  AskRequest,
  AskResponse,
  CompiledPromptRecord,
  ConversationMessageRecord,
  EventEnvelope,
  FactRecord,
  MemoryEntryRecord,
  ModelCallRecord,
  ModelProfileRecord,
  ModelRole,
  ModelRouteRecord,
  ProjectRuleRecord,
  ProjectSummary,
  RetrievalChunk,
  RetrievalFeedbackRecord,
  RetrievalIntentKind,
  RetrievalMissRecord,
  RetrievalQueryRecord,
  RetrievalResultRecord,
  RetrievalSelectedContextRecord,
  SessionRecord,
  SkillRecord,
  TaskRecord,
} from "../../shared/src/index.ts";
import { createEvent, createId } from "../../shared/src/index.ts";
import { isLikelyJsonOutput, parseJsonFragment } from "../../shared/src/model-output.ts";

export interface BuildAskQueryRewritePromptInput {
  question: string;
  retrievalQueryId: string;
  intent: string;
  mode: string;
  analysis: unknown;
}

export function buildAskQueryRewritePrompt(input: BuildAskQueryRewritePromptInput): CompilePromptInput {
  return {
    mode: "query_rewrite",
    role: "query_rewrite",
    userRequest: input.question,
    taskConstraints: [
      `Intent: ${input.intent}`,
      `Mode: ${input.mode}`,
      "Return retrieval rewrites, path hints, and symbol hints only.",
    ],
    outputSchema: {
      type: "object",
      properties: {
        rewrites: { type: "array", items: { type: "string" } },
        pathHints: { type: "array", items: { type: "string" } },
        symbolHints: { type: "array", items: { type: "string" } },
      },
      required: ["rewrites", "pathHints", "symbolHints"],
    },
    metadata: { retrievalQueryId: input.retrievalQueryId, analysis: input.analysis },
  };
}

export interface BuildAskRetrievalJudgePromptInput {
  question: string;
  retrievalQueryId: string;
  contextPackId: string;
  rewrittenQuery: string;
  mode: string;
  depth: string;
  retrievalChunks: RetrievalChunk[];
  rankedCount: number;
  selectedCount: number;
  droppedCount: number;
}

export function buildAskRetrievalJudgePrompt(input: BuildAskRetrievalJudgePromptInput): CompilePromptInput {
  return {
    mode: "retrieval_judge",
    role: "retrieval_judge",
    contextPackId: input.contextPackId,
    userRequest: input.question,
    retrievalChunks: input.retrievalChunks,
    taskConstraints: [
      `Rewritten query: ${input.rewrittenQuery}`,
      `Ranked: ${input.rankedCount}`,
      `Selected: ${input.selectedCount}`,
      `Dropped: ${input.droppedCount}`,
      `Mode: ${input.mode}`,
      `Depth: ${input.depth}`,
    ],
    outputSchema: {
      type: "object",
      properties: {
        confidence: { type: "number" },
        confidenceNotes: { type: "array", items: { type: "string" } },
        miss: { type: ["object", "null"] },
      },
      required: ["confidence", "confidenceNotes"],
    },
    metadata: { retrievalQueryId: input.retrievalQueryId, contextPackId: input.contextPackId },
  };
}

export interface BuildAskAnswerPromptInput {
  question: string;
  projectName: string;
  contextPackId: string;
  confidence: number;
  insufficientReason: string | null;
  projectRules: ProjectRuleRecord[];
  memoryEntries: MemoryEntryRecord[];
  facts: FactRecord[];
  retrievalChunks: RetrievalChunk[];
  contextPackItems: ContextPackItemForPrompt[];
  previousMessages: ConversationMessageRecord[];
  sessionId: string;
  retrievalQueryId: string;
  tokenBudget?: number;
}

export function buildAskAnswerPrompt(input: BuildAskAnswerPromptInput): CompilePromptInput {
  return {
    mode: "answer",
    role: "answer",
    contextPackId: input.contextPackId,
    userRequest: input.question,
    projectRules: input.projectRules,
    memoryEntries: input.memoryEntries,
    facts: input.facts,
    retrievalChunks: input.retrievalChunks,
    contextPackItems: input.contextPackItems,
    previousMessages: input.previousMessages,
    taskConstraints: [
      `Project: ${input.projectName}`,
      `Confidence before synthesis: ${Math.round(input.confidence * 100)}%`,
      input.insufficientReason ?? "Answer only from provided context and cite paths.",
    ],
    outputSchema: {
      type: "object",
      properties: {
        answer: { type: "string" },
        citations: { type: "array" },
        confidence: { type: "number" },
      },
      required: ["answer", "citations", "confidence"],
    },
    metadata: {
      sessionId: input.sessionId,
      retrievalQueryId: input.retrievalQueryId,
      contextPackId: input.contextPackId,
    },
    tokenBudget: input.tokenBudget ?? 4096,
  };
}

export function buildAskCitations(selected: RankedChunk[]): Array<{
  chunkId: string;
  path: string;
  startLine: number;
  endLine: number;
  excerpt: string;
  score: number;
}> {
  return selected.map((entry) => ({
    chunkId: entry.chunk.id,
    path: entry.chunk.path,
    startLine: entry.chunk.startLine,
    endLine: entry.chunk.endLine,
    excerpt: entry.chunk.content.split("\n").slice(0, 4).join("\n"),
    score: entry.finalScore,
  }));
}

export function buildAskFallbackAnswer(projectName: string, question: string): string {
  return `I could not find enough local context in ${projectName} to answer "${question}".`;
}

export function buildAskSynthesisFailure(question: string): string {
  return `I could not synthesize a model answer for "${question}" from the selected context.`;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((item) => typeof item === "string")) return null;
  return value;
}

function parseQueryRewriteOutput(value: unknown): {
  rewrites: string[];
  pathHints: string[];
  symbolHints: string[];
} | null {
  if (!isObjectRecord(value)) return null;
  const rewrites = toStringArray(value.rewrites);
  const pathHints = toStringArray(value.pathHints);
  const symbolHints = toStringArray(value.symbolHints);
  if (!rewrites || !pathHints || !symbolHints) return null;
  return {
    rewrites: rewrites.map((entry) => entry.trim()).filter((entry) => entry.length > 0),
    pathHints: pathHints.map((entry) => entry.trim()).filter((entry) => entry.length > 0),
    symbolHints: symbolHints.map((entry) => entry.trim()).filter((entry) => entry.length > 0),
  };
}

function parseRetrievalJudgeOutput(value: unknown): {
  confidence: number;
  confidenceNotes: string[];
  miss: { path: string | null; notes: string | null } | null;
} | null {
  if (!isObjectRecord(value)) return null;
  if (typeof value.confidence !== "number" || Number.isNaN(value.confidence)) return null;
  const confidenceNotes = toStringArray(value.confidenceNotes);
  if (!confidenceNotes) return null;
  let miss: { path: string | null; notes: string | null } | null = null;
  if (value.miss !== null && value.miss !== undefined) {
    if (!isObjectRecord(value.miss)) return null;
    miss = {
      path: typeof value.miss.path === "string" ? value.miss.path : null,
      notes: typeof value.miss.notes === "string" ? value.miss.notes : null,
    };
  }
  return {
    confidence: Math.max(0, Math.min(1, value.confidence)),
    confidenceNotes,
    miss,
  };
}

export interface AskWorkflowStore extends RetrievalPipelineSource {
  getProject(identifier: string): ProjectSummary | null;
  getSession(sessionId: string): SessionRecord | null;
  searchChunks(projectId: string, query: string, options?: { limit?: number }): RetrievalChunk[];
  searchChunksWithVector?: (
    projectId: string,
    query: string,
    queryVector: number[],
    options?: { limit?: number }
  ) => RetrievalChunk[];
  listProjectFiles(projectId: string, limit: number): Array<{ path: string }>;
  createSession(input: {
    projectId: string | null;
    title: string;
    userGoal: string;
    mode: AskRequest["mode"] | "index" | "plan" | "handoff" | "check" | "reflect" | "dev";
    source: string;
    modelProfile?: string | null;
  }): SessionRecord;
  updateSession(sessionId: string, patch: Partial<SessionRecord>): SessionRecord;
  createLesson(input: {
    projectId: string | null;
    sessionId: string | null;
    title: string;
    body: string;
    tags: string[];
    importance: number;
  }): { id: string };
  appendEvent(event: EventEnvelope): EventEnvelope;
  recordCompiledPrompt(input: {
    compiledPrompt: {
      id: string;
      mode: string;
      role: string;
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
      estimatedTokens: number;
      contextPackId?: string;
      includedContext: unknown[];
      omittedContext: unknown[];
      safetyNotes: string[];
      outputSchema?: unknown;
    };
    sessionId?: string | null;
    taskId?: string | null;
    retrievalQueryId?: string | null;
    contextPackId?: string | null;
  }): CompiledPromptRecord;
  conversation: {
    appendMessage(input: {
      sessionId: string;
      projectId?: string | null;
      role: "user" | "assistant" | "system" | "tool" | "agent";
      agent?: string | null;
      content: string;
      parentMessageId?: string | null;
      tokenCount?: number;
      meta?: Record<string, unknown>;
      ts?: string | null;
    }): ConversationMessageRecord;
    listMessages(sessionId: string, limit?: number): ConversationMessageRecord[];
  };
  retrieval: {
    createQuery(input: {
      sessionId?: string | null;
      taskId?: string | null;
      projectId: string;
      originalQuery: string;
      intent: string;
      mode: string;
      depth: string;
      rewrittenQuery?: string | null;
      analysis: unknown;
    }): { id: string; intent: string };
    updateRewrittenQuery(queryId: string, rewrittenQuery: string): void;
    createRewrite(input: {
      retrievalQueryId: string;
      variant: string;
      terms: string[];
      pathHints: string[];
      symbolHints: string[];
      score: number;
    }): void;
    recordResults(
      retrievalQueryId: string,
      rows: Array<{
        chunkId: string;
        path: string;
        startLine: number;
        endLine: number;
        source: RetrievalResultRecord["source"];
        baseScore: number;
        finalScore: number;
        included?: boolean;
        rerankScore?: number;
        reason?: string | null;
      }>
    ): void;
    recordSelectedContext(
      retrievalQueryId: string,
      rows: Array<{
        chunkId: string;
        rank: number;
        tokenCount: number;
        excerpt: string;
      }>
    ): void;
    recordMiss(input: {
      retrievalQueryId: string;
      missedPath: string;
      confidence: number;
      notes?: string | null;
    }): void;
    listQueriesForSession(sessionId: string, limit?: number): RetrievalQueryRecord[];
    listQueriesForProject(projectId: string, limit?: number): RetrievalQueryRecord[];
    listPathBoosts(projectId: string, limit?: number): Array<{ path: string; weight: number }>;
    listResults(queryId: string, limit?: number): RetrievalResultRecord[];
    listSelectedContext(queryId: string): RetrievalSelectedContextRecord[];
    listFeedback(queryId: string, limit?: number): RetrievalFeedbackRecord[];
    listMisses(queryId: string): RetrievalMissRecord[];
  };
  context: {
    recordPack(input: {
      sessionId?: string | null;
      projectId?: string | null;
      retrievalQueryId?: string | null;
      budgetTokens: number;
      usedTokens: number;
      reason?: string | null;
      items: Array<{
        kind: string;
        sourceId?: string | null;
        rank: number;
        tokenCount: number;
        excerpt: string;
        included?: boolean;
        omissionReason?: string | null;
      }>;
      budgetEvents?: Array<{
        deltaTokens: number;
        reason: string;
      }>;
    }): { id: string; budgetTokens: number; usedTokens: number };
    listPacksForSession(sessionId: string, limit?: number): Array<{ id: string; reason: string | null }>;
    listItems(packId: string): Array<{
      kind: string;
      rank: number;
      tokenCount: number;
      excerpt: string;
      sourceId: string | null;
      included: boolean;
      omissionReason: string | null;
    }>;
    listBudgetEvents(packId: string): Array<{ reason: string; deltaTokens: number }>;
  };
  memory: {
    listEntries(projectId: string | null, scope?: string, limit?: number): MemoryEntryRecord[];
    listFacts(projectId: string | null, limit?: number): FactRecord[];
    listProjectRules(projectId: string, limit?: number): ProjectRuleRecord[];
  };
  skills: {
    listSkills(status?: string, limit?: number): SkillRecord[];
  };
  models: {
    getProfile(id: string): ModelProfileRecord | null;
    listCalls(sessionId: string, limit?: number): ModelCallRecord[];
    recordCall(input: {
      sessionId?: string | null;
      taskId?: string | null;
      retrievalQueryId?: string | null;
      profileId: string;
      role: ModelRole;
      promptTokens?: number;
      completionTokens?: number;
      latencyMs?: number;
      status: "ok" | "failed" | "fallback" | "blocked";
      error?: string | null;
      request?: Record<string, unknown>;
      response?: Record<string, unknown>;
    }): ModelCallRecord;
    recordRoute(input: {
      taskPattern: string;
      mode: "local" | "cloud" | "hybrid" | "any";
      selectedProfileId: string;
      fallbackProfileId?: string | null;
      reason?: string | null;
    }): ModelRouteRecord;
  };
  agents: {
    createRun(input: {
      sessionId: string;
      projectId: string;
      agent: string;
      role: string;
      modelRole: ModelRole;
      risk: "low" | "medium" | "high";
      input: Record<string, unknown>;
      taskId?: string | null;
    }): { id: string; startedAt: string };
    appendMessage(input: {
      agentRunId: string;
      direction: "in" | "out" | "internal";
      role: string;
      content: string;
      meta?: Record<string, unknown>;
    }): void;
    updateRun(id: string, patch: Record<string, unknown>): void;
  };
  evals: {
    recordAnswerEvaluation(input: {
      sessionId?: string | null;
      retrievalQueryId?: string | null;
      groundedness: number;
      citationCoverage: number;
      contradiction: number;
      notes?: string | null;
    }): void;
    recordSessionOutcome(input: {
      sessionId: string;
      outcome: "success" | "partial" | "failed";
      score: number;
      notes?: string | null;
    }): void;
  };
  invokeModel(profileId: string, request: ModelInvokeRequest, options?: ModelInvokeOptions): Promise<ModelInvokeResult>;
  enqueueJob(input: { type: string; payload: Record<string, unknown>; availableAt?: string | null }): { id: string };
  listEvents(sessionId?: string, limit?: number): EventEnvelope[];
}

export interface RunAskWorkflowInput {
  store: AskWorkflowStore;
  runtime: Pick<ModelRuntime, "route" | "invoke" | "embed">;
  cloudEnabled: boolean;
  input: AskRequest;
  preferredAnswerProfileId?: string | null;
  sessionId?: string | null;
}

export async function runAskWorkflow(input: RunAskWorkflowInput): Promise<AskResponse> {
  const project = input.store.getProject(input.input.project);
  if (!project) {
    throw new Error(`Unknown project: ${input.input.project}`);
  }
  const mode = input.input.mode ?? "local";
  const depth = input.input.depth ?? "standard";
  const existingSession = input.sessionId ? input.store.getSession(input.sessionId) : null;
  const { decision: routeDecision, profileId: selectedAnswerProfile } = await (async () => {
    const decision = await input.runtime.route({
      role: "answer",
      mode,
      cloudEnabled: input.cloudEnabled,
      details: {
        depth,
        question: input.input.question,
        contextTokens: depth === "deep" ? 8192 : depth === "shallow" ? 2048 : 4096,
      },
      fallbackProfileId: "ask-fast-local",
    });
    return {
      decision,
      profileId:
        existingSession?.modelProfile ??
        input.preferredAnswerProfileId ??
        decision.profileId ??
        decision.fallbackProfileId ??
        "ask-fast-local",
    };
  })();

  const session =
    existingSession ??
    input.store.createSession({
      projectId: project.id,
      title: `Ask: ${input.input.question.slice(0, 60)}`,
      userGoal: input.input.question,
      mode,
      modelProfile: selectedAnswerProfile,
      source: "cli",
    });
  input.store.models.recordRoute({
    taskPattern: "ask",
    mode,
    selectedProfileId: selectedAnswerProfile,
    fallbackProfileId: routeDecision.fallbackProfileId,
    reason: `${routeDecision.reason}; depth=${depth}; blocked=${routeDecision.blocked}`,
  });

  const userMessage = input.store.conversation.appendMessage({
    sessionId: session.id,
    projectId: project.id,
    role: "user",
    agent: "user",
    content: input.input.question,
    meta: { mode, depth },
  });

  const analysis = analyzeQuery(input.input.question);
  const rewritten = rewriteQuery(input.input.question, analysis);
  const intent: RetrievalIntentKind = classifyIntent(input.input.question, mode);
  const intentAgentRun = input.store.agents.createRun({
    sessionId: session.id,
    projectId: project.id,
    agent: "intent_agent",
    role: "intent-classifier",
    modelRole: "intent",
    risk: "low",
    input: { question: input.input.question, mode },
  });
  input.store.agents.appendMessage({
    agentRunId: intentAgentRun.id,
    direction: "internal",
    role: "intent",
    content: JSON.stringify({ intent, analysis }),
    meta: { analysis },
  });
  input.store.agents.updateRun(intentAgentRun.id, {
    status: "completed",
    finishedAt: new Date().toISOString(),
    durationMs: 0,
    output: { intent, analysis },
  });

  const retrievalQuery = input.store.retrieval.createQuery({
    sessionId: session.id,
    projectId: project.id,
    originalQuery: input.input.question,
    intent,
    mode,
    depth,
    rewrittenQuery: rewritten.variant,
    analysis,
  });
  const queryRewriterAgentRun = input.store.agents.createRun({
    sessionId: session.id,
    projectId: project.id,
    agent: "query_rewriter_agent",
    role: "query-rewriter",
    modelRole: "query_rewrite",
    risk: "low",
    input: { question: input.input.question, retrievalQueryId: retrievalQuery.id, intent, mode },
  });
  const queryRewriteProfileId = input.store.models.getProfile("query-rewrite-local")?.id ?? "query-rewrite-local";
  const queryRewritePrompt = compilePrompt(
    buildAskQueryRewritePrompt({
      question: input.input.question,
      retrievalQueryId: retrievalQuery.id,
      intent: retrievalQuery.intent,
      mode,
      analysis,
    })
  );
  input.store.recordCompiledPrompt({
    compiledPrompt: queryRewritePrompt,
    sessionId: session.id,
    retrievalQueryId: retrievalQuery.id,
  });
  let queryRewriteCallId: string | null = null;
  let queryRewriteParseStatus: "parsed" | "repaired" | "deterministic_fallback" = "deterministic_fallback";
  let rewriteVariants = [rewritten.variant];
  let rewritePathHints = [...rewritten.pathHints];
  let rewriteSymbolHints = [...rewritten.symbolHints];
  try {
    input.store.appendEvent(
      createEvent(
        "model.called",
        {
          role: "query_rewrite",
          profileId: queryRewriteProfileId,
          compiledId: queryRewritePrompt.id,
        },
        { sessionId: session.id, projectId: project.id, agent: "retriever" }
      )
    );
    const queryRewriteResult = await input.store.invokeModel(
      queryRewriteProfileId,
      {
        role: "query_rewrite",
        messages: queryRewritePrompt.messages,
        temperature: 0,
        maxOutputTokens: input.store.models.getProfile(queryRewriteProfileId)?.maxOutputTokens ?? 512,
        metadata: {
          compiledPrompt: queryRewritePrompt,
          retrievalQueryId: retrievalQuery.id,
          deterministicRewrite: rewritten,
        },
      },
      {
        sessionId: session.id,
        retrievalQueryId: retrievalQuery.id,
      }
    );
    const parseQueryRewriteResult = (text: string): ReturnType<typeof parseQueryRewriteOutput> => {
      try {
        return parseQueryRewriteOutput(parseJsonFragment(text));
      } catch {
        return null;
      }
    };
    let parsedRewrite = parseQueryRewriteResult(queryRewriteResult.text);
    if (parsedRewrite) {
      queryRewriteParseStatus = "parsed";
    } else if (isLikelyJsonOutput(queryRewriteResult.text)) {
      const repaired = await input.store.invokeModel(
        queryRewriteProfileId,
        {
          role: "query_rewrite",
          messages: [
            ...queryRewritePrompt.messages,
            { role: "assistant", content: queryRewriteResult.text },
            {
              role: "user",
              content: "Return ONLY valid JSON matching the output schema. No markdown fences.",
            },
          ],
          temperature: 0,
          maxOutputTokens: input.store.models.getProfile(queryRewriteProfileId)?.maxOutputTokens ?? 512,
          metadata: {
            compiledPrompt: queryRewritePrompt,
            retrievalQueryId: retrievalQuery.id,
            repairAttempt: true,
          },
        },
        {
          sessionId: session.id,
          retrievalQueryId: retrievalQuery.id,
        }
      );
      parsedRewrite = parseQueryRewriteResult(repaired.text);
      if (parsedRewrite) {
        queryRewriteParseStatus = "repaired";
      }
    }
    if (parsedRewrite) {
      const normalized = parsedRewrite.rewrites.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
      if (normalized.length > 0) {
        rewriteVariants = normalized.slice(0, 6);
      }
      rewritePathHints = parsedRewrite.pathHints.length > 0 ? parsedRewrite.pathHints : rewritePathHints;
      rewriteSymbolHints = parsedRewrite.symbolHints.length > 0 ? parsedRewrite.symbolHints : rewriteSymbolHints;
    }
    const selectedRewrite = rewriteVariants[0] ?? rewritten.variant;
    if (selectedRewrite !== rewritten.variant || selectedRewrite !== input.input.question.trim()) {
      input.store.retrieval.updateRewrittenQuery(retrievalQuery.id, selectedRewrite);
    }
    for (const [index, variant] of rewriteVariants.entries()) {
      const terms = variant
        .toLowerCase()
        .split(/[^a-z0-9_]+/g)
        .filter((term) => term.length >= 2);
      input.store.retrieval.createRewrite({
        retrievalQueryId: retrievalQuery.id,
        variant,
        terms,
        pathHints: rewritePathHints,
        symbolHints: rewriteSymbolHints,
        score: Math.max(0.1, 1 - index * 0.1),
      });
    }
    queryRewriteCallId =
      input.store.models
        .listCalls(session.id, 200)
        .filter((call) => call.role === "query_rewrite" && call.retrievalQueryId === retrievalQuery.id)
        .at(-1)?.id ?? null;
    input.store.appendEvent(
      createEvent(
        "model.completed",
        {
          role: "query_rewrite",
          profileId: queryRewriteProfileId,
          requestId: queryRewriteCallId,
          compiledId: queryRewritePrompt.id,
        },
        { sessionId: session.id, projectId: project.id, agent: "retriever" }
      )
    );
  } catch (error) {
    input.store.appendEvent(
      createEvent(
        "model.failed",
        {
          role: "query_rewrite",
          error: error instanceof Error ? error.message : String(error),
          compiledId: queryRewritePrompt.id,
        },
        { sessionId: session.id, projectId: project.id, agent: "retriever", level: "warn" }
      )
    );
    input.store.retrieval.createRewrite({
      retrievalQueryId: retrievalQuery.id,
      variant: rewritten.variant,
      terms: rewritten.terms,
      pathHints: rewritten.pathHints,
      symbolHints: rewritten.symbolHints,
      score: 1,
    });
  }
  const selectedRewriteVariant = rewriteVariants[0] ?? rewritten.variant;
  const retrievalAgentRun = input.store.agents.createRun({
    sessionId: session.id,
    projectId: project.id,
    agent: "retrieval_agent",
    role: "retrieval-pipeline",
    modelRole: "retrieval_judge",
    risk: "low",
    input: {
      question: input.input.question,
      rewrittenQuery: selectedRewriteVariant,
      projectId: project.id,
      mode,
      depth,
    },
  });
  input.store.agents.updateRun(queryRewriterAgentRun.id, {
    status: "completed",
    finishedAt: new Date().toISOString(),
    durationMs: 0,
    output: {
      retrievalQueryId: retrievalQuery.id,
      selectedRewrite: selectedRewriteVariant,
      variantCount: rewriteVariants.length,
      parseStatus: queryRewriteParseStatus,
    },
  });
  input.store.agents.appendMessage({
    agentRunId: retrievalAgentRun.id,
    direction: "internal",
    role: "intent",
    content: JSON.stringify({ intent: retrievalQuery.intent, analysis }),
    meta: { retrievalQueryId: retrievalQuery.id },
  });

  const retrievalStarted = createEvent(
    "retrieval.started",
    { question: input.input.question },
    { sessionId: session.id, projectId: project.id, agent: "retriever" }
  );
  input.store.appendEvent(retrievalStarted);

  const ftsLimit = input.input.depth === "deep" ? 12 : input.input.depth === "shallow" ? 4 : 8;
  const embeddingProfileId = input.store.models.getProfile("embedding-local")?.id ?? "embedding-local";
  const embeddingProfile = input.store.models.getProfile(embeddingProfileId);
  const queryEmbedding = await input.runtime.embed(
    embeddingProfileId,
    {
      input: selectedRewriteVariant,
      modelName: embeddingProfile?.modelName ?? "embedding-local",
    },
    {
      sessionId: session.id,
      taskId: retrievalAgentRun.id,
      retrievalQueryId: retrievalQuery.id,
      recordCall: (call) => {
        input.store.models.recordCall(call);
      },
    }
  );
  const queryVector = queryEmbedding.embeddings[0] ?? [];
  const pipelineInput = buildRetrievalPipelineInput(input.store, {
    projectId: project.id,
    query: selectedRewriteVariant,
    intent,
    mode,
    depth,
    ftsLimit,
    queryVector,
  });
  const pipelineOutput = runRetrievalPipeline(pipelineInput);
  const ranked = pipelineOutput.ranked;
  const selected = pipelineOutput.selected;
  const dropped = pipelineOutput.dropped;
  const chunks = selected.map((entry) => entry.chunk);
  const citations = buildAskCitations(selected);

  input.store.retrieval.recordResults(
    retrievalQuery.id,
    ranked.map((entry) => ({
      chunkId: entry.chunk.id,
      path: entry.chunk.path,
      startLine: entry.chunk.startLine,
      endLine: entry.chunk.endLine,
      source: "heuristic",
      baseScore: entry.baseScore,
      rerankScore: entry.rerankScore,
      finalScore: entry.finalScore,
      included: selected.some((s) => s.chunk.id === entry.chunk.id),
      reason: entry.rerankReason,
    }))
  );
  input.store.retrieval.recordSelectedContext(
    retrievalQuery.id,
    selected.map((entry, index) => ({
      chunkId: entry.chunk.id,
      rank: index,
      tokenCount: entry.chunk.tokenCount,
      excerpt: entry.chunk.content.split("\n").slice(0, 4).join("\n"),
    }))
  );
  const memoryEntries = input.store.memory.listEntries(project.id, undefined, 20);
  const facts = input.store.memory.listFacts(project.id, 20);
  const rules = input.store.memory.listProjectRules(project.id, 20);
  const skills = input.store.skills.listSkills("active", 20);
  const previousMessages = input.store.conversation.listMessages(session.id).slice(-8);
  const contextAgentRun = input.store.agents.createRun({
    sessionId: session.id,
    projectId: project.id,
    agent: "context_agent",
    role: "context-packer",
    modelRole: "summarizer",
    risk: "low",
    input: {
      retrievalQueryId: retrievalQuery.id,
      selectedChunkCount: selected.length,
      previousMessageCount: previousMessages.length,
      memoryCount: memoryEntries.length,
      factCount: facts.length,
      ruleCount: rules.length,
      skillCount: skills.length,
    },
  });
  const packedContext = buildContextPack({
    sessionId: session.id,
    projectId: project.id,
    retrievalQueryId: retrievalQuery.id,
    budgetTokens: 4096,
    ranked: selected,
    memoryEntries,
    facts,
    rules,
    previousMessages,
    skills,
  });
  const contextPack = input.store.context.recordPack({
    sessionId: session.id,
    projectId: project.id,
    retrievalQueryId: retrievalQuery.id,
    budgetTokens: packedContext.pack.budgetTokens,
    usedTokens: packedContext.pack.usedTokens,
    reason: packedContext.pack.reason ?? "ask",
    items: packedContext.items.map((item, index) => ({
      kind: item.kind,
      sourceId: item.sourceId,
      rank: item.rank ?? index,
      tokenCount: item.tokenCount,
      excerpt: item.excerpt,
      included: item.included,
      omissionReason: item.omissionReason,
    })),
    budgetEvents: [
      ...packedContext.budgetEvents.map((event) => ({
        deltaTokens: event.deltaTokens,
        reason: event.reason,
      })),
      ...dropped.map((entry) => ({
        deltaTokens: entry.chunk.tokenCount,
        reason: `dropped:${entry.rerankReason}`,
      })),
    ],
  });
  input.store.agents.updateRun(contextAgentRun.id, {
    status: "completed",
    finishedAt: new Date().toISOString(),
    durationMs: 0,
    output: {
      contextPackId: contextPack.id,
      itemCount: packedContext.items.length,
      usedTokens: packedContext.pack.usedTokens,
      budgetTokens: packedContext.pack.budgetTokens,
    },
  });

  const baseConfidence = pipelineOutput.confidence;
  let confidence = baseConfidence;
  let confidenceNotes = [...pipelineOutput.confidenceNotes];
  let resolvedMiss: { path: string; notes: string | null } | null = pipelineOutput.miss
    ? { path: pipelineOutput.miss.path, notes: pipelineOutput.miss.notes }
    : null;
  let retrievalJudgeParseStatus: "parsed" | "repaired" | "deterministic_fallback" = "deterministic_fallback";
  const retrievalJudgeProfileId = input.store.models.getProfile("retrieval-judge-local")?.id ?? "retrieval-judge-local";
  const retrievalJudgePrompt = compilePrompt(
    buildAskRetrievalJudgePrompt({
      question: input.input.question,
      retrievalQueryId: retrievalQuery.id,
      contextPackId: contextPack.id,
      rewrittenQuery: selectedRewriteVariant,
      mode,
      depth,
      retrievalChunks: chunks,
      rankedCount: ranked.length,
      selectedCount: selected.length,
      droppedCount: dropped.length,
    })
  );
  input.store.recordCompiledPrompt({
    compiledPrompt: retrievalJudgePrompt,
    sessionId: session.id,
    taskId: retrievalAgentRun.id,
    retrievalQueryId: retrievalQuery.id,
    contextPackId: contextPack.id,
  });
  const retrievalJudgeTrace = {
    confidence: baseConfidence,
    confidenceNotes: pipelineOutput.confidenceNotes,
    boost: pipelineOutput.boost,
    miss: pipelineOutput.miss ?? null,
    citations: citations.slice(0, 3),
    rankedCount: ranked.length,
    selectedCount: selected.length,
    droppedCount: dropped.length,
  };
  let retrievalJudgeCallId: string | null = null;
  try {
    input.store.appendEvent(
      createEvent(
        "model.called",
        {
          role: "retrieval_judge",
          profileId: retrievalJudgeProfileId,
          compiledId: retrievalJudgePrompt.id,
        },
        { sessionId: session.id, projectId: project.id, agent: "retriever" }
      )
    );
    const retrievalJudgeResult = await input.store.invokeModel(
      retrievalJudgeProfileId,
      {
        role: "retrieval_judge",
        messages: retrievalJudgePrompt.messages,
        temperature: 0,
        maxOutputTokens: input.store.models.getProfile(retrievalJudgeProfileId)?.maxOutputTokens ?? 512,
        metadata: {
          compiledPrompt: retrievalJudgePrompt,
          retrievalQueryId: retrievalQuery.id,
          contextPackId: contextPack.id,
          responseTrace: retrievalJudgeTrace,
        },
      },
      {
        sessionId: session.id,
        taskId: retrievalAgentRun.id,
        retrievalQueryId: retrievalQuery.id,
      }
    );
    const parseRetrievalJudgeResult = (text: string): ReturnType<typeof parseRetrievalJudgeOutput> => {
      try {
        return parseRetrievalJudgeOutput(parseJsonFragment(text));
      } catch {
        return null;
      }
    };
    let parsedJudge = parseRetrievalJudgeResult(retrievalJudgeResult.text);
    if (parsedJudge) {
      retrievalJudgeParseStatus = "parsed";
    } else if (isLikelyJsonOutput(retrievalJudgeResult.text)) {
      const repaired = await input.store.invokeModel(
        retrievalJudgeProfileId,
        {
          role: "retrieval_judge",
          messages: [
            ...retrievalJudgePrompt.messages,
            { role: "assistant", content: retrievalJudgeResult.text },
            {
              role: "user",
              content: "Return ONLY valid JSON matching the output schema. No markdown fences.",
            },
          ],
          temperature: 0,
          maxOutputTokens: input.store.models.getProfile(retrievalJudgeProfileId)?.maxOutputTokens ?? 512,
          metadata: {
            compiledPrompt: retrievalJudgePrompt,
            retrievalQueryId: retrievalQuery.id,
            contextPackId: contextPack.id,
            repairAttempt: true,
          },
        },
        {
          sessionId: session.id,
          taskId: retrievalAgentRun.id,
          retrievalQueryId: retrievalQuery.id,
        }
      );
      parsedJudge = parseRetrievalJudgeResult(repaired.text);
      if (parsedJudge) {
        retrievalJudgeParseStatus = "repaired";
      }
    }
    if (parsedJudge) {
      confidence = parsedJudge.confidence;
      confidenceNotes = parsedJudge.confidenceNotes;
      if (parsedJudge.miss?.path) {
        resolvedMiss = { path: parsedJudge.miss.path, notes: parsedJudge.miss.notes };
      } else if (parsedJudge.miss === null) {
        resolvedMiss = null;
      }
    }
    retrievalJudgeCallId =
      input.store.models
        .listCalls(session.id, 200)
        .filter(
          (call) =>
            call.role === "retrieval_judge" &&
            call.taskId === retrievalAgentRun.id &&
            call.retrievalQueryId === retrievalQuery.id
        )
        .at(-1)?.id ?? null;
    input.store.appendEvent(
      createEvent(
        "model.completed",
        {
          role: "retrieval_judge",
          profileId: retrievalJudgeProfileId,
          requestId: retrievalJudgeCallId,
          compiledId: retrievalJudgePrompt.id,
        },
        { sessionId: session.id, projectId: project.id, agent: "retriever" }
      )
    );
  } catch (error) {
    input.store.appendEvent(
      createEvent(
        "model.failed",
        {
          role: "retrieval_judge",
          error: error instanceof Error ? error.message : String(error),
          compiledId: retrievalJudgePrompt.id,
        },
        { sessionId: session.id, projectId: project.id, agent: "retriever", level: "warn" }
      )
    );
  }
  const insufficientReason =
    selected.length === 0
      ? "No matching chunks were found in the selected project."
      : confidence < 0.35
        ? (resolvedMiss?.notes ?? "retrieval confidence is low")
        : null;
  if (resolvedMiss) {
    input.store.retrieval.recordMiss({
      retrievalQueryId: retrievalQuery.id,
      missedPath: resolvedMiss.path,
      confidence,
      notes: resolvedMiss.notes ?? null,
    });
  } else if (selected.length === 0) {
    input.store.retrieval.recordMiss({
      retrievalQueryId: retrievalQuery.id,
      missedPath: project.path,
      confidence,
      notes: "no chunks returned from hybrid retrieval",
    });
  }

  // --- groundedness-driven retry ---
  // When the retrieval judge reports low confidence and the query
  // rewriter produced symbol hints, do a targeted FTS lookup for
  // those symbols.  If new chunks surface, re-run the retrieval
  // judge once to see if confidence improves.
  const RETRY_CONFIDENCE_THRESHOLD = 0.5;
  const MAX_RETRY_SYMBOL_QUERIES = 3;
  if (confidence < RETRY_CONFIDENCE_THRESHOLD && rewriteSymbolHints.length > 0) {
    const seenChunkIds = new Set(selected.map((entry) => entry.chunk.id));
    const retryChunks: RetrievalChunk[] = [];
    for (const hint of rewriteSymbolHints.slice(0, MAX_RETRY_SYMBOL_QUERIES)) {
      const results = input.store.searchChunks(project.id, hint, { limit: 4 });
      for (const chunk of results) {
        if (!seenChunkIds.has(chunk.id)) {
          seenChunkIds.add(chunk.id);
          retryChunks.push(chunk);
        }
      }
    }
    if (retryChunks.length > 0) {
      const augmentedSelected: RankedChunk[] = [
        ...selected,
        ...retryChunks.map(
          (chunk): RankedChunk => ({
            chunk,
            baseScore: 0.5,
            rerankScore: 0.5,
            finalScore: 0.5,
            rerankReason: "symbol_retry",
            boosters: ["symbol"],
          })
        ),
      ];
      const augmentedChunks = augmentedSelected.map((entry) => entry.chunk);
      const retryJudgeProfileId =
        input.store.models.getProfile("retrieval-judge-local")?.id ?? "retrieval-judge-local";
      const retryJudgePrompt = compilePrompt({
        ...buildAskRetrievalJudgePrompt({
          question: input.input.question,
          retrievalQueryId: retrievalQuery.id,
          contextPackId: contextPack.id,
          rewrittenQuery: selectedRewriteVariant,
          mode,
          depth,
          retrievalChunks: augmentedChunks,
          rankedCount: ranked.length,
          selectedCount: augmentedSelected.length,
          droppedCount: Math.max(0, dropped.length - retryChunks.length),
        }),
        idSuffix: "retry",
      });
      input.store.recordCompiledPrompt({
        compiledPrompt: retryJudgePrompt,
        sessionId: session.id,
        taskId: retrievalAgentRun.id,
        retrievalQueryId: retrievalQuery.id,
        contextPackId: contextPack.id,
      });
      try {
        input.store.appendEvent(
          createEvent(
            "model.called",
            {
              role: "retrieval_judge",
              profileId: retryJudgeProfileId,
              compiledId: retryJudgePrompt.id,
              retry: true,
              addedChunks: retryChunks.length,
            },
            { sessionId: session.id, projectId: project.id, agent: "retriever" }
          )
        );
        const retryResult = await input.store.invokeModel(
          retryJudgeProfileId,
          {
            role: "retrieval_judge",
            messages: retryJudgePrompt.messages,
            temperature: 0,
            maxOutputTokens: input.store.models.getProfile(retryJudgeProfileId)?.maxOutputTokens ?? 512,
            metadata: {
              compiledPrompt: retryJudgePrompt,
              retrievalQueryId: retrievalQuery.id,
              contextPackId: contextPack.id,
              retry: true,
              addedChunks: retryChunks.length,
            },
          },
          {
            sessionId: session.id,
            taskId: retrievalAgentRun.id,
            retrievalQueryId: retrievalQuery.id,
          }
        );
        const parseRetryJudge = (text: string): ReturnType<typeof parseRetrievalJudgeOutput> => {
          try {
            return parseRetrievalJudgeOutput(parseJsonFragment(text));
          } catch {
            return null;
          }
        };
        const retryParsed = parseRetryJudge(retryResult.text);
        if (retryParsed && retryParsed.confidence > confidence) {
          confidence = retryParsed.confidence;
          confidenceNotes = retryParsed.confidenceNotes;
          if (retryParsed.miss?.path) {
            resolvedMiss = { path: retryParsed.miss.path, notes: retryParsed.miss.notes };
          } else if (retryParsed.miss === null) {
            resolvedMiss = null;
          }
          // Update the selected set and chunks for answer synthesis.
          selected.length = 0;
          selected.push(...augmentedSelected);
          chunks.length = 0;
          chunks.push(...augmentedChunks);
          // Rebuild citations for the answer.
          citations.length = 0;
          citations.push(...buildAskCitations(selected));
        }
        input.store.appendEvent(
          createEvent(
            "model.completed",
            {
              role: "retrieval_judge",
              profileId: retryJudgeProfileId,
              retry: true,
              confidenceImproved: retryParsed ? retryParsed.confidence > RETRY_CONFIDENCE_THRESHOLD : false,
            },
            { sessionId: session.id, projectId: project.id, agent: "retriever" }
          )
        );
      } catch {
        // Retry failed — keep original confidence and chunks.
      }
    }
  }

  input.store.agents.updateRun(retrievalAgentRun.id, {
    status: "completed",
    finishedAt: new Date().toISOString(),
    durationMs: 0,
    output: {
      chunkCount: selected.length,
      rankedCount: ranked.length,
      droppedCount: dropped.length,
      confidence,
      confidenceNotes,
      parseStatus: retrievalJudgeParseStatus,
      retrievalQueryId: retrievalQuery.id,
    },
  });

  const answerAgentRun = input.store.agents.createRun({
    sessionId: session.id,
    projectId: project.id,
    agent: "answer_agent",
    role: "answer-synthesizer",
    modelRole: "answer",
    risk: "low",
    input: {
      question: input.input.question,
      retrievalQueryId: retrievalQuery.id,
      contextPackId: contextPack.id,
    },
  });
  const answerProfileId = session.modelProfile ?? selectedAnswerProfile;
  const compiledAnswer = compilePrompt(
    buildAskAnswerPrompt({
      question: input.input.question,
      projectName: project.name,
      contextPackId: contextPack.id,
      confidence,
      insufficientReason,
      projectRules: rules,
      memoryEntries,
      facts,
      retrievalChunks: chunks,
      contextPackItems: input.store.context
        .listItems(contextPack.id)
        .filter((item) => item.included)
        .map(
          (item): ContextPackItemForPrompt => ({
            kind: item.kind as ContextPackItemForPrompt["kind"],
            rank: item.rank,
            tokenCount: item.tokenCount,
            excerpt: item.excerpt,
            sourceId: item.sourceId,
          })
        ),
      previousMessages,
      sessionId: session.id,
      retrievalQueryId: retrievalQuery.id,
      tokenBudget: 4096,
    })
  );
  input.store.recordCompiledPrompt({
    compiledPrompt: compiledAnswer,
    sessionId: session.id,
    taskId: answerAgentRun.id,
    retrievalQueryId: retrievalQuery.id,
    contextPackId: contextPack.id,
  });
  let answer: string;
  let answerCallId: string | null = null;
  if (selected.length === 0) {
    answer = buildAskFallbackAnswer(project.name, input.input.question);
    input.store.appendEvent(
      createEvent(
        "answer.fallback",
        { reason: insufficientReason, question: input.input.question, confidence },
        { sessionId: session.id, projectId: project.id, agent: "answer_agent", level: "info" }
      )
    );
  } else {
    try {
      input.store.appendEvent(
        createEvent(
          "model.called",
          { role: "answer", profileId: answerProfileId, compiledId: compiledAnswer.id },
          { sessionId: session.id, projectId: project.id, agent: "answer_agent" }
        )
      );
      const result = await input.store.invokeModel(
        answerProfileId,
        {
          role: "answer",
          messages: compiledAnswer.messages,
          temperature: 0,
          maxOutputTokens: input.store.models.getProfile(answerProfileId)?.maxOutputTokens ?? 1024,
          metadata: {
            compiledPrompt: compiledAnswer,
            retrievalQueryId: retrievalQuery.id,
            contextPackId: contextPack.id,
            citations: citations.slice(0, 5),
            confidence,
          },
        },
        {
          sessionId: session.id,
          taskId: answerAgentRun.id,
          retrievalQueryId: retrievalQuery.id,
        }
      );
      const matchingCalls = input.store.models
        .listCalls(session.id, 200)
        .filter(
          (call) =>
            call.role === "answer" && call.taskId === answerAgentRun.id && call.retrievalQueryId === retrievalQuery.id
        );
      answerCallId = matchingCalls.at(-1)?.id ?? null;
      answer = buildAnswerFromCompiledPrompt(compiledAnswer, result.text, citations, confidence);
      input.store.appendEvent(
        createEvent(
          "model.completed",
          {
            role: "answer",
            profileId: answerProfileId,
            requestId: answerCallId,
            compiledId: compiledAnswer.id,
          },
          { sessionId: session.id, projectId: project.id, agent: "answer_agent" }
        )
      );
    } catch (error) {
      answer = buildAskSynthesisFailure(input.input.question);
      input.store.appendEvent(
        createEvent(
          "model.failed",
          {
            role: "answer",
            error: error instanceof Error ? error.message : String(error),
            compiledId: compiledAnswer.id,
          },
          { sessionId: session.id, projectId: project.id, agent: "answer_agent", level: "warn" }
        )
      );
    }
  }

  input.store.appendEvent(
    createEvent(
      chunks.length === 0 ? "retrieval.low_confidence" : "retrieval.completed",
      {
        question: input.input.question,
        chunkCount: chunks.length,
        confidence,
      },
      { sessionId: session.id, projectId: project.id, agent: "retriever" }
    )
  );
  input.store.appendEvent(
    createEvent(
      "session.completed",
      {
        summary: answer,
      },
      { sessionId: session.id, projectId: project.id, agent: "orchestrator" }
    )
  );
  input.store.updateSession(session.id, {
    status: "completed",
    finishedAt: new Date().toISOString(),
    durationMs: 0,
    finalSummary: answer,
    activeTaskId: null,
  });

  input.store.conversation.appendMessage({
    sessionId: session.id,
    projectId: project.id,
    role: "assistant",
    agent: "answer_agent",
    content: answer,
    parentMessageId: userMessage.id,
    meta: {
      confidence,
      retrievalQueryId: retrievalQuery.id,
      citationCount: citations.length,
      contextPackId: contextPack.id,
      compiledId: compiledAnswer.id,
      modelCallId: answerCallId,
    },
  });
  input.store.agents.updateRun(answerAgentRun.id, {
    status: "completed",
    finishedAt: new Date().toISOString(),
    durationMs: 0,
    output: {
      answer,
      confidence,
      citations: citations.length,
      contextPackId: contextPack.id,
      compiledId: compiledAnswer.id,
      modelCallId: answerCallId,
    },
  });

  if (chunks.length > 0) {
    input.store.createLesson({
      projectId: project.id,
      sessionId: session.id,
      title: `Answer: ${input.input.question.slice(0, 40)}`,
      body: answer,
      tags: ["ask", "retrieval"],
      importance: Math.max(1, Math.round(confidence * 5)),
    });
    input.store.appendEvent(
      createEvent(
        "lesson.created",
        {
          title: `Answer: ${input.input.question.slice(0, 40)}`,
          body: answer,
          tags: ["ask", "retrieval"],
          importance: Math.max(1, Math.round(confidence * 5)),
        },
        { sessionId: session.id, projectId: project.id, agent: "learning" }
      )
    );
  }
  input.store.evals.recordAnswerEvaluation({
    sessionId: session.id,
    retrievalQueryId: retrievalQuery.id,
    groundedness: chunks.length > 0 ? confidence : 0,
    citationCoverage: chunks.length > 0 ? Math.min(1, citations.length / 3) : 0,
    contradiction: 0,
    notes: chunks.length === 0 ? "no_chunks" : null,
  });
  input.store.evals.recordSessionOutcome({
    sessionId: session.id,
    outcome: chunks.length === 0 ? "failed" : confidence >= 0.5 ? "success" : "partial",
    score: confidence,
    notes: chunks.length === 0 ? "no_chunks" : null,
  });
  input.store.enqueueJob({
    type: "session.reflect",
    payload: { sessionId: session.id, source: "ask", projectId: project.id },
  });

  return {
    sessionId: session.id,
    projectId: project.id,
    question: input.input.question,
    answer,
    confidence,
    citations,
    retrievedChunks: chunks,
    insufficientReason,
  };
}
