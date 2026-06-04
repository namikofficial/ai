import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeStore, createStore } from "../packages/db/src/store.ts";
import { processNextJob } from "../apps/worker/src/worker.ts";

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
    "candidate body should mention the user preference",
  );

  const reflectedEvent = store.listEvents(session.id, 50).find(
    (e) => e.type === "session.reflected",
  );
  assert.ok(reflectedEvent, "session.reflected event should be appended");

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
  assert.match(missCandidate!.title, /src\/missing\.ts/);
  assert.equal(missCandidate!.status, "pending");

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
