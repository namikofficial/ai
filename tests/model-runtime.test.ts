import assert from "node:assert/strict";
import test from "node:test";
import { buildAnswer, selectModelProfile } from "../packages/model-runtime/src/index.ts";

test("model-runtime: selectModelProfile keeps the current heuristic routing", () => {
  assert.equal(selectModelProfile("cloud"), "ask-cloud-router");
  assert.equal(selectModelProfile("hybrid"), "ask-hybrid-router");
  assert.equal(selectModelProfile("index"), "indexer-local");
  assert.equal(selectModelProfile("plan", { risk: "high" }), "planner-deep-local");
  assert.equal(selectModelProfile("plan", { risk: "medium" }), "planner-balanced-local");
  assert.equal(selectModelProfile("plan"), "planner-fast-local");
  assert.equal(selectModelProfile("ask", { depth: "deep" }), "ask-deep-local");
  assert.equal(selectModelProfile("ask", { question: "x".repeat(121) }), "ask-extended-local");
  assert.equal(selectModelProfile("ask"), "ask-fast-local");
});

test("model-runtime: buildAnswer includes citations and confidence", () => {
  const answer = buildAnswer(
    "where is auth handled?",
    { id: "proj_1", name: "demo", path: "/repo", repoUrl: null, branch: null, language: null, framework: null, status: "ready", lastIndexedAt: null, createdAt: "2024-01-01", updatedAt: "2024-01-01", fileCount: 1, chunkCount: 1, indexedFileCount: 1, dirty: false, health: "healthy" },
    [
      {
        id: "chunk_1",
        projectId: "proj",
        documentId: "doc",
        path: "src/auth.ts",
        content: "export function auth() {\n  return true;\n}",
        startLine: 1,
        endLine: 2,
        tokenCount: 12,
        score: 9,
        metadata: {},
      },
    ],
    [{ path: "src/auth.ts", startLine: 1, endLine: 2, score: 9 }],
    0.84,
  );

  assert.ok(/Confidence: 84%/.test(answer));
  assert.ok(/src\/auth\.ts:1-2/.test(answer));
});
