import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeStore, createStore } from "../packages/db/src/store.ts";
import {
  analyzeQuery,
  buildRetrievalPipelineInput,
  buildFtsQuery,
  classifyIntent,
  rankChunk,
  rewriteQuery,
  searchProjectChunks,
  tokenize,
} from "../packages/retrieval-engine/src/index.ts";

test("retrieval-engine: analyzes and rewrites a query", () => {
  const analysis = analyzeQuery("where is src/auth.ts handled?");
  assert.ok(analysis.pathHints.includes("src/auth.ts"));
  assert.ok(analysis.isLikelyDefinition);
  assert.ok(analysis.notes.length > 0);

  const rewrite = rewriteQuery("where is src/auth.ts handled?", analysis);
  assert.ok(rewrite.variant.includes("auth"));
  assert.ok(rewrite.pathHints.includes("src/auth.ts"));
  assert.ok(rewrite.terms.length > 0);
});

test("retrieval-engine: builds FTS queries and ranks relevant chunks", () => {
  assert.deepEqual(tokenize("the auth flow in src/auth.ts"), ["auth", "flow", "src"]);
  assert.equal(buildFtsQuery("auth login"), '"auth" AND "login"');
  assert.equal(classifyIntent("fix auth bug", "local"), "debug");

  const score = rankChunk("where is auth handled?", "src/auth.ts", "export function auth() { return true; }", 1, 4);
  assert.ok(score > 0);
});

test("retrieval-engine: searchProjectChunks returns heuristic, FTS, and qdrant-safe results", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-search-pkg-"));
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "README.md"), "# Search Package\n\nThis project mentions README search.\n");
  const dbPath = join(workspace, "ai.db");
  const store = createStore(initializeStore(dbPath));
  const project = store.createProject({ path: workspace, name: "search-pkg" });
  await store.indexProject(project.id);

  const heuristicResults = searchProjectChunks({
    db: store.db,
    projectId: project.id,
    query: "",
    limit: 4,
    qdrantSettings: null,
  });
  assert.ok(heuristicResults.length > 0);

  const ftsResults = searchProjectChunks({
    db: store.db,
    projectId: project.id,
    query: "README",
    limit: 4,
    qdrantSettings: null,
  });
  assert.ok(ftsResults.length > 0);

  const qdrantSafeResults = searchProjectChunks({
    db: store.db,
    projectId: project.id,
    query: "README",
    limit: 4,
    qdrantSettings: { enabled: true, url: "http://127.0.0.1:1", collection: "ai_chunks" },
  });
  assert.ok(qdrantSafeResults.length > 0);

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("retrieval-engine: buildRetrievalPipelineInput is available from the engine package", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-pipe-pkg-"));
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src", "alpha.ts"), "export const alpha = 1;\n");
  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: workspace, name: "pipe-pkg" });
  await store.indexProject(project.id);

  const pipelineInput = buildRetrievalPipelineInput(store, {
    projectId: project.id,
    query: "alpha",
    intent: "lookup",
    mode: "local",
    depth: "standard",
    ftsLimit: 4,
  });

  assert.equal(pipelineInput.query, "alpha");
  assert.ok(pipelineInput.ftsChunks.length > 0);
  assert.ok(pipelineInput.heuristicChunks.length > 0);

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});
