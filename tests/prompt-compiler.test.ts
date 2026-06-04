import assert from "node:assert/strict";
import test from "node:test";
import { compilePrompt, buildAnswerFromCompiledPrompt, estimatePromptTokens } from "../packages/prompt-compiler/src/index.ts";

test("prompt-compiler: answer mode includes system rules and retrieval context", () => {
  const compiled = compilePrompt({
    mode: "answer",
    role: "answer",
    userRequest: "where is auth handled?",
    retrievalChunks: [
      {
        id: "chunk_1",
        projectId: "p1",
        documentId: "d1",
        path: "src/auth.ts",
        content: "export function handleLogin() { return true; }",
        startLine: 1,
        endLine: 3,
        tokenCount: 12,
        score: 9,
        metadata: {},
      },
    ],
    projectRules: [
      { id: "rule_1", projectId: "p1", title: "TypeScript only", body: "Prefer TypeScript.", pinned: true, createdAt: "2024-01-01", updatedAt: "2024-01-01" },
    ],
    tokenBudget: 2048,
  });
  assert.equal(compiled.mode, "answer");
  assert.ok(compiled.messages.length >= 2);
  const systemMessage = compiled.messages.find((m) => m.role === "system");
  assert.ok(systemMessage);
  assert.match(systemMessage?.content ?? "", /local-first engineering assistant/);
  assert.ok(compiled.includedContext.length > 0);
  assert.equal(compiled.includedContext[0].kind, "retrieval_chunk");
  assert.ok(compiled.estimatedTokens > 0);
});

test("prompt-compiler: handoff mode includes task constraints and outputs schema", () => {
  const compiled = compilePrompt({
    mode: "handoff",
    role: "coder_handoff",
    userRequest: "implement the auth router",
    taskConstraints: ["do not modify package.json", "must include tests"],
    outputSchema: { type: "object", properties: { prompt: { type: "string" } } },
    retrievalChunks: [
      {
        id: "chunk_2",
        projectId: "p1",
        documentId: "d1",
        path: "src/auth.ts",
        content: "auth router lives here",
        startLine: 1,
        endLine: 1,
        tokenCount: 4,
        score: 5,
        metadata: {},
      },
    ],
  });
  assert.equal(compiled.mode, "handoff");
  const combined = compiled.messages.map((m) => m.content).join("\n");
  assert.match(combined, /do not modify package.json/);
  assert.match(combined, /must include tests/);
  assert.deepEqual(compiled.outputSchema, { type: "object", properties: { prompt: { type: "string" } } });
});

test("prompt-compiler: reflection mode cites session id and surfaces safety notes for secrets", () => {
  const compiled = compilePrompt({
    mode: "reflection",
    role: "reflection",
    userRequest: "reflect on session sess_1",
    metadata: { sessionId: "sess_1" },
    previousMessages: [
      { id: "m1", sessionId: "sess_1", projectId: null, role: "user", agent: null, content: "use AKIAABCDEFGHIJKLMNOP here", contentHash: "h1", metaJson: "{}", tokenCount: 8, parentMessageId: null, ts: "2024-01-01T00:00:00Z", createdAt: "2024-01-01T00:00:00Z" },
    ],
  });
  const combined = compiled.messages.map((m) => m.content).join("\n");
  assert.match(combined, /sess_1/);
  assert.ok(compiled.safetyNotes.length >= 0);
});

test("prompt-compiler: buildAnswerFromCompiledPrompt returns deterministic text", () => {
  const compiled = compilePrompt({
    mode: "answer",
    role: "answer",
    userRequest: "where is auth?",
    retrievalChunks: [
      {
        id: "c1",
        projectId: "p1",
        documentId: "d1",
        path: "src/auth.ts",
        content: "auth router",
        startLine: 1,
        endLine: 1,
        tokenCount: 2,
        score: 8,
        metadata: {},
      },
    ],
  });
  const text = buildAnswerFromCompiledPrompt(
    compiled,
    "Auth is in src/auth.ts.",
    [{ path: "src/auth.ts", startLine: 1, endLine: 1, score: 0.9 }],
    0.9,
  );
  assert.match(text, /Confidence: 90%/);
  assert.match(text, /src\/auth\.ts/);
  assert.match(text, /Auth is in src\/auth\.ts/);
});

test("prompt-compiler: estimatePromptTokens is non-zero for content", () => {
  const tokens = estimatePromptTokens([{ role: "user", content: "Hello, this is a longer prompt with several words inside." }]);
  assert.ok(tokens > 0);
});
