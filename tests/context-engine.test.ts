import assert from "node:assert/strict";
import test from "node:test";
import { buildContextPack, renderContextForPrompt } from "../packages/context-engine/src/index.ts";
import type { RankedChunk } from "../packages/retrieval-engine/src/index.ts";

const ranked: RankedChunk[] = [
  {
    chunk: {
      id: "c1",
      projectId: "p1",
      documentId: "d1",
      path: "src/auth.ts",
      content: "export function auth() { return true; }",
      startLine: 1,
      endLine: 2,
      tokenCount: 8,
      score: 7,
      metadata: {},
    },
    baseScore: 7,
    rerankScore: 8,
    finalScore: 8,
    rerankReason: "boost:good+rule",
    boosters: ["good", "rule"],
  },
  {
    chunk: {
      id: "c2",
      projectId: "p1",
      documentId: "d1",
      path: "src/auth.ts",
      content: "export function auth() { return true; }",
      startLine: 1,
      endLine: 2,
      tokenCount: 8,
      score: 6,
      metadata: {},
    },
    baseScore: 6,
    rerankScore: 6,
    finalScore: 6,
    rerankReason: "no-boost",
    boosters: [],
  },
];

test("context-engine: buildContextPack respects token budget and pins rules first", () => {
  const result = buildContextPack({
    sessionId: "s1",
    projectId: "p1",
    budgetTokens: 100,
    ranked,
    rules: [
      {
        id: "rule_1",
        projectId: "p1",
        title: "TypeScript only",
        body: "Prefer TypeScript.",
        pinned: true,
        createdAt: "2024-01-01",
        updatedAt: "2024-01-01",
      },
    ],
  });
  assert.equal(result.pack.budgetTokens, 100);
  assert.ok(result.pack.usedTokens > 0);
  const first = result.items.find((i) => i.included);
  assert.equal(first?.kind, "project_rule");
  assert.ok(result.items.some((i) => i.kind === "retrieval_chunk" && i.included));
});

test("context-engine: dedupes near-identical retrieval excerpts", () => {
  const result = buildContextPack({ sessionId: "s1", projectId: "p1", budgetTokens: 2000, ranked });
  const duplicates = result.items.filter((i) => i.omissionReason && i.omissionReason.startsWith("dedupe"));
  assert.equal(duplicates.length, 1);
});

test("context-engine: omits stale facts based on ttlDays", () => {
  const longAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const result = buildContextPack({
    sessionId: "s1",
    projectId: "p1",
    budgetTokens: 2048,
    ranked: [],
    facts: [
      {
        id: "f1",
        projectId: "p1",
        key: "node-version",
        value: "22.x",
        kind: "version",
        confidence: 0.9,
        sourceKind: "extraction",
        status: "fresh",
        lastVerifiedAt: longAgo,
        expiresAt: null,
        createdAt: longAgo,
        updatedAt: longAgo,
      },
    ],
    freshFactTtlDays: 30,
  });
  assert.ok(!result.items.some((i) => i.kind === "fact" && i.included));
});

test("context-engine: renderContextForPrompt groups items by kind", () => {
  const result = buildContextPack({
    sessionId: "s1",
    projectId: "p1",
    budgetTokens: 2048,
    ranked,
    rules: [
      {
        id: "rule_1",
        projectId: "p1",
        title: "TypeScript only",
        body: "Prefer TypeScript.",
        pinned: true,
        createdAt: "2024-01-01",
        updatedAt: "2024-01-01",
      },
    ],
  });
  const text = renderContextForPrompt(result);
  assert.match(text, /## project_rule/);
});
