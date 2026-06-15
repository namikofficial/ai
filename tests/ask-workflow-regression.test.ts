import assert from "node:assert/strict";
import test from "node:test";
import { type AskWorkflowStore, runAskWorkflow } from "../packages/ask-engine/src/index.ts";
import { createId, type EventEnvelope, type RetrievalChunk } from "../packages/shared/src/index.ts";

function createMockStore(): AskWorkflowStore & { events: EventEnvelope[] } {
  const events: EventEnvelope[] = [];
  const calls: any[] = [];
  const sessions = new Map<string, any>();
  const messages: any[] = [];
  const prompts = new Map<string, any>();
  const retrievalQueries = new Map<string, any>();
  const contextPacks = new Map<string, any>();
  const agentRuns = new Map<string, any>();

  return {
    events,
    getProject: (id) => ({
      id,
      name: id,
      path: `/projects/${id}`,
      status: "ready",
      fileCount: 10,
      chunkCount: 100,
      indexedFileCount: 10,
      dirty: false,
      health: "healthy",
      repoUrl: null,
      lastIndexedAt: null,
      createdAt: "",
      updatedAt: "",
      branch: "main",
      language: "typescript",
      framework: "node",
    }),
    getSession: (id) => sessions.get(id) ?? null,
    searchChunks: (projectId: string, query: string) => {
      if (query.includes("missing?") || (query === "" && messages[messages.length - 1]?.content === "missing?")) {
        return [];
      }
      return [
        {
          id: "c1",
          path: "f1.ts",
          content: "stuff",
          startLine: 1,
          endLine: 1,
          tokenCount: 1,
          projectId: "p1",
          documentId: "d1",
          score: 1,
          metadata: {},
        },
      ];
    },
    searchChunksWithVector: () => [],
    listProjectFiles: () => [],
    createSession: (input) => {
      const s = {
        id: createId("s"),
        ...input,
        status: "active",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        durationMs: null,
        activeTaskId: null,
        finalSummary: null,
        outcome: null,
        createdAt: "",
        updatedAt: "",
      };
      sessions.set(s.id, s);
      return s as any;
    },
    updateSession: (id, patch) => {
      const s = { ...sessions.get(id), ...patch };
      sessions.set(id, s);
      return s as any;
    },
    createLesson: () => ({ id: "l1" }) as any,
    appendEvent: (e) => {
      events.push(e as any);
      return e as any;
    },
    recordCompiledPrompt: (input) => {
      const p = { id: input.compiledPrompt.id, ...input };
      prompts.set(p.id, p);
      return p as any;
    },
    conversation: {
      appendMessage: (input) => {
        const m = {
          id: createId("m"),
          ...input,
          contentHash: "",
          metaJson: null,
          createdAt: new Date().toISOString(),
        };
        messages.push(m);
        return m as any;
      },
      listMessages: () => messages as any,
    },
    retrieval: {
      createQuery: (input) => {
        const q = { id: createId("rq"), ...input, createdAt: "" };
        retrievalQueries.set(q.id, q);
        return q as any;
      },
      updateRewrittenQuery: () => {},
      createRewrite: () => {},
      recordResults: () => {},
      recordSelectedContext: () => {},
      recordMiss: () => {},
      listQueriesForSession: () => Array.from(retrievalQueries.values()) as any,
      listQueriesForProject: () => [],
      listPathBoosts: () => [],
      listResults: () => [],
      listSelectedContext: () => [],
      listFeedback: () => [],
      listMisses: () => [],
    },
    context: {
      recordPack: (input) => {
        const p = { id: createId("cp"), ...input, createdAt: "" };
        contextPacks.set(p.id, p);
        return p as any;
      },
      listPacksForSession: () => Array.from(contextPacks.values()) as any,
      listItems: () => [],
      listBudgetEvents: () => [],
    },
    memory: {
      listEntries: () => [],
      listFacts: () => [],
      listProjectRules: () => [],
    },
    skills: {
      listSkills: () => [],
    },
    models: {
      getProfile: (id) =>
        ({
          id,
          modelName: id,
          maxOutputTokens: 1024,
          providerId: "p1",
          role: "answer",
          displayName: id,
          contextWindow: 4096,
          inputTokenCost: 0,
          outputTokenCost: 0,
          latencyMs: 0,
          status: "ok",
          createdAt: "",
          updatedAt: "",
        }) as any,
      listCalls: () => calls,
      recordCall: (input) => {
        const c = { id: createId("call"), ...input, ts: "", createdAt: "" };
        calls.push(c);
        return c as any;
      },
      recordRoute: (input) => ({ id: "r1", ...input, createdAt: "" }) as any,
    },
    agents: {
      createRun: (input) => {
        const r = { id: createId("run"), ...input };
        agentRuns.set(r.id, r);
        return r as any;
      },
      appendMessage: () => {},
      updateRun: () => {},
    },
    evals: {
      recordAnswerEvaluation: () => {},
      recordSessionOutcome: () => {},
    },
    invokeModel: async (profileId, request) => {
      const call = {
        id: createId("call"),
        profileId,
        role: request.role,
        status: "ok",
        request: request as any,
        response: { text: "mock response" },
      };
      calls.push(call);
      return {
        text: "mock response",
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        promptTokens: 10,
        completionTokens: 10,
        latencyMs: 100,
      };
    },
    enqueueJob: () => ({ id: "j1" }) as any,
    listEvents: () => events,
  };
}

test("runAskWorkflow: successful ask creates all expected records", async () => {
  const store = createMockStore();
  const runtime: any = {
    route: async () => ({
      profileId: "gpt-4",
      reason: "test",
      blocked: false,
      fallbackProfileId: null,
    }),
    invoke: async () => ({}) as any,
    embed: async () => ({ embeddings: [[0.1, 0.2]], usage: { promptTokens: 1, totalTokens: 1 } }),
  };

  const response = await runAskWorkflow({
    store,
    runtime,
    cloudEnabled: true,
    input: { project: "test-project", question: "how does it work?" },
  });

  assert.ok(response.sessionId);
  assert.equal(response.answer.includes("mock response"), true);

  // Verify session
  const session = store.getSession(response.sessionId);
  assert.ok(session);
  if (session) {
    assert.equal(session.status, "completed");
  }

  // Verify messages
  const msgs = store.conversation.listMessages(response.sessionId);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, "user");
  assert.equal(msgs[1].role, "assistant");

  // Verify retrieval query
  const queries = store.retrieval.listQueriesForSession(response.sessionId);
  assert.equal(queries.length, 1);

  // Verify context pack
  const packs = store.context.listPacksForSession(response.sessionId);
  assert.equal(packs.length, 1);

  // Verify events
  const eventTypes = store.events.map((e) => e.type);
  assert.ok(eventTypes.includes("model.called"));
  assert.ok(eventTypes.includes("model.completed"));
  assert.ok(eventTypes.includes("retrieval.started"));
  assert.ok(eventTypes.includes("retrieval.completed"));
  assert.ok(eventTypes.includes("session.completed"));
});

test("runAskWorkflow: handles retrieval miss (no chunks)", async () => {
  const store = createMockStore();
  const runtime: any = {
    route: async () => ({
      profileId: "gpt-4",
      reason: "test",
      blocked: false,
      fallbackProfileId: null,
    }),
    invoke: async () => ({}) as any,
    embed: async () => ({ embeddings: [[0.1, 0.2]], usage: { promptTokens: 1, totalTokens: 1 } }),
  };

  const response = await runAskWorkflow({
    store,
    runtime,
    cloudEnabled: true,
    input: { project: "test-project", question: "missing?" },
  });

  assert.ok(response.answer.includes("I could not find enough local context"));
  assert.equal(response.retrievedChunks.length, 0);

  const eventTypes = store.events.map((e) => e.type);
  assert.ok(eventTypes.includes("answer.fallback"));
  // Should NOT emit model.completed for answer if it skipped it
  const answerCalls = store.events.filter((e) => e.type === "model.completed" && e.payload.role === "answer");
  assert.equal(answerCalls.length, 0);
});

test("runAskWorkflow: handles answer model failure", async () => {
  const store = createMockStore();
  // Override searchChunks to return something so we don't hit fallback
  store.searchChunks = (projectId: string, query: string) => [
    {
      id: "c1",
      path: "f1.ts",
      content: "stuff",
      startLine: 1,
      endLine: 1,
      tokenCount: 1,
      projectId: "p1",
      documentId: "d1",
      score: 1,
      metadata: {},
    },
  ];

  const runtime: any = {
    route: async () => ({
      profileId: "gpt-4",
      reason: "test",
      blocked: false,
      fallbackProfileId: null,
    }),
    invoke: async () => ({}) as any,
    embed: async () => ({ embeddings: [[0.1, 0.2]], usage: { promptTokens: 1, totalTokens: 1 } }),
  };

  // Mock model failure for answer
  store.invokeModel = async (profileId, request) => {
    if (request.role === "answer") {
      throw new Error("model timeout");
    }
    return {
      text: "ok",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 10,
    };
  };

  const response = await runAskWorkflow({
    store,
    runtime,
    cloudEnabled: true,
    input: { project: "test-project", question: "fail?" },
  });

  assert.ok(response.answer.includes("I could not synthesize a model answer"));

  const eventTypes = store.events.map((e) => e.type);
  assert.ok(eventTypes.includes("model.failed"));
  const answerCompleted = store.events.filter((e) => e.type === "model.completed" && e.payload.role === "answer");
  assert.equal(answerCompleted.length, 0);
});

test("runAskWorkflow: handles query rewrite failure", async () => {
  const store = createMockStore();
  const runtime: any = {
    route: async () => ({
      profileId: "gpt-4",
      reason: "test",
      blocked: false,
      fallbackProfileId: null,
    }),
    invoke: async () => ({}) as any,
    embed: async () => ({ embeddings: [[0.1, 0.2]], usage: { promptTokens: 1, totalTokens: 1 } }),
  };

  store.invokeModel = async (profileId, request) => {
    if (request.role === "query_rewrite") {
      throw new Error("rewrite fail");
    }
    return {
      text: "ok",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 10,
    };
  };

  const response = await runAskWorkflow({
    store,
    runtime,
    cloudEnabled: true,
    input: { project: "test-project", question: "rewrite fail?" },
  });

  assert.ok(response.sessionId);
  const eventTypes = store.events.map((e) => e.type);
  assert.ok(eventTypes.includes("model.failed"));
  // Ask still completes
  assert.equal(store.getSession(response.sessionId)?.status, "completed");
});

test("runAskWorkflow: handles retrieval judge failure", async () => {
  const store = createMockStore();
  const runtime: any = {
    route: async () => ({
      profileId: "gpt-4",
      reason: "test",
      blocked: false,
      fallbackProfileId: null,
    }),
    invoke: async () => ({}) as any,
    embed: async () => ({ embeddings: [[0.1, 0.2]], usage: { promptTokens: 1, totalTokens: 1 } }),
  };

  store.invokeModel = async (profileId, request) => {
    if (request.role === "retrieval_judge") {
      throw new Error("judge fail");
    }
    return {
      text: "ok",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 10,
    };
  };

  const response = await runAskWorkflow({
    store,
    runtime,
    cloudEnabled: true,
    input: { project: "test-project", question: "judge fail?" },
  });

  assert.ok(response.sessionId);
  const eventTypes = store.events.map((e) => e.type);
  assert.ok(eventTypes.includes("model.failed"));
  // Ask still completes
  assert.equal(store.getSession(response.sessionId)?.status, "completed");
});
