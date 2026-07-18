import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { processNextJob } from "../apps/worker/src/worker.ts";
import { createStore, initializeStore } from "../packages/db/src/store.ts";

test("worker session.reflect creates memory candidates from conversation", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-worker-reflect-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "auth.ts"), "export const auth = true;\n");

  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "repo" });
  const session = store.createSession({
    projectId: project.id,
    title: "auth refactor",
    userGoal: "refactor auth and prefer pure functions",
    mode: "local",
    source: "test",
  });

  store.conversation.appendMessage({
    sessionId: session.id,
    role: "user",
    content: "I prefer to always use pure functions and avoid side effects in helpers.",
  });
  store.conversation.appendMessage({
    sessionId: session.id,
    role: "assistant",
    content: "Got it. I'll keep the auth helpers pure and avoid stateful wrappers.",
  });

  store.enqueueJob({
    type: "session.reflect",
    payload: { sessionId: session.id },
  });

  assert.equal(await processNextJob(store), true);

  const job = store.listJobs(10).find((entry) => entry.type === "session.reflect");
  assert.ok(job);
  assert.equal(job?.status, "completed");

  const candidates = store.memory.listCandidates(undefined, project.id, 20);
  assert.ok(candidates.length >= 1, "reflection should produce at least one memory candidate");
  assert.ok(
    candidates.some((c) => /pure function|side effect/i.test(c.body)),
    "candidate body should mention the user preference"
  );

  const reflectedEvent = store.listEvents(session.id, 50).find((e) => e.type === "session.reflected");
  assert.ok(reflectedEvent, "session.reflected event should be appended");
  const reflectedPayload = reflectedEvent?.payload as {
    compiledId?: string;
    modelCallId?: string | null;
  };
  assert.ok(reflectedPayload.compiledId);
  assert.ok(reflectedPayload.modelCallId);

  const reflectionCalls = store.models.listCalls(session.id, 100).filter((call) => call.role === "reflection");
  assert.equal(
    reflectionCalls.length,
    1,
    "session.reflect should record exactly one runtime-backed reflection model call"
  );
  const reflectionRequest = reflectionCalls[0]?.request as {
    metadata?: {
      compiledPrompt?: { mode?: string; messages?: Array<{ role: string; content: string }> };
      responseTrace?: { deterministicReflection?: boolean };
    } | null;
  };
  assert.equal(reflectionRequest.metadata?.compiledPrompt?.mode, "reflection");
  assert.equal(reflectionRequest.metadata?.responseTrace?.deterministicReflection, true);
  assert.ok(Array.isArray(reflectionRequest.metadata?.compiledPrompt?.messages));

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("worker session.reflect creates a retrieval_miss memory candidate for missed paths", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-worker-reflect-2-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "db.ts"), "export const db = true;\n");

  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "repo" });
  const session = store.createSession({
    projectId: project.id,
    title: "missing path",
    userGoal: "find a function that does not exist",
    mode: "local",
    source: "test",
  });

  store.conversation.appendMessage({
    sessionId: session.id,
    role: "user",
    content: "Where is the missing function?",
  });

  const query = store.retrieval.createQuery({
    sessionId: session.id,
    projectId: project.id,
    originalQuery: "find a function that does not exist",
    intent: "lookup",
    mode: "local",
    depth: "standard",
    analysis: {
      language: "ts",
      terms: ["function", "missing"],
      pathHints: ["src/missing.ts"],
      symbolHints: [],
      isLikelyDefinition: false,
      isLikelyDebug: false,
      notes: ["test"],
    },
  });
  store.retrieval.recordMiss({
    retrievalQueryId: query.id,
    missedPath: "src/missing.ts",
    confidence: 0.1,
    notes: "not indexed",
  });

  store.enqueueJob({
    type: "session.reflect",
    payload: { sessionId: session.id },
  });

  assert.equal(await processNextJob(store), true);

  const candidates = store.memory.listCandidates(undefined, project.id, 20);
  const missCandidate = candidates.find((c) => c.kind === "retrieval_miss");
  assert.ok(missCandidate, "a retrieval_miss memory candidate should be created");
  assert.match(missCandidate?.title, /src\/missing\.ts/);
  // retrieval_miss proposals have confidence 0.7, which meets the auto-promote
  // threshold; the candidate should be immediately accepted into a memory entry.
  assert.equal(missCandidate?.status, "accepted");
  const entries = store.memory.listEntries(project.id, undefined, 20);
  assert.ok(entries.some((e) => e.title.includes("src/missing.ts")));

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("worker session.reflect does not auto-accept candidates", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-worker-reflect-3-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "x.ts"), "export const x = 1;\n");

  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "repo" });
  const session = store.createSession({
    projectId: project.id,
    title: "preferences",
    userGoal: "remember my preference",
    mode: "local",
    source: "test",
  });

  store.conversation.appendMessage({
    sessionId: session.id,
    role: "user",
    content: "I always prefer TypeScript strict mode and avoid any types.",
  });

  store.enqueueJob({
    type: "session.reflect",
    payload: { sessionId: session.id },
  });

  assert.equal(await processNextJob(store), true);

  const candidates = store.memory.listCandidates(undefined, project.id, 20);
  assert.ok(candidates.length >= 1);
  for (const c of candidates) {
    assert.equal(c.status, "pending", "candidates must remain pending until human accepts");
  }

  const entries = store.memory.listEntries(project.id, undefined, 20);
  assert.equal(entries.length, 0, "no memory entry should be created from reflection");

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("worker session.reflect is atomic: a mid-flight failure rolls back all candidates and facts", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-reflect-tx-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "alpha.ts"), "export const alpha = 1;\n");
  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "repo" });
  const session = store.createSession({
    projectId: project.id,
    title: "atomic reflect",
    userGoal: "test atomic reflection",
    mode: "local",
    source: "test",
  });
  store.conversation.appendMessage({
    sessionId: session.id,
    role: "user",
    content: "I always prefer pure functions. Avoid side effects when possible.",
  });
  store.conversation.appendMessage({
    sessionId: session.id,
    role: "assistant",
    content: "Understood. I will always favor pure functions in this codebase.",
  });
  store.conversation.appendMessage({
    sessionId: session.id,
    role: "user",
    content: "I also like early returns and short functions.",
  });
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
  store.retrieval.recordMiss({
    retrievalQueryId: query.id,
    missedPath: "src/missing.ts",
    confidence: 0.2,
    notes: "not retrieved",
  });

  const beforeCandidates = store.memory.listCandidates("pending", null, 100).length;
  const beforeSkills = store.skills.listCandidates("pending", 100).length;
  const beforeFacts = store.memory.listFacts(project.id, 100).length;

  store.enqueueJob({
    type: "session.reflect",
    payload: { sessionId: session.id },
  });

  const originalCreateCandidate = store.memory.createCandidate.bind(store.memory);
  let createCandidateCalls = 0;
  store.memory.createCandidate = ((...args: Parameters<typeof originalCreateCandidate>) => {
    createCandidateCalls += 1;
    if (createCandidateCalls > 1) {
      throw new Error("simulated mid-flight failure");
    }
    return originalCreateCandidate(...args);
  }) as typeof store.memory.createCandidate;

  try {
    await processNextJob(store);
  } finally {
    store.memory.createCandidate = originalCreateCandidate;
  }
  assert.ok(createCandidateCalls > 1, "the override should have been called more than once");

  const failedJob = store.listJobs(10).find((entry) => entry.type === "session.reflect");
  assert.ok(failedJob, "session.reflect job should still be tracked");
  assert.equal(failedJob?.status, "failed", "job should be marked failed after the simulated mid-flight failure");
  const failurePayload = JSON.parse(failedJob?.payloadJson) as { error?: string };
  assert.ok(
    failurePayload.error?.includes("simulated mid-flight failure"),
    `job payload should include the failure reason (got: ${failurePayload.error})`
  );

  assert.equal(
    store.memory.listCandidates("pending", null, 100).length,
    beforeCandidates,
    "memory candidates should have been rolled back"
  );
  assert.equal(
    store.skills.listCandidates("pending", 100).length,
    beforeSkills,
    "skill candidates should have been rolled back"
  );
  assert.equal(store.memory.listFacts(project.id, 100).length, beforeFacts, "facts should have been rolled back");

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("worker session.reflect parses valid model JSON and records parseStatus", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-worker-reflect-json-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "auth.ts"), "export const auth = true;\n");

  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "repo" });
  const session = store.createSession({
    projectId: project.id,
    title: "json reflection",
    userGoal: "capture structured reflection output",
    mode: "local",
    source: "test",
  });

  store.conversation.appendMessage({
    sessionId: session.id,
    role: "user",
    content: "I prefer explicit small functions and predictable control flow.",
  });
  store.enqueueJob({
    type: "session.reflect",
    payload: { sessionId: session.id },
  });

  const originalInvoke = store.invokeModel;
  store.invokeModel = async (profileId, request, options) => {
    const text = JSON.stringify({
      memoryCandidates: [
        {
          kind: "user_preference",
          title: "Preference: explicit small functions",
          body: "Prefer explicit small functions and predictable control flow.",
          confidence: 0.5,
          scope: "project",
          evidence: [],
        },
      ],
      skillCandidates: [],
      facts: [],
      staleFacts: [],
      retrievalFeedback: [],
      notes: ["parsed reflection json"],
    });
    store.models.recordCall({
      profileId,
      role: request.role,
      promptTokens: 7,
      completionTokens: 9,
      latencyMs: 1,
      status: "ok",
      request: { role: request.role, metadata: request.metadata ?? null },
      response: { text },
      sessionId: options?.sessionId ?? null,
      taskId: options?.taskId ?? null,
      retrievalQueryId: options?.retrievalQueryId ?? null,
    });
    return {
      text,
      promptTokens: 7,
      completionTokens: 9,
      latencyMs: 1,
      status: "ok",
      profileId,
      providerId: "provider_heuristic_local",
      usage: { promptTokens: 7, completionTokens: 9, totalTokens: 16 },
    };
  };

  try {
    assert.equal(await processNextJob(store), true);
    const reflectedEvent = store.listEvents(session.id, 50).find((e) => e.type === "session.reflected");
    assert.ok(reflectedEvent);
    assert.equal((reflectedEvent?.payload as { parseStatus?: string }).parseStatus, "parsed");
    const candidates = store.memory.listCandidates("pending", project.id, 20);
    assert.ok(candidates.some((c) => c.title.includes("explicit small functions")));
  } finally {
    store.invokeModel = originalInvoke;
    store.db.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("worker session.reflect auto-promotes high-confidence candidates and marks stale facts", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-worker-reflect-autopromote-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "x.ts"), "export const x = 1;\n");

  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "repo" });
  const session = store.createSession({
    projectId: project.id,
    title: "auto promote",
    userGoal: "test auto-promotion",
    mode: "local",
    source: "test",
  });

  // Seed a stale fact so reflection has something to mark.
  const staleFact = store.memory.recordFact({
    projectId: project.id,
    key: "old_model_profile",
    value: "qwen2.5-7b",
    kind: "usage",
    confidence: 0.5,
    sourceKind: "model_call",
    sources: [{ kind: "session", ref: "old", excerpt: "old usage" }],
  });
  // Backdate lastVerifiedAt so detectStaleFacts picks it up.
  store.db
    .prepare("UPDATE facts SET last_verified_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(), staleFact.id);

  store.enqueueJob({
    type: "session.reflect",
    payload: { sessionId: session.id },
  });

  const originalInvoke = store.invokeModel;
  store.invokeModel = async (profileId, request, options) => {
    const text = JSON.stringify({
      memoryCandidates: [
        {
          kind: "user_preference",
          title: "Strong preference: use ts strict",
          body: "Always use TypeScript strict mode.",
          confidence: 0.85,
          scope: "project",
          evidence: [],
        },
      ],
      skillCandidates: [],
      facts: [],
      staleFacts: [{ factId: staleFact.id, reason: "older than ttl", evidence: [] }],
      retrievalFeedback: [],
      notes: ["auto-promote test"],
    });
    store.models.recordCall({
      profileId,
      role: request.role,
      promptTokens: 7,
      completionTokens: 9,
      latencyMs: 1,
      status: "ok",
      request: { role: request.role, metadata: request.metadata ?? null },
      response: { text },
      sessionId: options?.sessionId ?? null,
      taskId: options?.taskId ?? null,
      retrievalQueryId: options?.retrievalQueryId ?? null,
    });
    return {
      text,
      promptTokens: 7,
      completionTokens: 9,
      latencyMs: 1,
      status: "ok",
      profileId,
      providerId: "provider_heuristic_local",
      usage: { promptTokens: 7, completionTokens: 9, totalTokens: 16 },
    };
  };

  try {
    assert.equal(await processNextJob(store), true);
    const entries = store.memory.listEntries(project.id, undefined, 20);
    assert.equal(entries.length, 1, "high-confidence candidate should be auto-promoted to entry");
    assert.match(entries[0]?.title, /Strong preference/);
    const refreshed = store.memory.listFacts(project.id, 20);
    const updated = refreshed.find((f) => f.id === staleFact.id);
    assert.equal(updated?.status, "stale", "stale fact should be marked as stale");
  } finally {
    store.invokeModel = originalInvoke;
    store.db.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
