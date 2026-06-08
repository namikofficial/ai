import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeStore } from "../packages/db/src/index.ts";
import {
  buildRetrievalPipelineInput,
  runRetrievalExplain,
} from "../packages/db/src/retrieval-explain.ts";
import { createStore } from "../packages/db/src/store.ts";

test("buildRetrievalPipelineInput loads FTS+heuristic+feedback+misses+memory+facts+rules+pathBoosts for a project", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-build-pipe-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "alpha.ts"), "export const alpha = 1;\n");
  await writeFile(join(repo, "src", "beta.ts"), "export const beta = 2;\n");
  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "repo" });
  const session = store.createSession({
    projectId: project.id,
    title: "t",
    userGoal: "build pipeline input",
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
  const alphaChunk = store.db
    .prepare(
      "SELECT c.id AS id FROM rag_chunks c JOIN rag_documents d ON d.id = c.document_id WHERE c.project_id = ? AND d.path = ? LIMIT 1"
    )
    .get(project.id, "src/alpha.ts") as { id: string };
  store.retrieval.recordFeedback({
    retrievalQueryId: query.id,
    chunkId: alphaChunk.id,
    rating: "good",
    notes: "relevant",
  });
  store.retrieval.recordMiss({
    retrievalQueryId: query.id,
    missedPath: "src/gamma.ts",
    confidence: 0.2,
    notes: "not retrieved",
  });
  store.memory.recordFact({
    projectId: project.id,
    key: "alpha",
    value: "main module",
    confidence: 0.9,
    sourceKind: "reflection",
  });

  const pipelineInput = buildRetrievalPipelineInput(store, {
    projectId: project.id,
    query: "alpha",
    intent: "lookup",
    mode: "local",
    depth: "standard",
    ftsLimit: 8,
  });
  assert.equal(pipelineInput.query, "alpha");
  assert.equal(pipelineInput.intent, "lookup");
  assert.equal(pipelineInput.ftsChunks.length > 0, true, "FTS should find alpha.ts chunk");
  assert.equal(
    pipelineInput.heuristicChunks.length > 0,
    true,
    "Heuristic should list recent files"
  );
  assert.equal(pipelineInput.feedback.length, 1);
  assert.equal(pipelineInput.feedback[0]?.rating, "good");
  assert.equal(pipelineInput.missRecords.length, 1);
  assert.equal(pipelineInput.missRecords[0]?.missedPath, "src/gamma.ts");
  assert.equal(pipelineInput.memoryEntries.length >= 0, true);
  assert.equal(pipelineInput.facts.length, 1);
  assert.equal(pipelineInput.facts[0]?.key, "alpha");
  assert.equal(pipelineInput.pathBoosts.size, 1);
  const alphaWeight = pipelineInput.pathBoosts.get("src/alpha.ts");
  assert.ok(alphaWeight, "src/alpha.ts should be in pathBoosts");
  assert.ok(
    alphaWeight! > 0.5,
    `good feedback should push weight above neutral (got ${alphaWeight})`
  );

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("runRetrievalExplain returns a structured explanation that includes ranked, selected, dropped, and rewrites", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-explain-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "alpha.ts"), "export const alpha = 1;\n");
  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "repo" });
  await store.indexProject(project.id);
  const output = runRetrievalExplain(store, {
    projectId: project.id,
    query: "alpha",
    mode: "local",
    depth: "standard",
    limit: 4,
  });
  assert.equal(output.query, "alpha");
  assert.equal(output.projectId, project.id);
  assert.ok(Array.isArray(output.rewrites));
  assert.ok(output.rewrites.length > 0, "should produce at least one rewrite variant");
  assert.ok(output.confidence >= 0 && output.confidence <= 1);
  assert.ok(typeof output.usedTokens === "number");
  assert.ok(Array.isArray(output.ranked));
  assert.ok(output.ranked.length > 0, "should rank at least one chunk");
  assert.ok(Array.isArray(output.selected));
  assert.ok(Array.isArray(output.dropped));
  assert.equal(typeof output.boost, "object");
  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});
