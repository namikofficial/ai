import assert from "node:assert/strict";
import test from "node:test";
import {
  applyFeedbackBoosts,
  buildFeedbackBoosts,
  computeConfidence,
  generateRewrites,
  hybridMerge,
  rerankChunks,
  runRetrievalPipeline,
  selectTopByTokenBudget,
} from "../packages/retrieval-engine/src/index.ts";
import type { RetrievalChunk } from "../packages/shared/src/index.ts";

const baseChunk = {
  id: "chunk_1",
  projectId: "p1",
  documentId: "d1",
  path: "src/auth.ts",
  content: "export function auth() { return 'login'; }",
  startLine: 1,
  endLine: 2,
  tokenCount: 16,
  score: 5,
  metadata: {},
};

const otherChunk = {
  ...baseChunk,
  id: "chunk_2",
  path: "src/db.ts",
  content: "export function query() { return 1; }",
  startLine: 1,
  endLine: 1,
  score: 1,
  tokenCount: 10,
};

test("retrieval-pipeline: rewrites include path and symbol variants", () => {
  const rewrites = generateRewrites({
    query: "where is auth handled?",
    analysis: {
      language: "typescript",
      terms: ["auth", "handled"],
      pathHints: ["src/auth.ts"],
      symbolHints: ["handleAuth"],
      isLikelyDefinition: true,
      isLikelyDebug: false,
      notes: [],
    },
    feedback: [],
    facts: [],
    memory: [],
  });
  assert.ok(rewrites.length >= 2);
  const reasons = new Set(rewrites.map((r) => r.reason));
  assert.ok(reasons.has("path-biased"));
  assert.ok(reasons.has("symbol-biased"));
});

test("retrieval-pipeline: rerank applies good/bad feedback and missed-path boosts", () => {
  const chunks = [baseChunk, otherChunk];
  const ranked = rerankChunks({
    query: "auth",
    analysis: {
      language: null,
      terms: ["auth"],
      pathHints: [],
      symbolHints: [],
      isLikelyDefinition: false,
      isLikelyDebug: false,
      notes: [],
    },
    chunks,
    feedback: [
      {
        id: "f1",
        retrievalQueryId: "rq",
        chunkId: "chunk_1",
        rating: "good",
        missedPath: null,
        notes: null,
        createdAt: "2024-01-01",
      },
      {
        id: "f2",
        retrievalQueryId: "rq",
        chunkId: "chunk_2",
        rating: "bad",
        missedPath: null,
        notes: null,
        createdAt: "2024-01-01",
      },
    ],
    feedbackChunkPaths: new Map([
      ["chunk_1", "src/auth.ts"],
      ["chunk_2", "src/db.ts"],
    ]),
    missRecords: [],
    pathBoosts: new Map(),
    memoryEntries: [],
    facts: [],
    rules: [],
    priorSessionPaths: [],
    depth: "standard",
  });
  assert.equal(ranked[0].chunk.id, "chunk_1");
  assert.ok(ranked[0].boosters.includes("good"));
  assert.ok(ranked[1].boosters.includes("bad"));
});

test("retrieval-pipeline: hybridMerge dedupes by chunkId and adds cross-source boost", () => {
  const merged = hybridMerge([
    { source: "fts", chunk: baseChunk, score: 3 },
    { source: "vector", chunk: baseChunk, score: 5 },
    { source: "heuristic", chunk: otherChunk, score: 1 },
  ]);
  assert.equal(merged.length, 2);
  const top = merged[0];
  assert.ok(top.score >= 5);
  assert.deepEqual(top.metadata.sources, ["fts", "vector"]);
});

test("retrieval-pipeline: confidence drops on bad feedback and rises on good", () => {
  const rankedGood = rerankChunks({
    query: "auth",
    analysis: {
      language: null,
      terms: ["auth"],
      pathHints: [],
      symbolHints: [],
      isLikelyDefinition: false,
      isLikelyDebug: false,
      notes: [],
    },
    chunks: [baseChunk],
    feedback: [
      {
        id: "f1",
        retrievalQueryId: "rq",
        chunkId: "chunk_1",
        rating: "good",
        missedPath: null,
        notes: null,
        createdAt: "2024-01-01",
      },
    ],
    feedbackChunkPaths: new Map([["chunk_1", "src/auth.ts"]]),
    missRecords: [],
    pathBoosts: new Map(),
    memoryEntries: [],
    facts: [],
    rules: [],
    priorSessionPaths: [],
    depth: "standard",
  });
  const rankedBad = rerankChunks({
    query: "auth",
    analysis: {
      language: null,
      terms: ["auth"],
      pathHints: [],
      symbolHints: [],
      isLikelyDefinition: false,
      isLikelyDebug: false,
      notes: [],
    },
    chunks: [baseChunk],
    feedback: [
      {
        id: "f2",
        retrievalQueryId: "rq",
        chunkId: "chunk_1",
        rating: "bad",
        missedPath: null,
        notes: null,
        createdAt: "2024-01-01",
      },
    ],
    feedbackChunkPaths: new Map([["chunk_1", "src/auth.ts"]]),
    missRecords: [],
    pathBoosts: new Map(),
    memoryEntries: [],
    facts: [],
    rules: [],
    priorSessionPaths: [],
    depth: "standard",
  });
  const goodConfidence = computeConfidence(rankedGood, "lookup", "standard");
  const badConfidence = computeConfidence(rankedBad, "lookup", "standard");
  assert.ok(goodConfidence.final >= badConfidence.final);
});

test("retrieval-pipeline: token budget trims lower-ranked chunks and keeps top items", () => {
  const chunks = [
    { ...baseChunk, id: "a", score: 8, tokenCount: 200 },
    { ...baseChunk, id: "b", score: 6, tokenCount: 200 },
    { ...baseChunk, id: "c", score: 4, tokenCount: 200 },
  ];
  const ranked = rerankChunks({
    query: "auth",
    analysis: {
      language: null,
      terms: ["auth"],
      pathHints: [],
      symbolHints: [],
      isLikelyDefinition: false,
      isLikelyDebug: false,
      notes: [],
    },
    chunks,
    feedback: [],
    feedbackChunkPaths: new Map(),
    missRecords: [],
    pathBoosts: new Map(),
    memoryEntries: [],
    facts: [],
    rules: [],
    priorSessionPaths: [],
    depth: "standard",
  });
  const { selected, dropped, usedTokens } = selectTopByTokenBudget({
    ranked,
    budgetTokens: 250,
    depth: "standard",
  });
  assert.equal(selected.length, 1);
  assert.equal(dropped.length, 2);
  assert.equal(selected[0].chunk.id, "a");
  assert.equal(usedTokens, 200);
});

test("retrieval-pipeline: low-confidence retrieval records a miss", () => {
  const result = runRetrievalPipeline({
    query: "where is auth?",
    intent: "lookup",
    mode: "local",
    depth: "shallow",
    ftsChunks: [],
    vectorChunks: [],
    heuristicChunks: [],
    feedback: [],
    feedbackChunkPaths: new Map(),
    missRecords: [],
    pathBoosts: new Map(),
    memoryEntries: [],
    facts: [],
    rules: [],
    priorSessionPaths: [],
    budgetTokens: 2048,
  });
  assert.ok(result.confidence < 0.3);
  assert.ok(result.miss);
});

test("retrieval-pipeline: buildFeedbackBoosts applies weights and bad chunk ids", () => {
  const { goodPaths, badChunkIds, missedPaths } = buildFeedbackBoosts(
    [
      {
        id: "f1",
        retrievalQueryId: "rq",
        chunkId: "c1",
        rating: "good",
        missedPath: null,
        notes: null,
        createdAt: "2024-01-01",
      },
      {
        id: "f2",
        retrievalQueryId: "rq",
        chunkId: "c2",
        rating: "bad",
        missedPath: null,
        notes: null,
        createdAt: "2024-01-01",
      },
      {
        id: "f3",
        retrievalQueryId: "rq",
        chunkId: null,
        rating: "missed",
        missedPath: "src/missing.ts",
        notes: null,
        createdAt: "2024-01-01",
      },
    ],
    new Map([
      ["c1", "src/auth.ts"],
      ["c2", "src/db.ts"],
    ])
  );
  assert.equal(goodPaths.get("src/auth.ts"), 1);
  assert.ok(badChunkIds.has("c2"));
  assert.equal(missedPaths.get("src/missing.ts"), 1);
});

test("retrieval-pipeline: applyFeedbackBoosts combines miss and good signals", () => {
  const out = applyFeedbackBoosts(
    { ...baseChunk, path: "src/auth.ts" },
    { goodPaths: new Map([["src/auth.ts", 2]]), badChunkIds: new Set(), missedPaths: new Map() },
    []
  );
  assert.ok(out.applied.includes("good"));
  assert.ok(out.score > 0);
});

test("retrieval-pipeline: pathBoosts re-rank chunks when feedback is sparse", () => {
  const chunks: RetrievalChunk[] = [
    {
      ...baseChunk,
      id: "chunk_alpha",
      path: "src/alpha.ts",
      score: 0.5,
    },
    {
      ...baseChunk,
      id: "chunk_beta",
      path: "src/beta.ts",
      score: 0.5,
    },
  ];
  const baseOutput = runRetrievalPipeline({
    query: "alpha",
    intent: "lookup",
    mode: "local",
    depth: "standard",
    ftsChunks: [],
    vectorChunks: [],
    heuristicChunks: chunks,
    feedback: [],
    feedbackChunkPaths: new Map(),
    missRecords: [],
    pathBoosts: new Map(),
    memoryEntries: [],
    facts: [],
    rules: [],
    priorSessionPaths: [],
    budgetTokens: 4096,
  });
  const alphaBase = baseOutput.ranked.find((r) => r.chunk.id === "chunk_alpha");
  const betaBase = baseOutput.ranked.find((r) => r.chunk.id === "chunk_beta");
  assert.ok(alphaBase && betaBase);
  const alphaBaseScore = alphaBase!.finalScore;
  const betaBaseScore = betaBase!.finalScore;
  assert.equal(alphaBaseScore, betaBaseScore);
  const boostedOutput = runRetrievalPipeline({
    query: "alpha",
    intent: "lookup",
    mode: "local",
    depth: "standard",
    ftsChunks: [],
    vectorChunks: [],
    heuristicChunks: chunks,
    feedback: [],
    feedbackChunkPaths: new Map(),
    missRecords: [],
    pathBoosts: new Map([
      ["src/alpha.ts", 0.95],
      ["src/beta.ts", 0.05],
    ]),
    memoryEntries: [],
    facts: [],
    rules: [],
    priorSessionPaths: [],
    budgetTokens: 4096,
  });
  const alphaBoosted = boostedOutput.ranked.find((r) => r.chunk.id === "chunk_alpha")!;
  const betaBoosted = boostedOutput.ranked.find((r) => r.chunk.id === "chunk_beta")!;
  assert.ok(alphaBoosted && betaBoosted);
  const alphaScore = alphaBoosted.finalScore;
  const betaScore = betaBoosted.finalScore;
  assert.ok(alphaScore > betaScore, `alpha (${alphaScore}) should outrank beta (${betaScore}) after pathBoosts`);
});
