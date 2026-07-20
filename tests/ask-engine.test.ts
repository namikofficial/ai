import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAskAnswerPrompt,
  buildAskCitations,
  buildAskFallbackAnswer,
  buildAskQueryRewritePrompt,
  buildAskRetrievalJudgePrompt,
} from "../packages/ask-engine/src/index.ts";

test("ask-engine: builds query rewrite, retrieval judge, and answer prompt inputs", () => {
  const rewrite = buildAskQueryRewritePrompt({
    question: "where is auth handled?",
    retrievalQueryId: "rq_1",
    intent: "lookup",
    mode: "local",
    analysis: { terms: ["auth"] },
  });
  assert.equal(rewrite.mode, "query_rewrite");
  assert.equal(rewrite.role, "query_rewrite");
  assert.ok(rewrite.taskConstraints?.some((line) => line.includes("Intent: lookup")));

  const judge = buildAskRetrievalJudgePrompt({
    question: "where is auth handled?",
    retrievalQueryId: "rq_1",
    contextPackId: "cp_1",
    rewrittenQuery: "auth handled",
    mode: "local",
    depth: "standard",
    retrievalChunks: [],
    rankedCount: 3,
    selectedCount: 1,
    droppedCount: 2,
  });
  assert.equal(judge.mode, "retrieval_judge");
  assert.equal(judge.contextPackId, "cp_1");
  assert.ok(judge.taskConstraints?.some((line) => line.includes("Ranked: 3")));

  const answer = buildAskAnswerPrompt({
    question: "where is auth handled?",
    projectName: "repo",
    contextPackId: "cp_1",
    confidence: 0.7,
    insufficientReason: null,
    projectRules: [],
    memoryEntries: [],
    facts: [],
    retrievalChunks: [],
    contextPackItems: [],
    previousMessages: [],
    sessionId: "session_1",
    retrievalQueryId: "rq_1",
  });
  assert.equal(answer.mode, "answer");
  assert.equal(answer.contextPackId, "cp_1");
  assert.ok(answer.taskConstraints?.some((line) => line.includes("Confidence before synthesis")));
});

test("ask-engine: citation and fallback helpers are deterministic", () => {
  const citations = buildAskCitations([
    {
      chunk: {
        id: "c1",
        projectId: "p1",
        documentId: "d1",
        path: "src/auth.ts",
        content: "line1\nline2\nline3\nline4\nline5",
        startLine: 1,
        endLine: 5,
        tokenCount: 5,
        score: 1,
        metadata: {},
      },
      baseScore: 1,
      rerankScore: 1,
      finalScore: 1,
      rerankReason: "no-boost",
      boosters: [],
    },
  ]);
  assert.equal(citations[0]?.excerpt, "line1\nline2\nline3\nline4");
  const focused = buildAskCitations(
    [
      {
        chunk: {
          id: "c2",
          projectId: "p1",
          documentId: "d1",
          path: "src/recovery.ts",
          content: "unrelated call site\nline2\nline3\nline4\nrecoverInterruptedIndexing();\nline6",
          startLine: 10,
          endLine: 15,
          tokenCount: 6,
          score: 2,
          metadata: {},
        },
        baseScore: 2,
        rerankScore: 2,
        finalScore: 2,
        rerankReason: "exact symbol",
        boosters: [],
      },
    ],
    "Where is recoverInterruptedIndexing implemented?"
  );
  assert.match(focused[0]?.excerpt ?? "", /recoverInterruptedIndexing/);
  assert.equal(focused[0]?.startLine, 13);
  assert.equal(
    buildAskFallbackAnswer("repo", "where is auth handled?"),
    'I could not find enough local context in repo to answer "where is auth handled?".'
  );
});
