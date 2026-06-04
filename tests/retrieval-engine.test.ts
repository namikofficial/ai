import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeQuery,
  buildFtsQuery,
  classifyIntent,
  rankChunk,
  rewriteQuery,
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
