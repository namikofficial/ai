import type {
  AgentRunRecord,
  CompiledPromptRecord,
  ContextPackRecord,
  ConversationMessageRecord,
  EventEnvelope,
  ModelCallRecord,
  RetrievalQueryRecord,
  SessionOutcomeRecord,
  SessionRecord,
  SessionTimelineCounts,
  SessionTimelineResponse,
  TimelineItem,
} from "../../shared/src/index.ts";

export interface BuildSessionTimelineInput {
  session: SessionRecord;
  messages?: ReadonlyArray<ConversationMessageRecord | null | undefined> | null;
  events?: ReadonlyArray<EventEnvelope | null | undefined> | null;
  agentRuns?: ReadonlyArray<AgentRunRecord | null | undefined> | null;
  modelCalls?: ReadonlyArray<ModelCallRecord | null | undefined> | null;
  compiledPrompts?: ReadonlyArray<CompiledPromptRecord | null | undefined> | null;
  retrievalQueries?: ReadonlyArray<RetrievalQueryRecord | null | undefined> | null;
  contextPacks?: ReadonlyArray<ContextPackRecord | null | undefined> | null;
  outcomes?: ReadonlyArray<SessionOutcomeRecord | null | undefined> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeParseJson(value: string | null | undefined): unknown {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeTimestamp(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return "1970-01-01T00:00:00.000Z";
}

function createTimelineItem(input: {
  id: string;
  ts: string;
  kind: TimelineItem["kind"];
  title: string;
  summary: string;
  payload: unknown;
  status?: string | null;
  durationMs?: number | null;
  refs?: Record<string, string | null>;
}): TimelineItem {
  return {
    id: input.id,
    ts: input.ts,
    kind: input.kind,
    title: input.title,
    status: input.status ?? undefined,
    durationMs: input.durationMs ?? null,
    summary: input.summary,
    refs: input.refs ?? {},
    payload: input.payload,
  };
}

function createFallbackId(prefix: string, index: number): string {
  return `${prefix}-${index}`;
}

export function buildSessionTimeline(input: BuildSessionTimelineInput): SessionTimelineResponse {
  const messages = (input.messages ?? []).filter((item): item is ConversationMessageRecord => Boolean(item));
  const events = (input.events ?? []).filter((item): item is EventEnvelope => Boolean(item));
  const agentRuns = (input.agentRuns ?? []).filter((item): item is AgentRunRecord => Boolean(item));
  const modelCalls = (input.modelCalls ?? []).filter((item): item is ModelCallRecord => Boolean(item));
  const compiledPrompts = (input.compiledPrompts ?? []).filter((item): item is CompiledPromptRecord => Boolean(item));
  const retrievalQueries = (input.retrievalQueries ?? []).filter((item): item is RetrievalQueryRecord => Boolean(item));
  const contextPacks = (input.contextPacks ?? []).filter((item): item is ContextPackRecord => Boolean(item));
  const outcomes = (input.outcomes ?? []).filter((item): item is SessionOutcomeRecord => Boolean(item));

  const contextPackByQueryId = new Map<string, ContextPackRecord>();
  for (const pack of contextPacks) {
    if (pack.retrievalQueryId) {
      contextPackByQueryId.set(pack.retrievalQueryId, pack);
    }
  }

  const items: TimelineItem[] = [];

  events.forEach((event, index) => {
    items.push(
      createTimelineItem({
        id: asString(event.id, createFallbackId("event", index)),
        ts: normalizeTimestamp(event.ts, input.session.startedAt),
        kind: "event",
        title: asString(event.type, "event"),
        summary: JSON.stringify(event.payload ?? {}),
        payload: event,
        refs: {
          sessionId: event.sessionId,
          taskId: event.taskId,
          projectId: event.projectId,
        },
      })
    );
  });

  messages.forEach((message, index) => {
    const content = asString(message.content, "");
    items.push(
      createTimelineItem({
        id: asString(message.id, createFallbackId("message", index)),
        ts: normalizeTimestamp(message.ts, message.createdAt, input.session.startedAt),
        kind: "message",
        title: `${asString(message.role, "message")} message`,
        summary: content.length > 0 ? content.slice(0, 240) : "(empty message)",
        payload: message,
        refs: {
          sessionId: message.sessionId,
          projectId: message.projectId,
          parentMessageId: message.parentMessageId,
        },
      })
    );
  });

  agentRuns.forEach((run, index) => {
    items.push(
      createTimelineItem({
        id: asString(run.id, createFallbackId("agent-run", index)),
        ts: normalizeTimestamp(run.startedAt, run.createdAt, input.session.startedAt),
        kind: "agent_run",
        title: asString(run.agent, "agent run"),
        summary: `${asString(run.status, "unknown")} · ${asString(run.role, "role")}${run.modelRole ? ` · model=${run.modelRole}` : ""}`,
        payload: run,
        status: run.status,
        durationMs: run.durationMs,
        refs: {
          sessionId: run.sessionId,
          taskId: run.taskId,
          projectId: run.projectId,
          runId: run.id,
        },
      })
    );
  });

  modelCalls.forEach((call, index) => {
    const profileId = asString(call.profileId, "unknown-profile");
    const error = asString(call.error, "");
    items.push(
      createTimelineItem({
        id: asString(call.id, createFallbackId("model-call", index)),
        ts: normalizeTimestamp(call.ts, call.createdAt, input.session.startedAt),
        kind: "model_call",
        title: `${asString(call.role, "model")} call`,
        summary: [
          `profile=${profileId}`,
          `status=${asString(call.status, "unknown")}`,
          `latency=${Math.max(0, Math.round(call.latencyMs))}ms`,
          `tokens=${Math.max(0, Math.round(call.promptTokens))}/${Math.max(0, Math.round(call.completionTokens))}`,
          error ? `error=${error}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
        payload: call,
        status: call.status,
        durationMs: call.latencyMs,
        refs: {
          sessionId: call.sessionId,
          taskId: call.taskId,
          retrievalQueryId: call.retrievalQueryId,
          profileId: call.profileId,
          callId: call.id,
        },
      })
    );
  });

  compiledPrompts.forEach((prompt, index) => {
    const messagesJson = safeParseJson(prompt.messagesJson);
    const includedContextJson = safeParseJson(prompt.includedContextJson);
    const omittedContextJson = safeParseJson(prompt.omittedContextJson);
    const safetyNotesJson = safeParseJson(prompt.safetyNotesJson);
    const outputSchemaJson = safeParseJson(prompt.outputSchemaJson);
    const safetyNoteCount = Array.isArray(safetyNotesJson) ? safetyNotesJson.length : 0;
    const messageCount = Array.isArray(messagesJson) ? messagesJson.length : 0;
    items.push(
      createTimelineItem({
        id: asString(prompt.id, createFallbackId("compiled-prompt", index)),
        ts: normalizeTimestamp(prompt.createdAt, input.session.startedAt),
        kind: "compiled_prompt",
        title: `${asString(prompt.mode, "prompt")} prompt`,
        summary: [
          `role=${asString(prompt.role, "unknown")}`,
          `estimatedTokens=${Math.max(0, Math.round(prompt.estimatedTokens))}`,
          `safetyNotes=${safetyNoteCount}`,
          `messages=${messageCount}`,
        ].join(" · "),
        payload: {
          ...prompt,
          messages: messagesJson,
          includedContext: includedContextJson,
          omittedContext: omittedContextJson,
          safetyNotes: safetyNotesJson,
          outputSchema: outputSchemaJson,
        },
        refs: {
          sessionId: prompt.sessionId,
          taskId: prompt.taskId,
          retrievalQueryId: prompt.retrievalQueryId,
          contextPackId: prompt.contextPackId,
          promptId: prompt.id,
        },
      })
    );
  });

  retrievalQueries.forEach((query, index) => {
    const analysis = (isRecord(query.analysis) ? query.analysis : {}) as Record<string, unknown>;
    const rewrittenQuery = asString(query.rewrittenQuery, "");
    const analysisNotes = Array.isArray(analysis.notes) ? analysis.notes.length : 0;
    const pathHints = Array.isArray(analysis.pathHints) ? analysis.pathHints.length : 0;
    const confidence = asNumber(analysis.confidence);
    const contextPack = contextPackByQueryId.get(query.id);
    items.push(
      createTimelineItem({
        id: asString(query.id, createFallbackId("retrieval-query", index)),
        ts: normalizeTimestamp(query.createdAt, input.session.startedAt),
        kind: "retrieval_query",
        title: asString(query.originalQuery, "retrieval query"),
        summary: [
          rewrittenQuery ? `rewritten=${rewrittenQuery}` : null,
          confidence == null ? null : `confidence=${confidence.toFixed(2)}`,
          `pathHints=${pathHints}`,
          `notes=${analysisNotes}`,
        ]
          .filter(Boolean)
          .join(" · "),
        payload: {
          ...query,
          analysis,
          contextPackId: contextPack?.id ?? null,
          selectedContextPackId: contextPack?.id ?? null,
          confidence,
        },
        refs: {
          sessionId: query.sessionId,
          taskId: query.taskId,
          projectId: query.projectId,
          retrievalQueryId: query.id,
          queryId: query.id,
          contextPackId: contextPack?.id ?? null,
        },
      })
    );
  });

  contextPacks.forEach((pack, index) => {
    const relatedQuery = retrievalQueries.find((query) => query.id === pack.retrievalQueryId);
    items.push(
      createTimelineItem({
        id: asString(pack.id, createFallbackId("context-pack", index)),
        ts: normalizeTimestamp(pack.createdAt, input.session.startedAt),
        kind: "context_pack",
        title: asString(pack.reason, "context pack"),
        summary: [
          `usedTokens=${Math.max(0, Math.round(pack.usedTokens))}`,
          `budgetTokens=${Math.max(0, Math.round(pack.budgetTokens))}`,
          relatedQuery ? `query=${relatedQuery.originalQuery}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
        payload: {
          ...pack,
          query: relatedQuery ?? null,
        },
        refs: {
          sessionId: pack.sessionId,
          taskId: pack.taskId,
          retrievalQueryId: pack.retrievalQueryId,
          projectId: pack.projectId,
          contextPackId: pack.id,
          packId: pack.id,
        },
      })
    );
  });

  outcomes.forEach((outcome, index) => {
    items.push(
      createTimelineItem({
        id: asString(outcome.id, createFallbackId("eval", index)),
        ts: normalizeTimestamp(outcome.createdAt, input.session.startedAt),
        kind: "eval",
        title: asString(outcome.outcome, "eval"),
        summary: [`score=${outcome.score.toFixed(2)}`, outcome.notes ? `notes=${outcome.notes}` : null]
          .filter(Boolean)
          .join(" · "),
        payload: outcome,
        status: outcome.outcome,
        refs: {
          sessionId: outcome.sessionId,
          outcomeId: outcome.id,
        },
      })
    );
  });

  items.sort((left, right) => left.ts.localeCompare(right.ts) || left.id.localeCompare(right.id));

  const counts: SessionTimelineCounts = {
    messages: messages.length,
    events: events.length,
    agentRuns: agentRuns.length,
    modelCalls: modelCalls.length,
    compiledPrompts: compiledPrompts.length,
    retrievalQueries: retrievalQueries.length,
    contextPacks: contextPacks.length,
    outcomes: outcomes.length,
  };

  return {
    session: input.session,
    timeline: items,
    items,
    counts,
    trace: {
      messages,
      events,
      agentRuns,
      modelCalls,
      compiledPrompts,
      retrievalQueries,
      contextPacks,
      outcomes,
    },
  };
}
