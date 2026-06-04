import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionTimeline } from "../packages/timeline/src/index.ts";

const session = {
  id: "sess_1",
  projectId: "proj_1",
  title: "Session",
  userGoal: "Goal",
  mode: "local",
  status: "running",
  source: "api",
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: null,
  durationMs: null,
  activeTaskId: null,
  modelProfile: null,
  finalSummary: null,
  errorMessage: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as const;

test("timeline builder sorts items chronologically and links related context", () => {
  const timeline = buildSessionTimeline({
    session,
    events: [
      {
        id: "event-2",
        type: "session.completed",
        sessionId: session.id,
        taskId: null,
        projectId: session.projectId,
        agent: null,
        level: "info",
        ts: "2026-01-01T00:00:03.000Z",
        payload: { ok: true },
      },
      {
        id: "event-1",
        type: "session.started",
        sessionId: session.id,
        taskId: null,
        projectId: session.projectId,
        agent: null,
        level: "info",
        ts: "2026-01-01T00:00:01.000Z",
        payload: { ok: true },
      },
    ],
    messages: [
      {
        id: "message-1",
        sessionId: session.id,
        projectId: session.projectId,
        role: "user",
        agent: null,
        content: "hello",
        contentHash: "hash",
        metaJson: "{}",
        tokenCount: 1,
        parentMessageId: null,
        ts: "2026-01-01T00:00:02.000Z",
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    ],
    agentRuns: [
      {
        id: "run-1",
        sessionId: session.id,
        taskId: null,
        projectId: session.projectId,
        agent: "answer_agent",
        role: "answer",
        status: "completed",
        input: {},
        output: {},
        modelRole: "answer",
        risk: "low",
        startedAt: "2026-01-01T00:00:04.000Z",
        finishedAt: "2026-01-01T00:00:05.000Z",
        durationMs: 1000,
        error: null,
        createdAt: "2026-01-01T00:00:04.000Z",
        updatedAt: "2026-01-01T00:00:05.000Z",
      },
    ],
    modelCalls: [
      {
        id: "call-1",
        sessionId: session.id,
        taskId: null,
        retrievalQueryId: "rq-1",
        profileId: "profile-1",
        role: "answer",
        promptTokens: 10,
        completionTokens: 20,
        latencyMs: 30,
        status: "ok",
        error: null,
        request: {},
        response: {},
        ts: "2026-01-01T00:00:06.000Z",
        createdAt: "2026-01-01T00:00:06.000Z",
      },
    ],
    compiledPrompts: [
      {
        id: "prompt-1",
        sessionId: session.id,
        taskId: null,
        retrievalQueryId: "rq-1",
        contextPackId: "pack-1",
        mode: "answer",
        role: "answer",
        messagesJson: "[]",
        estimatedTokens: 42,
        includedContextJson: "[]",
        omittedContextJson: "[]",
        safetyNotesJson: "[]",
        outputSchemaJson: null,
        createdAt: "2026-01-01T00:00:07.000Z",
      },
    ],
    retrievalQueries: [
      {
        id: "rq-1",
        sessionId: session.id,
        taskId: null,
        projectId: session.projectId,
        originalQuery: "where is auth handled?",
        intent: "lookup",
        mode: "local",
        depth: "standard",
        rewrittenQuery: "auth handling",
        analysis: {
          language: null,
          terms: ["auth"],
          pathHints: ["src/auth.ts"],
          symbolHints: [],
          isLikelyDefinition: false,
          isLikelyDebug: false,
          notes: ["rewrite"],
        },
        createdAt: "2026-01-01T00:00:08.000Z",
      },
    ],
    contextPacks: [
      {
        id: "pack-1",
        sessionId: session.id,
        taskId: null,
        projectId: session.projectId,
        retrievalQueryId: "rq-1",
        budgetTokens: 100,
        usedTokens: 80,
        reason: "answer",
        createdAt: "2026-01-01T00:00:09.000Z",
      },
    ],
    outcomes: [
      {
        id: "outcome-1",
        sessionId: session.id,
        outcome: "success",
        score: 0.95,
        notes: "done",
        createdAt: "2026-01-01T00:00:10.000Z",
      },
    ],
  });

  assert.deepEqual(
    timeline.timeline.map((item) => item.kind),
    ["event", "message", "event", "agent_run", "model_call", "compiled_prompt", "retrieval_query", "context_pack", "eval"],
  );
  assert.equal(timeline.timeline[5]?.refs.contextPackId, "pack-1");
  assert.equal(timeline.timeline[4]?.summary.includes("profile=profile-1"), true);
  assert.equal(timeline.timeline[5]?.summary.includes("messages=0"), true);
  assert.equal(timeline.counts.retrievalQueries, 1);
});

test("timeline builder handles empty data", () => {
  const timeline = buildSessionTimeline({
    session,
  });

  assert.equal(timeline.timeline.length, 0);
  assert.deepEqual(timeline.counts, {
    messages: 0,
    events: 0,
    agentRuns: 0,
    modelCalls: 0,
    compiledPrompts: 0,
    retrievalQueries: 0,
    contextPacks: 0,
    outcomes: 0,
  });
});
