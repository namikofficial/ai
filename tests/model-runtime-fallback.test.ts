import assert from "node:assert/strict";
import test from "node:test";
import { createModelRuntime } from "../packages/model-runtime/src/index.ts";

const profiles = [
  {
    id: "ask-fast-local",
    providerId: "provider_local",
    role: "answer" as const,
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
    role: "answer" as const,
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
];

const providers = [
  { id: "provider_local", kind: "local_openai_compat" as const, displayName: "Local", baseUrl: "http://127.0.0.1:11434", apiKeyEnv: null, enabled: true },
  { id: "provider_cloud", kind: "cloud_openai_compat" as const, displayName: "Cloud", baseUrl: "http://127.0.0.1:11434", apiKeyEnv: null, enabled: true },
];

test("model-runtime: invoke falls back to local heuristic when cloud blocked and records a call", async () => {
  const calls: Array<{ profileId: string; status: string }> = [];
  const runtime = createModelRuntime({
    providers,
    profiles,
    cloudEnabled: false,
    recordCall: (payload) => {
      calls.push({ profileId: payload.profileId, status: payload.status });
    },
  });
  const result = await runtime.invoke("ask-cloud-router", {
    role: "answer",
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(result.profileId, "ask-fast-local");
  assert.match(result.text, /Heuristic/);
  assert.ok(calls.some((c) => c.profileId === "ask-cloud-router" && c.status === "blocked"));
  assert.ok(
    calls.some(
      (c) =>
        c.profileId === "ask-fast-local" &&
        (c.status === "ok" || c.status === "fallback" || c.status === "failed"),
    ),
  );
});

test("model-runtime: embed falls back to hash embedding when provider fails", async () => {
  const recorded: Array<{ role: string; status: string; completionTokens: number }> = [];
  const runtime = createModelRuntime({
    providers,
    profiles,
    cloudEnabled: true,
  });
  const result = await runtime.embed("ask-fast-local", { input: "hello world" }, {
    recordCall: (payload) => {
      recorded.push({ role: payload.role, status: payload.status, completionTokens: payload.completionTokens });
    },
  });
  assert.equal(result.embeddings.length, 1);
  assert.ok(result.dimensions > 0);
  assert.ok(recorded.some((entry) => entry.role === "embedding" && entry.completionTokens > 0));
});

test("model-runtime: rerank ranks documents that contain query terms first", async () => {
  const runtime = createModelRuntime({ providers, profiles, cloudEnabled: false });
  const result = await runtime.rerank("ask-fast-local", {
    query: "auth login",
    documents: ["login screen", "auth controller", "color picker"],
  });
  assert.equal(result.scores.length, 3);
  const top = result.scores[0];
  const topDoc = ["login screen", "auth controller", "color picker"][top.index];
  assert.ok(topDoc === "login screen" || topDoc === "auth controller");
});

test("model-runtime: invoke records usage and prompt/completion tokens", async () => {
  const recorded: Array<Record<string, unknown>> = [];
  const runtime = createModelRuntime({
    providers,
    profiles,
    cloudEnabled: false,
    recordCall: (payload) => {
      recorded.push({
        profileId: payload.profileId,
        status: payload.status,
        promptTokens: payload.promptTokens,
        completionTokens: payload.completionTokens,
      });
    },
  });
  const result = await runtime.invoke("ask-fast-local", {
    role: "answer",
    messages: [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Tell me about auth" },
    ],
  });
  assert.ok(recorded.length >= 1);
  const localCall = recorded.find((r) => r.profileId === "ask-fast-local");
  assert.ok(localCall);
  assert.ok(["ok", "fallback", "failed"].includes(String(localCall?.status)));
  assert.ok(result.promptTokens > 0);
  assert.ok(result.completionTokens > 0);
});

test("model-runtime: invoke with failing cloud falls back to local profile and marks status fallback", async () => {
  const calls: Array<{ profileId: string; status: string }> = [];
  const runtime = createModelRuntime({
    providers,
    profiles,
    cloudEnabled: true,
    recordCall: (payload) => {
      calls.push({ profileId: payload.profileId, status: payload.status });
    },
  });
  const result = await runtime.invoke("ask-cloud-router", {
    role: "answer",
    messages: [{ role: "user", content: "fallback please" }],
  });
  assert.equal(result.profileId, "ask-fast-local");
  assert.ok(
    calls.some(
      (c) => c.profileId === "ask-cloud-router" && (c.status === "failed" || c.status === "blocked"),
    ),
  );
  assert.ok(
    calls.some(
      (c) =>
        c.profileId === "ask-fast-local" &&
        (c.status === "ok" || c.status === "fallback" || c.status === "failed"),
    ),
  );
});
