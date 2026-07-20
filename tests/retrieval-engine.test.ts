import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStore, initializeStore } from "../packages/db/src/store.ts";
import {
  analyzeQuery,
  buildFtsQuery,
  buildRetrievalPipelineInput,
  classifyIntent,
  embedQueryForQdrant,
  rankChunk,
  rewriteQuery,
  searchProjectChunks,
  tokenize,
} from "../packages/retrieval-engine/src/index.ts";
import type { RetrievalChunk } from "../packages/shared/src/index.ts";

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
  assert.equal(buildFtsQuery("auth login"), '"auth" OR "login"');
  assert.equal(classifyIntent("fix auth bug", "local"), "debug");

  const score = rankChunk("where is auth handled?", "src/auth.ts", "export function auth() { return true; }", 1, 4);
  assert.ok(score > 0);
  assert.equal(
    rankChunk("recoverInterruptedIndexing implemented", "docs/session.md", "unrelated session notes", 1, 4),
    0
  );
  assert.ok(
    rankChunk(
      "where is recoverInterruptedIndexing implemented?",
      "packages/db/src/store.ts",
      "recoverInterruptedIndexing(): number { return 0; }",
      1,
      1
    ) >
      rankChunk(
        "where is recoverInterruptedIndexing implemented?",
        "apps/api/src/server.ts",
        "store.recoverInterruptedIndexing();",
        1,
        1
      )
  );
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

test("retrieval-engine: searchProjectChunks works when no symbols exist", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-search-no-symbols-"));
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src", "plain.ts"), "export const plain = 1;\n");
  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: workspace, name: "no-symbols" });
  await store.indexProject(project.id);

  const results = searchProjectChunks({
    db: store.db,
    projectId: project.id,
    query: "plain",
    limit: 4,
    qdrantSettings: null,
  });

  assert.ok(results.length > 0);
  assert.ok(results.every((chunk) => !("symbolMatch" in chunk.metadata) || chunk.metadata.symbolMatch == null));

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("retrieval-engine: searchProjectChunks still works when code intelligence is disabled", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-search-disabled-ci-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(
    join(repo, ".ai-workbench.json"),
    JSON.stringify({
      include: ["src/**"],
      codeIntelligence: {
        enabled: false,
      },
    })
  );
  await writeFile(join(repo, "src", "auth.ts"), "export function handleLogin() { return true; }\n");
  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "disabled-ci" });
  await store.indexProject(project.id);

  const results = searchProjectChunks({
    db: store.db,
    projectId: project.id,
    query: "where is handleLogin implemented?",
    limit: 4,
    qdrantSettings: null,
  });

  assert.ok(results.length > 0);
  assert.equal(results[0]?.path, "src/auth.ts");
  assert.ok(
    results.every((chunk) => {
      const codeSymbols = chunk.metadata.codeSymbols;
      return !Array.isArray(codeSymbols) || codeSymbols.length === 0;
    })
  );

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("retrieval-engine: searchProjectChunks gives a symbol-match boost when code symbols are indexed", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-search-symbol-boost-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(
    join(repo, ".ai-workbench.json"),
    JSON.stringify({
      include: ["src/**"],
      codeIntelligence: {
        enabled: true,
      },
    })
  );
  await writeFile(
    join(repo, "src", "auth.ts"),
    ["export function handleLogin() {", "  return { ok: true };", "}"].join("\n")
  );
  await writeFile(join(repo, "src", "misc.ts"), "export const misc = 1;\n");

  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "symbol-boost" });
  await store.indexProject(project.id);

  const results = searchProjectChunks({
    db: store.db,
    projectId: project.id,
    query: "what does handleLogin do?",
    limit: 4,
    qdrantSettings: null,
  });

  assert.ok(results.length > 0);
  assert.ok(
    results.some(
      (chunk) => (chunk.metadata as { symbolMatch?: { reason?: string } }).symbolMatch?.reason === "symbol-match"
    )
  );
  assert.equal(results[0]?.path, "src/auth.ts");

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("retrieval-engine: buildRetrievalPipelineInput keeps lexical and vector candidates separate", () => {
  const chunk = {
    id: "chunk-1",
    projectId: "project-1",
    documentId: "doc-1",
    path: "src/alpha.ts",
    content: "export const alpha = 1;",
    startLine: 1,
    endLine: 1,
    tokenCount: 6,
    score: 1,
    metadata: {},
  } satisfies RetrievalChunk;
  const calls: Array<"search" | "vector"> = [];
  const source = {
    searchChunks(projectId: string, query: string, options: { limit: number }) {
      calls.push("search");
      assert.equal(projectId, "project-1");
      assert.ok(options.limit > 0);
      return query.length > 0 ? [chunk] : [];
    },
    searchChunksWithVector(projectId: string, query: string, queryVector: number[], options: { limit: number }) {
      calls.push("vector");
      assert.equal(projectId, "project-1");
      assert.equal(query, "alpha");
      assert.deepEqual(queryVector, [1, 0, 0]);
      assert.ok(options.limit > 0);
      return [chunk];
    },
    retrieval: {
      listQueriesForProject() {
        return [];
      },
      listFeedback() {
        return [];
      },
      listMisses() {
        return [];
      },
      listPathBoosts() {
        return [];
      },
    },
    memory: {
      listEntries() {
        return [];
      },
      listFacts() {
        return [];
      },
      listProjectRules() {
        return [];
      },
    },
    listProjectFiles() {
      return [];
    },
  };

  const pipelineInput = buildRetrievalPipelineInput(source, {
    projectId: "project-1",
    query: "alpha",
    intent: "lookup",
    mode: "local",
    depth: "standard",
    ftsLimit: 4,
    queryVector: [1, 0, 0],
  });

  assert.deepEqual(calls, ["search", "vector"]);
  assert.equal(pipelineInput.ftsChunks.length, 1);
  assert.equal(pipelineInput.vectorChunks.length, 1);
});

test("retrieval-engine: embedQueryForQdrant honors an explicit embedding override", () => {
  const calls: Array<{ text: string; dimension: number }> = [];
  const vector = embedQueryForQdrant({
    text: "vectorHit",
    dimension: 3,
    embed: (text, dimension) => {
      calls.push({ text, dimension });
      return [1, 0, 0];
    },
  });
  assert.deepEqual(calls, [{ text: "vectorHit", dimension: 3 }]);
  assert.deepEqual(vector, [1, 0, 0]);
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
  assert.equal(pipelineInput.heuristicChunks.length, 0);

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});
