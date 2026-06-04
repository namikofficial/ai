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
