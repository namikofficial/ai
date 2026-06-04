import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeStore, createStore } from "../packages/db/src/store.ts";

test("ask flow + recordFeedback: a positively-rated path ranks higher on the next ask", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-feedback-loop-"));
  const repo = join(workspace, "sample-repo");
  await mkdir(join(repo, "src"), { recursive: true });
  for (let i = 0; i < 4; i++) {
    await writeFile(
      join(repo, "src", `noise-${i}.ts`),
      `export function noise${i}() { return "noise ${i}"; }\n`,
    );
  }
  await writeFile(
    join(repo, "src", "auth.ts"),
    [
      "export function handleLogin() {",
      "  return { route: '/api/auth/login' };",
      "}",
      "",
      "export const authNote = 'auth is handled in the auth router';",
    ].join("\n"),
  );
  await writeFile(
    join(repo, "src", "billing.ts"),
    [
      "export function chargeCard() {",
      "  return { processor: 'stripe' };",
      "}",
      "",
      "export const billingNote = 'billing is handled in the billing router';",
    ].join("\n"),
  );

  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "sample-repo" });
  await store.indexProject(project.id);

  const first = await store.ask({
    project: project.id,
    question: "where is auth handled?",
    mode: "local",
    depth: "standard",
  });
  const firstQuery = store.retrieval.listQueriesForSession(first.sessionId, 5)[0]!;
  const firstResults = store.retrieval.listResults(firstQuery.id, 100);
  const authResult = firstResults.find((r) => r.path === "src/auth.ts");
  assert.ok(authResult, "auth.ts should be in the first ask's results");
  store.retrieval.recordFeedback({
    retrievalQueryId: firstQuery.id,
    chunkId: authResult!.chunkId,
    rating: "good",
    notes: "exactly the answer",
  });

  const beforeBoosts = store.retrieval.listPathBoosts(project.id, 50);
  const authBoostBefore = beforeBoosts.find((b) => b.path === "src/auth.ts");
  assert.ok(authBoostBefore, "chunk_path_boosts should contain src/auth.ts after recordFeedback");
  assert.ok(authBoostBefore!.weight > 0.5, "good feedback should produce a weight above neutral");

  const second = await store.ask({
    project: project.id,
    question: "where is auth handled?",
    mode: "local",
    depth: "standard",
  });
  const secondQuery = store.retrieval.listQueriesForSession(second.sessionId, 5)[0]!;
  const secondResults = store.retrieval.listResults(secondQuery.id, 100);
  const authResultSecond = secondResults.find((r) => r.path === "src/auth.ts");
  const billingResultSecond = secondResults.find((r) => r.path === "src/billing.ts");
  assert.ok(authResultSecond, "auth.ts should appear in the second ask's results");
  assert.ok(billingResultSecond, "billing.ts should appear in the second ask's results");
  assert.ok(
    authResultSecond!.finalScore >= billingResultSecond!.finalScore,
    `auth (${authResultSecond!.finalScore}) should be ranked at or above billing (${billingResultSecond!.finalScore}) after the boost`,
  );

  const authBoostAfter = store.retrieval.listPathBoosts(project.id, 50).find((b) => b.path === "src/auth.ts");
  assert.ok(authBoostAfter, "auth.ts should still be in chunk_path_boosts after the second ask");

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("recordFeedback: bad feedback lowers a path's weight in subsequent rerank", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-feedback-bad-"));
  const repo = join(workspace, "sample-repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(
    join(repo, "src", "alpha.ts"),
    "export const alpha = 'shared term appears here for search';\n",
  );
  await writeFile(
    join(repo, "src", "beta.ts"),
    "export const beta = 'shared term appears here for search';\n",
  );

  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "sample-repo" });
  await store.indexProject(project.id);

  const first = await store.ask({
    project: project.id,
    question: "shared term",
    mode: "local",
    depth: "standard",
  });
  const firstQuery = store.retrieval.listQueriesForSession(first.sessionId, 5)[0]!;
  const firstResults = store.retrieval.listResults(firstQuery.id, 100);
  const alphaResult = firstResults.find((r) => r.path === "src/alpha.ts");
  assert.ok(alphaResult);
  store.retrieval.recordFeedback({
    retrievalQueryId: firstQuery.id,
    chunkId: alphaResult!.chunkId,
    rating: "bad",
    notes: "irrelevant",
  });

  const boosts = store.retrieval.listPathBoosts(project.id, 50);
  const alphaBoost = boosts.find((b) => b.path === "src/alpha.ts");
  const betaBoost = boosts.find((b) => b.path === "src/beta.ts");
  assert.ok(alphaBoost);
  assert.equal(betaBoost, undefined, "beta should not have a boost since no feedback was recorded for it");
  assert.ok(alphaBoost!.weight < 0.5, `bad feedback should produce weight below neutral (got ${alphaBoost!.weight})`);

  const second = await store.ask({
    project: project.id,
    question: "shared term",
    mode: "local",
    depth: "standard",
  });
  const secondQuery = store.retrieval.listQueriesForSession(second.sessionId, 5)[0]!;
  const secondResults = store.retrieval.listResults(secondQuery.id, 100);
  const alphaResultSecond = secondResults.find((r) => r.path === "src/alpha.ts");
  const betaResultSecond = secondResults.find((r) => r.path === "src/beta.ts");
  assert.ok(alphaResultSecond);
  assert.ok(betaResultSecond);
  assert.ok(
    alphaResultSecond!.finalScore <= betaResultSecond!.finalScore,
    `bad-rated alpha (${alphaResultSecond!.finalScore}) should not rank above untouched beta (${betaResultSecond!.finalScore})`,
  );

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});
