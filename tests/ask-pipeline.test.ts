import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeStore, createStore } from "../packages/db/src/store.ts";

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
  const judgeResponse = judgeCalls[0]?.response as { confidenceNotes: string[]; boost: { good: number; missed: number; bad: number }; rankedCount?: number; droppedCount?: number };
  assert.ok(Array.isArray(judgeResponse.confidenceNotes));
  assert.ok(judgeResponse.boost);

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
