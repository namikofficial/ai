import assert from "node:assert/strict";
import test from "node:test";
import { buildAnswer, createModelRuntime, selectModelProfile } from "../packages/model-runtime/src/index.ts";

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

test("model-runtime: routes locally and blocks cloud when disabled", async () => {
  const runtime = createModelRuntime({
    providers: [
      { id: "provider_local", kind: "local_openai_compat", displayName: "Local", baseUrl: "http://127.0.0.1:11434", apiKeyEnv: null, enabled: true },
      { id: "provider_cloud", kind: "cloud_openai_compat", displayName: "Cloud", baseUrl: "http://127.0.0.1:11434", apiKeyEnv: null, enabled: true },
    ],
    profiles: [
      {
        id: "ask-fast-local",
        providerId: "provider_local",
        role: "answer",
        modelName: "ask-fast-local",
        displayName: null,
        contextWindow: 8192,
        maxOutputTokens: 2048,
        localOnly: true,
        enabled: true,
        fallbackProfileId: null,
        qualityScore: 0.7,
        latencyScore: 0.8,
        costScore: 0.9,
        meta: {},
        createdAt: "2024-01-01",
        updatedAt: "2024-01-01",
      },
      {
        id: "ask-cloud-router",
        providerId: "provider_cloud",
        role: "answer",
        modelName: "ask-cloud-router",
        displayName: null,
        contextWindow: 8192,
        maxOutputTokens: 2048,
        localOnly: false,
        enabled: true,
        fallbackProfileId: "ask-fast-local",
        qualityScore: 0.9,
        latencyScore: 0.5,
        costScore: 0.2,
        meta: {},
        createdAt: "2024-01-01",
        updatedAt: "2024-01-01",
      },
    ],
    cloudEnabled: false,
  });

  const localDecision = runtime.route({ role: "answer", mode: "local", cloudEnabled: false });
  assert.equal(localDecision.profileId, "ask-fast-local");
  assert.equal(localDecision.blocked, false);

  const cloudDecision = runtime.route({ role: "answer", mode: "cloud", cloudEnabled: false });
  assert.equal(cloudDecision.profileId, null);
  assert.equal(cloudDecision.blocked, true);
  assert.equal(cloudDecision.fallbackProfileId, "ask-fast-local");

  const health = await runtime.health();
  assert.equal(health.length, 2);
  assert.equal(health[1].status, "disabled");
});
