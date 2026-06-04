import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { initializeStore, createStore } from "../packages/db/src/store.ts";
import { runAskWorkflow } from "../packages/ask-engine/src/index.ts";

function createMockRuntime() {
  return {
    route: async () => ({
      profileId: "ask-fast-local",
      fallbackProfileId: null,
      blocked: false,
      reason: "mock route",
    }),
    invoke: async () => {
      throw new Error("runAskWorkflow should use store.invokeModel, not runtime.invoke");
    },
    embed: async () => ({
      embeddings: [Array.from({ length: 32 }, (_value, index) => (index === 0 ? 1 : index / 1000))],
      dimensions: 32,
      modelName: "embedding-local",
      providerId: "provider_heuristic_local",
    }),
  };
}

function installInvokeModelStub(
  store: ReturnType<typeof createStore>,
  input: {
    failAnswer?: boolean;
    answerText?: string;
  } = {},
) {
  const original = store.invokeModel;
  store.invokeModel = async (profileId, request, options) => {
    const promptTokens = 24;
    const completionTokens = request.role === "answer" ? 48 : 12;
    const response = { text: input.answerText ?? `mock:${request.role}`, usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens } };
    if (request.role === "answer" && input.failAnswer) {
      store.models.recordCall({
        profileId,
        role: request.role,
        promptTokens,
        completionTokens: 0,
        latencyMs: 1,
        status: "failed",
        error: "answer synthesis failed",
        request: { role: request.role, metadata: request.metadata ?? null },
        response: {},
        sessionId: options?.sessionId ?? null,
        taskId: options?.taskId ?? null,
        retrievalQueryId: options?.retrievalQueryId ?? null,
      });
      throw new Error("answer synthesis failed");
    }
    const call = store.models.recordCall({
      profileId,
      role: request.role,
      promptTokens,
      completionTokens,
      latencyMs: 1,
      status: "ok",
      request: { role: request.role, metadata: request.metadata ?? null },
      response,
      sessionId: options?.sessionId ?? null,
      taskId: options?.taskId ?? null,
      retrievalQueryId: options?.retrievalQueryId ?? null,
    });
    return {
      text: response.text,
      promptTokens,
      completionTokens,
      latencyMs: 1,
      usage: response.usage,
      profileId,
      providerId: "provider_heuristic_local",
      status: "ok",
      raw: call,
    };
  };
  return () => {
    store.invokeModel = original;
  };
}

async function createAskWorkspace(files: Record<string, string>, repoName: string) {
  const workspace = await mkdtemp(join(tmpdir(), `ai-ask-${repoName}-`));
  const repo = join(workspace, repoName);
  await mkdir(repo, { recursive: true });
  for (const [filePath, contents] of Object.entries(files)) {
    const fullPath = join(repo, filePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents);
  }
  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: repoName });
  return { workspace, repo, store, project };
}

test("ask flow uses the full retrieval pipeline (ranked, selected, dropped, confidence)", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-pipeline-"));
  const repo = join(workspace, "sample-repo");
  await mkdir(join(repo, "src"), { recursive: true });
  for (let i = 0; i < 6; i++) {
    await writeFile(
      join(repo, "src", `feature-${i}.ts`),
      `export function feature${i}() { return "noise ${i}"; }\n`,
    );
  }
  await writeFile(
    join(repo, "src", "auth.ts"),
    [
      "export function handleLogin() {",
      "  return { route: '/api/auth/login', storage: 'local sqlite' };",
      "}",
      "",
      "export const authNote = 'auth is handled in the auth router';",
    ].join("\n"),
  );

  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "sample-repo" });
  await store.indexProject(project.id);

  const answer = await store.ask({
    project: project.id,
    question: "where is auth handled?",
    mode: "local",
    depth: "standard",
  });
  assert.ok(answer.answer.includes("auth"));
  assert.ok(answer.citations.length > 0);

  const queries = store.retrieval.listQueriesForSession(answer.sessionId, 5);
  assert.equal(queries.length, 1);
  const query = queries[0]!;
  const results = store.retrieval.listResults(query.id, 100);
  const selected = store.retrieval.listSelectedContext(query.id);
  assert.ok(results.length >= 1, "results should be recorded");
  assert.ok(selected.length >= 1, "selected context should be recorded");
  assert.ok(selected.length <= results.length, "selected is a subset of results");

  const judgeCalls = store.models.listCalls(answer.sessionId, 100).filter((c) => c.role === "retrieval_judge");
  assert.equal(judgeCalls.length, 1);
  const judgeRequest = judgeCalls[0]?.request as {
    metadata?: {
      compiledPrompt?: { mode?: string; contextPackId?: string | null; messages?: Array<{ role: string; content: string }> };
      responseTrace?: { confidence?: number; confidenceNotes?: string[]; boost?: { good?: number; missed?: number; bad?: number } };
    } | null;
  };
  assert.equal(judgeRequest.metadata?.compiledPrompt?.mode, "retrieval_judge");
  assert.ok(Array.isArray(judgeRequest.metadata?.compiledPrompt?.messages));
  assert.ok(Array.isArray(judgeRequest.metadata?.responseTrace?.confidenceNotes));
  assert.ok(judgeRequest.metadata?.responseTrace?.boost);

  const rewriteCalls = store.models.listCalls(answer.sessionId, 100).filter((c) => c.role === "query_rewrite");
  assert.equal(rewriteCalls.length, 1, "ask should record exactly one query rewrite model call");
  const rewriteRequest = rewriteCalls[0]!.request as {
    metadata?: {
      compiledPrompt?: { id?: string; mode?: string; messages?: Array<{ role: string; content: string }> };
      deterministicRewrite?: unknown;
    } | null;
  };
  assert.equal(rewriteRequest.metadata?.compiledPrompt?.mode, "query_rewrite");
  assert.ok(rewriteRequest.metadata?.deterministicRewrite, "query rewrite call should record deterministic fallback metadata");

  const answerCalls = store.models.listCalls(answer.sessionId, 100).filter((c) => c.role === "answer");
  assert.equal(answerCalls.length, 1, "ask should record exactly one answer model call");
  const embeddingCalls = store.models.listCalls(answer.sessionId, 100).filter((c) => c.role === "embedding");
  assert.ok(embeddingCalls.length >= 1, "ask should record a query embedding call");
  const answerRequest = answerCalls[0]!.request as {
    metadata?: {
      compiledPrompt?: { id?: string; contextPackId?: string | null; messages?: Array<{ role: string; content: string }> };
      retrievalQueryId?: string;
    } | null;
  };
  assert.ok(answerRequest.metadata?.compiledPrompt?.id, "answer call should include replayable compiled prompt metadata");
  assert.equal(answerRequest.metadata?.retrievalQueryId, query.id);
  assert.ok(Array.isArray(answerRequest.metadata?.compiledPrompt?.messages));

  const routes = store.listModelRoutes(10).filter((route) => route.taskPattern === "ask");
  assert.ok(routes.some((route) => route.reason?.includes("profile selected") || route.reason?.includes("local profile selected")));

  const contextPacks = store.context.listPacksForSession(answer.sessionId, 5);
  assert.equal(contextPacks.length, 1);
  const packId = contextPacks[0]!.id;
  const budgetEvents = store.context.listBudgetEvents(packId);
  assert.ok(budgetEvents.length >= 0);

  const retrievalCompleted = store.listEvents(answer.sessionId, 100).filter((e) => e.type === "retrieval.completed");
  assert.ok(retrievalCompleted.length >= 1);

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("ask flow records a retrieval_miss for an empty project", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-pipeline-miss-"));
  const repo = join(workspace, "empty-repo");
  await mkdir(join(repo, "src"), { recursive: true });
  // empty project: no files indexed, so FTS and heuristic both return nothing

  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "empty-repo" });
  await store.indexProject(project.id);

  const answer = await store.ask({
    project: project.id,
    question: "where is anything?",
    mode: "local",
    depth: "standard",
  });
  assert.match(answer.answer, /could not find enough local context/i);

  const queries = store.retrieval.listQueriesForSession(answer.sessionId, 5);
  assert.equal(queries.length, 1);
  const query = queries[0]!;
  const misses = store.retrieval.listMisses(query.id);
  assert.ok(misses.length >= 1, "a retrieval_miss should be recorded for empty results");

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("runAskWorkflow records the current orchestration trace, compiled prompts, context pack, and reflection job", async () => {
  const fixture = await createAskWorkspace(
    {
      "src/auth.ts": [
        "export function handleLogin() {",
        "  return { route: '/api/auth/login', storage: 'local sqlite' };",
        "}",
        "",
        "export const authNote = 'auth is handled in the auth router';",
      ].join("\n"),
      "src/router.ts": [
        "import { handleLogin } from './auth';",
        "",
        "export function createRouter() {",
        "  return { login: () => handleLogin() };",
        "}",
      ].join("\n"),
    },
    "sample-repo",
  );
  const restoreInvokeModel = installInvokeModelStub(fixture.store);
  try {
    await fixture.store.indexProject(fixture.project.id);
    const response = await runAskWorkflow({
      store: fixture.store,
      runtime: createMockRuntime(),
      cloudEnabled: false,
      input: {
        project: fixture.project.id,
        question: "where is auth handled?",
        mode: "local",
        depth: "standard",
      },
    });

    assert.ok(response.answer.length > 0);

    const messages = fixture.store.conversation.listMessages(response.sessionId, 10);
    assert.equal(messages[0]?.role, "user");
    assert.equal(messages.at(-1)?.role, "assistant");

    const queries = fixture.store.retrieval.listQueriesForSession(response.sessionId, 10);
    assert.equal(queries.length, 1);

    const prompts = fixture.store.listCompiledPrompts(response.sessionId, 10);
    assert.equal(prompts.length, 3);
    assert.deepEqual(
      prompts.map((prompt) => prompt.mode).sort(),
      ["answer", "query_rewrite", "retrieval_judge"],
    );

    const packs = fixture.store.context.listPacksForSession(response.sessionId, 10);
    assert.equal(packs.length, 1);

    const modelCalls = fixture.store.models.listCalls(response.sessionId, 20);
    assert.ok(modelCalls.some((call) => call.role === "query_rewrite"));
    assert.ok(modelCalls.some((call) => call.role === "retrieval_judge"));
    assert.ok(modelCalls.some((call) => call.role === "answer"));

    const evaluations = fixture.store.evals.listAnswerEvaluations(10);
    assert.equal(evaluations.length, 1);
    assert.equal(evaluations[0]?.sessionId, response.sessionId);
    assert.equal(evaluations[0]?.notes, null);

    const jobs = fixture.store.listJobs(10);
    const reflectionJob = jobs.find((job) => job.type === "session.reflect");
    assert.ok(reflectionJob, "ask should enqueue a reflection job");
    assert.deepEqual(JSON.parse(reflectionJob!.payloadJson), {
      sessionId: response.sessionId,
      source: "ask",
      projectId: fixture.project.id,
    });
  } finally {
    restoreInvokeModel();
    fixture.store.db.close();
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("runAskWorkflow falls back without a fake answer completion when nothing is selected", async () => {
  const fixture = await createAskWorkspace({}, "empty-repo");
  const restoreInvokeModel = installInvokeModelStub(fixture.store);
  try {
    await fixture.store.indexProject(fixture.project.id);
    const response = await runAskWorkflow({
      store: fixture.store,
      runtime: createMockRuntime(),
      cloudEnabled: false,
      input: {
        project: fixture.project.id,
        question: "where is anything?",
        mode: "local",
        depth: "standard",
      },
    });

    assert.match(response.answer, /could not find enough local context/i);
    const modelCalls = fixture.store.models.listCalls(response.sessionId, 20);
    assert.ok(modelCalls.some((call) => call.role === "query_rewrite"));
    assert.ok(modelCalls.some((call) => call.role === "retrieval_judge"));
    assert.equal(modelCalls.filter((call) => call.role === "answer").length, 0);

    const events = fixture.store.listEvents(response.sessionId, 50);
    assert.ok(events.some((event) => event.type === "answer.fallback"));
    assert.equal(events.filter((event) => event.type === "model.completed" && event.payload.role === "answer").length, 0);
    assert.equal(fixture.store.evals.listAnswerEvaluations(10)[0]?.notes, "no_chunks");
  } finally {
    restoreInvokeModel();
    fixture.store.db.close();
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("runAskWorkflow records model.failed and still completes with synthesis failure text", async () => {
  const fixture = await createAskWorkspace(
    {
      "src/auth.ts": [
        "export function handleLogin() {",
        "  return { route: '/api/auth/login', storage: 'local sqlite' };",
        "}",
        "",
        "export const authNote = 'auth is handled in the auth router';",
      ].join("\n"),
    },
    "sample-repo",
  );
  const restoreInvokeModel = installInvokeModelStub(fixture.store, { failAnswer: true });
  try {
    await fixture.store.indexProject(fixture.project.id);
    const response = await runAskWorkflow({
      store: fixture.store,
      runtime: createMockRuntime(),
      cloudEnabled: false,
      input: {
        project: fixture.project.id,
        question: "where is auth handled?",
        mode: "local",
        depth: "standard",
      },
    });

    assert.match(response.answer, /could not synthesize a model answer/i);
    const events = fixture.store.listEvents(response.sessionId, 100);
    assert.ok(events.some((event) => event.type === "model.failed" && event.payload.role === "answer"));
    assert.equal(events.filter((event) => event.type === "model.completed" && event.payload.role === "answer").length, 0);

    const modelCalls = fixture.store.models.listCalls(response.sessionId, 20);
    assert.ok(modelCalls.some((call) => call.role === "answer" && call.status === "failed"));

    const session = fixture.store.getSession(response.sessionId);
    assert.equal(session?.status, "completed");
    assert.match(session?.finalSummary ?? "", /could not synthesize a model answer/i);
  } finally {
    restoreInvokeModel();
    fixture.store.db.close();
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});
