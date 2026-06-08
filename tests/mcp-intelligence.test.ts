import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleMcpRequest } from "../mcp/server/src/tools.ts";
import { resolveConfig } from "../packages/config/src/index.ts";
import { createStore, initializeStore } from "../packages/db/src/store.ts";
import { compilePrompt } from "../packages/prompt-compiler/src/index.ts";

type McpEnvelope = Awaited<ReturnType<typeof handleMcpRequest>>;

async function callTool(
  store: ReturnType<typeof createStore>,
  config: ReturnType<typeof resolveConfig>,
  id: number,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const response = await handleMcpRequest(store, config, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
  if (response?.error) {
    throw new Error(response.error.message);
  }
  const result = response?.result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(result.content[0].text);
}

async function assertRejects(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, pattern);
    return;
  }
  assert.ok(false, `Expected rejection matching ${pattern}`);
}

test("ai_list_memory_candidates returns pending candidates and ai_accept_memory_candidate transitions to entry", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-mcp-mem-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "x.ts"), "export const x = 1;\n");
  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "repo" });
  const candidate = store.memory.createCandidate({
    projectId: project.id,
    kind: "user_preference",
    title: "Use strict mode",
    body: "Always enable strict mode in TypeScript projects.",
    confidence: 0.9,
    scope: "project",
  });
  const config = resolveConfig({
    databasePath: join(workspace, "ai.db"),
    runtimeDir: join(workspace, "runtime"),
    apiUrl: "http://127.0.0.1:4242",
    webPort: 4242,
    apiPort: 4242,
  });

  const listed = (await callTool(store, config, 1, "ai_list_memory_candidates", {
    project: project.id,
    status: "pending",
  })) as Array<{ id: string }>;
  assert.ok(listed.some((c) => c.id === candidate.id));

  const accepted = (await callTool(store, config, 2, "ai_accept_memory_candidate", {
    candidateId: candidate.id,
    notes: "looks right",
  })) as { entry: { id: string }; candidate: { status: string } };
  assert.equal(accepted.candidate.status, "accepted");
  assert.ok(accepted.entry.id);

  const entries = store.memory.listEntries(project.id, undefined, 50);
  assert.ok(entries.some((e) => e.id === accepted.entry.id));

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("ai_get_context_pack returns pack with items and budget events", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-mcp-pack-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "x.ts"), "export const x = 1;\n");
  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "repo" });
  const session = store.createSession({
    projectId: project.id,
    title: "pack",
    userGoal: "build context",
    mode: "local",
    source: "test",
  });
  const pack = store.context.recordPack({
    sessionId: session.id,
    projectId: project.id,
    budgetTokens: 1000,
    usedTokens: 200,
    reason: "test",
    items: [
      {
        kind: "retrieval_chunk",
        rank: 0,
        tokenCount: 100,
        excerpt: "chunk excerpt",
        sourceId: "src/x.ts",
      },
    ],
    budgetEvents: [{ deltaTokens: 100, reason: "test event" }],
  });
  const config = resolveConfig({
    databasePath: join(workspace, "ai.db"),
    runtimeDir: join(workspace, "runtime"),
    apiUrl: "http://127.0.0.1:4242",
    webPort: 4242,
    apiPort: 4242,
  });

  const result = (await callTool(store, config, 1, "ai_get_context_pack", {
    contextPackId: pack.id,
  })) as {
    pack: { id: string };
    items: Array<{ excerpt: string }>;
    budgetEvents: Array<{ reason: string }>;
  };
  assert.equal(result.pack.id, pack.id);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.excerpt, "chunk excerpt");
  assert.equal(result.budgetEvents[0]?.reason, "test event");

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("ai_get_retrieval_query returns query, results, selected context, feedback, and misses", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-mcp-rq-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "x.ts"), "export const x = 1;\n");
  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "repo" });
  const session = store.createSession({
    projectId: project.id,
    title: "rq",
    userGoal: "test",
    mode: "local",
    source: "test",
  });
  const query = store.retrieval.createQuery({
    sessionId: session.id,
    projectId: project.id,
    originalQuery: "find x",
    intent: "lookup",
    mode: "local",
    depth: "standard",
    analysis: {
      language: "ts",
      terms: ["x"],
      pathHints: [],
      symbolHints: [],
      isLikelyDefinition: false,
      isLikelyDebug: false,
      notes: [],
    },
  });
  store.retrieval.recordMiss({
    retrievalQueryId: query.id,
    missedPath: "src/missing.ts",
    confidence: 0.1,
  });
  store.retrieval.recordFeedback({
    retrievalQueryId: query.id,
    chunkId: null,
    rating: "missed",
    missedPath: "src/missing.ts",
    notes: "not indexed",
  });
  const config = resolveConfig({
    databasePath: join(workspace, "ai.db"),
    runtimeDir: join(workspace, "runtime"),
    apiUrl: "http://127.0.0.1:4242",
    webPort: 4242,
    apiPort: 4242,
  });

  const result = (await callTool(store, config, 1, "ai_get_retrieval_query", {
    retrievalQueryId: query.id,
  })) as {
    query: { id: string };
    results: unknown[];
    selectedContext: unknown[];
    feedback: Array<{ missedPath: string | null }>;
    misses: Array<{ missedPath: string }>;
  };
  assert.equal(result.query.id, query.id);
  assert.equal(result.misses.length, 1);
  assert.equal(result.misses[0]?.missedPath, "src/missing.ts");
  assert.equal(result.feedback[0]?.missedPath, "src/missing.ts");

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("ai_record_feedback records good/bad ratings on chunks and updates chunk_path_boosts", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-mcp-feedback-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "alpha.ts"), "export const alpha = 1;\n");
  await writeFile(join(repo, "src", "beta.ts"), "export const beta = 2;\n");
  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "repo" });
  const session = store.createSession({
    projectId: project.id,
    title: "feedback",
    userGoal: "test record_feedback wiring",
    mode: "local",
    source: "test",
  });
  await store.indexProject(project.id);
  const query = store.retrieval.createQuery({
    sessionId: session.id,
    projectId: project.id,
    originalQuery: "alpha",
    mode: "local",
    depth: "standard",
    intent: "lookup",
    analysis: {
      language: "ts",
      terms: ["alpha"],
      pathHints: ["src/alpha"],
      symbolHints: ["alpha"],
      isLikelyDefinition: true,
      isLikelyDebug: false,
      notes: [],
    },
  });
  const projectFiles = store.listProjectFiles(project.id, 100);
  const file1 = projectFiles.find((f) => f.path === "src/alpha.ts");
  const file2 = projectFiles.find((f) => f.path === "src/beta.ts");
  assert.ok(file1);
  assert.ok(file2);
  const alphaChunk = store.db
    .prepare(
      "SELECT c.id AS id FROM rag_chunks c JOIN rag_documents d ON d.id = c.document_id WHERE c.project_id = ? AND d.path = ? LIMIT 1"
    )
    .get(project.id, "src/alpha.ts") as { id: string };
  const betaChunk = store.db
    .prepare(
      "SELECT c.id AS id FROM rag_chunks c JOIN rag_documents d ON d.id = c.document_id WHERE c.project_id = ? AND d.path = ? LIMIT 1"
    )
    .get(project.id, "src/beta.ts") as { id: string };
  const config = resolveConfig({
    databasePath: join(workspace, "ai.db"),
    runtimeDir: join(workspace, "runtime"),
    apiUrl: "http://127.0.0.1:4242",
    webPort: 4242,
    apiPort: 4242,
  });

  const goodResult = (await callTool(store, config, 1, "ai_record_feedback", {
    retrievalQueryId: query.id,
    chunkId: alphaChunk.id,
    rating: "good",
    notes: "relevant",
  })) as { feedback: { rating: string }; pathBoost: { path: string; weight: number } | null };
  assert.equal(goodResult.feedback.rating, "good");
  assert.ok(goodResult.pathBoost);
  assert.equal(goodResult.pathBoost!.path, "src/alpha.ts");
  assert.ok(goodResult.pathBoost!.weight > 0.5, "good feedback should push weight above neutral");

  const badResult = (await callTool(store, config, 2, "ai_record_feedback", {
    retrievalQueryId: query.id,
    chunkId: betaChunk.id,
    rating: "bad",
    notes: "irrelevant",
  })) as { feedback: { rating: string }; pathBoost: { path: string; weight: number } | null };
  assert.equal(badResult.feedback.rating, "bad");
  assert.ok(badResult.pathBoost);
  assert.equal(badResult.pathBoost!.path, "src/beta.ts");
  assert.ok(badResult.pathBoost!.weight < 0.5, "bad feedback should push weight below neutral");
  assert.ok(goodResult.pathBoost!.weight > badResult.pathBoost!.weight);

  const missResult = (await callTool(store, config, 3, "ai_record_feedback", {
    retrievalQueryId: query.id,
    rating: "missed",
    missedPath: "src/gamma.ts",
    notes: "not retrieved",
  })) as {
    feedback: { rating: string; missedPath: string | null };
    pathBoost: { path: string; weight: number } | null;
  };
  assert.equal(missResult.feedback.rating, "missed");
  assert.equal(missResult.feedback.missedPath, "src/gamma.ts");
  assert.ok(missResult.pathBoost);
  assert.equal(missResult.pathBoost!.path, "src/gamma.ts");

  const pathFeedback = store.retrieval.listPathFeedback(project.id, 50);
  assert.equal(pathFeedback.length, 3);

  const boosts = store.retrieval.listPathBoosts(project.id, 50);
  assert.equal(boosts.length, 3);

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("ai_reflect_session enqueues a session.reflect worker job and emits a session.reflected event", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-mcp-reflect-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "x.ts"), "export const x = 1;\n");
  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "repo" });
  const session = store.createSession({
    projectId: project.id,
    title: "reflect",
    userGoal: "test reflect enqueue",
    mode: "local",
    source: "test",
  });
  const config = resolveConfig({
    databasePath: join(workspace, "ai.db"),
    runtimeDir: join(workspace, "runtime"),
    apiUrl: "http://127.0.0.1:4242",
    webPort: 4242,
    apiPort: 4242,
  });

  const result = (await callTool(store, config, 1, "ai_reflect_session", {
    sessionId: session.id,
  })) as {
    queued: boolean;
    jobId: string;
    sessionId: string;
    note: string;
  };
  assert.equal(result.queued, true);
  assert.equal(result.sessionId, session.id);
  assert.ok(result.jobId, "should return a job id");
  assert.ok(result.note.includes("queued"));

  const queued = store.db.prepare("SELECT * FROM jobs WHERE id = ?").get(result.jobId) as
    | { id: string; type: string; status: string; payload_json: string }
    | undefined;
  assert.ok(queued);
  assert.equal(queued!.type, "session.reflect");
  assert.equal(queued!.status, "queued");
  const payload = JSON.parse(queued!.payload_json) as { sessionId: string; source: string };
  assert.equal(payload.sessionId, session.id);
  assert.equal(payload.source, "mcp");

  const events = store.listEvents();
  const reflected = events.find((e) => e.type === "session.reflected");
  assert.ok(reflected, "should emit a session.reflected event");
  const eventPayload = reflected!.payload as { queuedJobId: string; source: string };
  assert.equal(eventPayload.queuedJobId, result.jobId);
  assert.equal(eventPayload.source, "mcp");

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("ai_reflect_session rejects unknown sessions", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-mcp-reflect-bad-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "x.ts"), "export const x = 1;\n");
  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "repo" });
  const config = resolveConfig({
    databasePath: join(workspace, "ai.db"),
    runtimeDir: join(workspace, "runtime"),
    apiUrl: "http://127.0.0.1:4242",
    webPort: 4242,
    apiPort: 4242,
  });

  await assertRejects(
    () => callTool(store, config, 1, "ai_reflect_session", { sessionId: "nope" }),
    /Unknown session/
  );
  const reflectedForUnknown = store.listEvents().find((e) => e.type === "session.reflected");
  assert.equal(
    reflectedForUnknown,
    undefined,
    "should not emit session.reflected for unknown sessions"
  );

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("ai_record_feedback rejects bad inputs", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-mcp-feedback-validate-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "x.ts"), "export const x = 1;\n");
  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "repo" });
  const session = store.createSession({
    projectId: project.id,
    title: "validate",
    userGoal: "validate feedback inputs",
    mode: "local",
    source: "test",
  });
  const query = store.retrieval.createQuery({
    sessionId: session.id,
    projectId: project.id,
    originalQuery: "x",
    mode: "local",
    depth: "standard",
    intent: "lookup",
    analysis: {
      language: "ts",
      terms: ["x"],
      pathHints: ["src/x"],
      symbolHints: ["x"],
      isLikelyDefinition: true,
      isLikelyDebug: false,
      notes: [],
    },
  });
  const config = resolveConfig({
    databasePath: join(workspace, "ai.db"),
    runtimeDir: join(workspace, "runtime"),
    apiUrl: "http://127.0.0.1:4242",
    webPort: 4242,
    apiPort: 4242,
  });

  await assertRejects(
    () =>
      callTool(store, config, 1, "ai_record_feedback", {
        retrievalQueryId: query.id,
        rating: "good",
      }),
    /require a chunkId/
  );
  await assertRejects(
    () =>
      callTool(store, config, 2, "ai_record_feedback", {
        retrievalQueryId: query.id,
        rating: "missed",
      }),
    /requires a missedPath/
  );
  await assertRejects(
    () =>
      callTool(store, config, 3, "ai_record_feedback", {
        retrievalQueryId: query.id,
        rating: "weird",
      }),
    /Invalid rating/
  );
  await assertRejects(
    () =>
      callTool(store, config, 4, "ai_record_feedback", {
        retrievalQueryId: "nope",
        rating: "good",
        chunkId: "x",
      }),
    /Unknown retrieval query/
  );

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("ai_reject_memory_candidate transitions a pending candidate to rejected", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-mcp-reject-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "x.ts"), "export const x = 1;\n");
  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "repo" });
  const candidate = store.memory.createCandidate({
    projectId: project.id,
    kind: "user_preference",
    title: "bad",
    body: "this preference is wrong",
    confidence: 0.4,
    scope: "project",
  });
  const config = resolveConfig({
    databasePath: join(workspace, "ai.db"),
    runtimeDir: join(workspace, "runtime"),
    apiUrl: "http://127.0.0.1:4242",
    webPort: 4242,
    apiPort: 4242,
  });

  const result = (await callTool(store, config, 1, "ai_reject_memory_candidate", {
    candidateId: candidate.id,
    reason: "low confidence",
  })) as { candidate: { id: string; status: string } };
  assert.equal(result.candidate.id, candidate.id);
  assert.equal(result.candidate.status, "rejected");

  const entries = store.memory.listEntries(project.id, undefined, 50);
  assert.equal(entries.length, 0, "rejected candidate should not create a memory entry");

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("ai_accept_skill_candidate transitions a pending skill to active", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-mcp-skill-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "x.ts"), "export const x = 1;\n");
  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "repo" });
  const candidate = store.skills.createCandidate({
    projectId: project.id,
    title: "Run typecheck",
    triggerTerms: ["typecheck"],
    applicableProjects: [project.id],
    steps: ["pnpm tsc --noEmit"],
    requiredContext: ["node"],
    commands: ["pnpm tsc --noEmit"],
    safetyNotes: "local-only",
    validation: ["exit code 0"],
    confidence: 0.9,
  });
  const config = resolveConfig({
    databasePath: join(workspace, "ai.db"),
    runtimeDir: join(workspace, "runtime"),
    apiUrl: "http://127.0.0.1:4242",
    webPort: 4242,
    apiPort: 4242,
  });

  const result = (await callTool(store, config, 1, "ai_accept_skill_candidate", {
    candidateId: candidate.id,
  })) as { skill: { id: string; status: string }; candidate: { status: string } };
  assert.equal(result.candidate.status, "active");
  assert.ok(result.skill.id);

  const skills = store.skills.listSkills("active", 50);
  assert.ok(skills.some((s) => s.id === result.skill.id));

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("ai_get_model_calls filters by session and role", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-mcp-calls-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "x.ts"), "export const x = 1;\n");
  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "repo" });
  const session = store.createSession({
    projectId: project.id,
    title: "calls",
    userGoal: "trace",
    mode: "local",
    source: "test",
  });
  store.models.recordCall({
    sessionId: session.id,
    profileId: "ask-fast-local",
    role: "answer",
    promptTokens: 10,
    completionTokens: 5,
    latencyMs: 1,
    status: "ok",
    request: { prompt: "hi" },
    response: { text: "hello" },
  });
  store.models.recordCall({
    sessionId: session.id,
    profileId: "query-rewrite-local",
    role: "query_rewrite",
    promptTokens: 5,
    completionTokens: 5,
    latencyMs: 1,
    status: "ok",
    request: { prompt: "hi" },
    response: { text: "hello" },
  });
  const config = resolveConfig({
    databasePath: join(workspace, "ai.db"),
    runtimeDir: join(workspace, "runtime"),
    apiUrl: "http://127.0.0.1:4242",
    webPort: 4242,
    apiPort: 4242,
  });

  const all = (await callTool(store, config, 1, "ai_get_model_calls", {
    sessionId: session.id,
  })) as Array<{ role: string }>;
  assert.equal(all.length, 2);

  const onlyRewrite = (await callTool(store, config, 2, "ai_get_model_calls", {
    sessionId: session.id,
    role: "query_rewrite",
  })) as Array<{ role: string }>;
  assert.equal(onlyRewrite.length, 1);
  assert.equal(onlyRewrite[0]?.role, "query_rewrite");

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("ai_get_session_trace returns full replayable trace", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-mcp-trace-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "x.ts"), "export const x = 1;\n");
  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "repo" });
  const session = store.createSession({
    projectId: project.id,
    title: "trace",
    userGoal: "trace",
    mode: "local",
    source: "test",
  });
  store.conversation.appendMessage({ sessionId: session.id, role: "user", content: "hi" });
  store.retrieval.createQuery({
    sessionId: session.id,
    projectId: project.id,
    originalQuery: "find x",
    intent: "lookup",
    mode: "local",
    depth: "standard",
    analysis: {
      language: "ts",
      terms: ["x"],
      pathHints: [],
      symbolHints: [],
      isLikelyDefinition: false,
      isLikelyDebug: false,
      notes: [],
    },
  });
  store.context.recordPack({
    sessionId: session.id,
    projectId: project.id,
    budgetTokens: 1000,
    usedTokens: 50,
    reason: "test",
    items: [
      { kind: "retrieval_chunk", rank: 0, tokenCount: 50, excerpt: "x", sourceId: "src/x.ts" },
    ],
  });
  const compiledPrompt = compilePrompt({
    mode: "answer",
    role: "answer",
    userRequest: "trace prompt",
  });
  store.recordCompiledPrompt({
    compiledPrompt,
    sessionId: session.id,
  });
  const config = resolveConfig({
    databasePath: join(workspace, "ai.db"),
    runtimeDir: join(workspace, "runtime"),
    apiUrl: "http://127.0.0.1:4242",
    webPort: 4242,
    apiPort: 4242,
  });

  const result = (await callTool(store, config, 1, "ai_get_session_trace", {
    sessionId: session.id,
  })) as {
    session: { id: string };
    conversation: Array<{ content: string }>;
    retrievals: Array<{ query: { id: string } }>;
    contextPacks: Array<{ pack: { id: string } }>;
    modelCalls: unknown[];
    memoryCandidates: unknown[];
    facts: unknown[];
    rules: unknown[];
    skills: unknown[];
    checks: unknown[];
    compiledPrompts: Array<{ id: string; mode: string }>;
    events: Array<{ type: string }>;
  };
  assert.equal(result.session.id, session.id);
  assert.equal(result.conversation.length, 1);
  assert.equal(result.retrievals.length, 1);
  assert.equal(result.contextPacks.length, 1);
  assert.ok(Array.isArray(result.modelCalls));
  assert.ok(Array.isArray(result.memoryCandidates));
  assert.ok(Array.isArray(result.facts));
  assert.ok(Array.isArray(result.rules));
  assert.ok(Array.isArray(result.skills));
  assert.ok(Array.isArray(result.checks));
  assert.ok(Array.isArray(result.compiledPrompts));
  assert.equal(result.compiledPrompts[0]?.mode, "answer");
  assert.ok(Array.isArray(result.events));

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});
