import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { createStore } from "../packages/db/src/store.ts";
import { initializeStore } from "../packages/db/src/index.ts";

test("retrieval recordFeedback writes to retrieval_path_feedback and chunk_path_boosts", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-rfb-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "alpha.ts"), "export const alpha = 1;\n");
  await writeFile(join(repo, "src", "beta.ts"), "export const beta = 2;\n");
  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "repo" });
  const session = store.createSession({
    projectId: project.id,
    title: "rfb",
    userGoal: "test feedback wiring",
    mode: "local",
    source: "test",
  });
  const query = store.retrieval.createQuery({
    sessionId: session.id,
    projectId: project.id,
    originalQuery: "alpha",
    mode: "local",
    depth: "standard",
    intent: "lookup",
    analysis: { language: "ts", terms: ["alpha"], pathHints: ["src/alpha"], symbolHints: ["alpha"], isLikelyDefinition: true, isLikelyDebug: false, notes: [] },
  });
  await store.indexProject(project.id);
  const projectFiles = store.listProjectFiles(project.id, 100);
  const file1 = projectFiles.find((f) => f.path === "src/alpha.ts");
  const file2 = projectFiles.find((f) => f.path === "src/beta.ts");
  assert.ok(file1);
  assert.ok(file2);
  const db = store.db;
  const fileIdToChunkId = new Map<string, string>();
  for (const file of [file1!, file2!]) {
    const chunkRow = db
      .prepare(
        "SELECT c.id AS id FROM rag_chunks c JOIN rag_documents d ON d.id = c.document_id WHERE c.project_id = ? AND d.path = ? LIMIT 1",
      )
      .get(project.id, file.path) as { id: string } | undefined;
    assert.ok(chunkRow, `chunk for ${file.path} should exist after indexProject`);
    fileIdToChunkId.set(file.path, chunkRow!.id);
  }
  store.retrieval.recordResults(query.id, [
    {
      chunkId: fileIdToChunkId.get("src/alpha.ts")!,
      path: "src/alpha.ts",
      startLine: 1,
      endLine: 1,
      source: "fts",
      baseScore: 0.9,
      finalScore: 0.9,
      included: true,
    },
    {
      chunkId: fileIdToChunkId.get("src/beta.ts")!,
      path: "src/beta.ts",
      startLine: 1,
      endLine: 1,
      source: "fts",
      baseScore: 0.1,
      finalScore: 0.1,
      included: true,
    },
  ]);
  store.retrieval.recordFeedback({
    retrievalQueryId: query.id,
    chunkId: fileIdToChunkId.get("src/alpha.ts"),
    rating: "good",
    notes: "relevant",
  });
  store.retrieval.recordFeedback({
    retrievalQueryId: query.id,
    chunkId: fileIdToChunkId.get("src/beta.ts"),
    rating: "bad",
    notes: "irrelevant",
  });
  store.retrieval.recordFeedback({
    retrievalQueryId: query.id,
    missedPath: "src/missing.ts",
    rating: "missed",
    notes: "not retrieved",
  });
  const pathFeedback = store.retrieval.listPathFeedback(project.id, 50);
  assert.equal(pathFeedback.length, 3);
  const byPath = new Map(pathFeedback.map((entry) => [entry.path, entry.rating]));
  assert.equal(byPath.get("src/alpha.ts"), "good");
  assert.equal(byPath.get("src/beta.ts"), "bad");
  assert.equal(byPath.get("src/missing.ts"), "missed");
  const boosts = store.retrieval.listPathBoosts(project.id, 50);
  const alphaBoost = boosts.find((b) => b.path === "src/alpha.ts");
  const betaBoost = boosts.find((b) => b.path === "src/beta.ts");
  const missBoost = boosts.find((b) => b.path === "src/missing.ts");
  assert.ok(alphaBoost);
  assert.ok(betaBoost);
  assert.ok(missBoost);
  assert.ok(alphaBoost!.weight > betaBoost!.weight, `alpha (${alphaBoost!.weight}) should outrank beta (${betaBoost!.weight})`);
  assert.ok(alphaBoost!.weight > 0.5, "good feedback should push weight above neutral");
  assert.ok(betaBoost!.weight < 0.5, "bad feedback should push weight below neutral");
  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("retrieval recordFeedback is atomic: a constraint violation rolls back all 3 writes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-rfb-tx-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "alpha.ts"), "export const alpha = 1;\n");
  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "repo" });
  const session = store.createSession({
    projectId: project.id,
    title: "tx",
    userGoal: "test transactional rollback",
    mode: "local",
    source: "test",
  });
  const query = store.retrieval.createQuery({
    sessionId: session.id,
    projectId: project.id,
    originalQuery: "alpha",
    mode: "local",
    depth: "standard",
    intent: "lookup",
    analysis: { language: "ts", terms: ["alpha"], pathHints: ["src/alpha"], symbolHints: ["alpha"], isLikelyDefinition: true, isLikelyDebug: false, notes: [] },
  });
  await store.indexProject(project.id);
  const alphaChunk = store.db
    .prepare(
      "SELECT c.id AS id FROM rag_chunks c JOIN rag_documents d ON d.id = c.document_id WHERE c.project_id = ? AND d.path = ? LIMIT 1",
    )
    .get(project.id, "src/alpha.ts") as { id: string };

  const beforeFeedback = store.retrieval.listFeedback(query.id, 50).length;
  const beforePathFeedback = store.retrieval.listPathFeedback(project.id, 50).length;
  const beforeBoosts = store.retrieval.listPathBoosts(project.id, 50).length;

  const result = store.retrieval.recordFeedback({
    retrievalQueryId: query.id,
    chunkId: alphaChunk.id,
    rating: "good",
    notes: "normal happy path",
  });
  assert.ok(result.id);
  assert.equal(
    store.retrieval.listFeedback(query.id, 50).length,
    beforeFeedback + 1,
    "first call should persist the feedback",
  );
  assert.equal(
    store.retrieval.listPathFeedback(project.id, 50).length,
    beforePathFeedback + 1,
    "first call should persist path feedback",
  );
  assert.equal(
    store.retrieval.listPathBoosts(project.id, 50).length,
    beforeBoosts + 1,
    "first call should persist a chunk path boost",
  );

  const baselineFeedback = store.retrieval.listFeedback(query.id, 50).length;
  const baselinePathFeedback = store.retrieval.listPathFeedback(project.id, 50).length;
  const baselineBoosts = store.retrieval.listPathBoosts(project.id, 50).length;

  const originalPrepare = store.db.prepare.bind(store.db);
  let shouldThrow = false;
  (store.db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    if (shouldThrow && sql.includes("chunk_path_boosts") && (sql.includes("INSERT") || sql.includes("UPDATE"))) {
      throw new Error("simulated constraint violation");
    }
    return originalPrepare(sql);
  };
  shouldThrow = true;
  try {
    assert.throws(
      () => store.retrieval.recordFeedback({
        retrievalQueryId: query.id,
        chunkId: alphaChunk.id,
        rating: "good",
        notes: "this should roll back",
      }),
      /simulated constraint violation/,
    );
  } finally {
    (store.db as unknown as { prepare: (sql: string) => unknown }).prepare = originalPrepare;
  }

  assert.equal(
    store.retrieval.listFeedback(query.id, 50).length,
    baselineFeedback,
    "feedback row should have been rolled back",
  );
  assert.equal(
    store.retrieval.listPathFeedback(project.id, 50).length,
    baselinePathFeedback,
    "path_feedback row should have been rolled back",
  );
  assert.equal(
    store.retrieval.listPathBoosts(project.id, 50).length,
    baselineBoosts,
    "chunk_path_boost row should have been rolled back",
  );

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});
