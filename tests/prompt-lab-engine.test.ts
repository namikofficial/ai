import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import type { CompiledPromptRecord, ModelProfileRecord, ModelProviderRecord, PromptLabResultRecord } from "../packages/shared/src/index.ts";
import type { ModelCallRecordedHook } from "../packages/model-runtime/src/index.ts";
import { normalizeProfileIds, runPromptLab, type PromptLabEngineStore } from "../packages/prompt-lab-engine/src/index.ts";

function makeCompiledPrompt(messagesJson: string): CompiledPromptRecord {
  return {
    id: "prompt-1",
    sessionId: null,
    taskId: null,
    retrievalQueryId: null,
    contextPackId: null,
    mode: "answer",
    role: "answer",
    messagesJson,
    estimatedTokens: 1,
    includedContextJson: "[]",
    omittedContextJson: "[]",
    safetyNotesJson: "{}",
    outputSchemaJson: null,
    createdAt: new Date().toISOString(),
  };
}

function makeProfile(providerId: string, overrides: Partial<ModelProfileRecord> = {}): ModelProfileRecord {
  const ts = new Date().toISOString();
  return {
    id: "profile-1",
    providerId,
    role: "answer",
    modelName: "test-model",
    displayName: "Test Profile",
    contextWindow: 4096,
    maxOutputTokens: 512,
    localOnly: false,
    enabled: true,
    fallbackProfileId: null,
    qualityScore: 1,
    latencyScore: 1,
    costScore: 1,
    meta: {},
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

function makeProvider(overrides: Partial<ModelProviderRecord> = {}): ModelProviderRecord {
  const ts = new Date().toISOString();
  return {
    id: "provider-1",
    kind: "local_openai_compat",
    displayName: "Provider",
    baseUrl: "http://127.0.0.1:1234",
    apiKeyEnv: "PROMPT_LAB_TEST_API_KEY",
    enabled: true,
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

function makeStore(input: {
  compiledPrompt?: CompiledPromptRecord | null;
  profiles?: ModelProfileRecord[];
  providers?: ModelProviderRecord[];
}): PromptLabEngineStore & { __test: { createRunCount: number } } {
  const state = { createRunCount: 0 };
  return {
    getProject(id) {
      return id === "project-1" ? { id: "project-1", path: "/tmp/project", name: "project" } : null;
    },
    getCompiledPrompt(id) {
      return input.compiledPrompt ?? (id === "prompt-1" ? makeCompiledPrompt(JSON.stringify([{ role: "user", content: "hello" }])) : null);
    },
    createRun(run) {
      state.createRunCount += 1;
      const ts = run.createdAt ?? new Date().toISOString();
      return {
        id: run.id,
        sessionId: run.sessionId ?? null,
        projectId: run.projectId,
        promptId: run.promptId,
        mode: run.mode,
        selectedProfiles: run.selectedProfiles,
        notes: run.notes ?? null,
        createdAt: ts,
        updatedAt: run.updatedAt ?? ts,
      };
    },
    createResult(result) {
      return {
        id: result.id,
        runId: result.runId,
        profileId: result.profileId,
        profileName: result.profileName,
        modelName: result.modelName,
        status: result.status as PromptLabResultRecord["status"],
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        latencyMs: result.latencyMs,
        outputText: result.outputText ?? null,
        error: result.error ?? null,
        approxCost: result.approxCost ?? null,
        createdAt: result.createdAt ?? new Date().toISOString(),
      };
    },
    getProfile(id) {
      return (input.profiles ?? [makeProfile("provider-1")]).find((profile) => profile.id === id) ?? null;
    },
    listProfiles() {
      return input.profiles ?? [makeProfile("provider-1")];
    },
    listProviders() {
      return input.providers ?? [makeProvider()];
    },
    __test: state,
  };
}

function getServerPort(server: unknown): number {
  const address = (server as { address: () => { port: number } | string | null }).address();
  if (!address || typeof address === "string") throw new Error("expected server to listen on a TCP port");
  return address.port;
}

test("normalizeProfileIds trims, filters, and dedupes while preserving order", () => {
  assert.deepEqual(normalizeProfileIds(["a", " a ", "b", "", "  ", "b", 3]), ["a", "b", "3"]);
});

test("runPromptLab normalizes profile IDs and validates messages before creating a run", async () => {
  const store = makeStore({ compiledPrompt: makeCompiledPrompt("{\"role\":\"user\",\"content\":\"hello\"}") });
  try {
    await runPromptLab(store, {
      projectId: "project-1",
      promptId: "prompt-1",
      selectedProfiles: ["a", " a ", "b", " "],
      notes: null,
      dryRun: false,
    }, { cloudEnabled: true });
    throw new Error("expected runPromptLab to reject");
  } catch (error) {
    assert.equal((error as { statusCode?: number }).statusCode, 400);
  }
  assert.equal(store.__test.createRunCount, 0);
});

test("runPromptLab rejects empty normalized profile lists before creating a run", async () => {
  const store = makeStore({});
  try {
    await runPromptLab(store, {
      projectId: "project-1",
      promptId: "prompt-1",
      selectedProfiles: [" ", ""],
      notes: null,
      dryRun: false,
    }, { cloudEnabled: true });
    throw new Error("expected runPromptLab to reject");
  } catch (error) {
    assert.equal((error as { statusCode?: number }).statusCode, 400);
  }
});

test("runPromptLab rejects more than three unique profiles after normalization", async () => {
  const store = makeStore({});
  try {
    await runPromptLab(store, {
      projectId: "project-1",
      promptId: "prompt-1",
      selectedProfiles: ["a", " a ", "b", "c", "d"],
      notes: null,
      dryRun: false,
    }, { cloudEnabled: true });
    throw new Error("expected runPromptLab to reject");
  } catch (error) {
    assert.equal((error as { statusCode?: number }).statusCode, 400);
  }
});

test("runPromptLab preserves provider baseUrl and apiKeyEnv and records successful model calls", async () => {
  const requests: Array<{ authorization?: string; url: string }> = [];
  const server = http.createServer((req, res) => {
    requests.push({ authorization: req.headers.authorization, url: req.url ?? "" });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const previousApiKey = process.env.PROMPT_LAB_TEST_API_KEY;
  process.env.PROMPT_LAB_TEST_API_KEY = "secret-key";
  const recordCalls: Array<Parameters<ModelCallRecordedHook>[0]> = [];
  try {
    const result = await runPromptLab(makeStore({
      compiledPrompt: { ...makeCompiledPrompt(JSON.stringify([{ role: "user", content: "hello" }])), sessionId: "session-1" },
      providers: [makeProvider({ baseUrl: `http://127.0.0.1:${getServerPort(server)}`, apiKeyEnv: "PROMPT_LAB_TEST_API_KEY" })],
      profiles: [makeProfile("provider-1")],
    }), {
      projectId: "project-1",
      promptId: "prompt-1",
      selectedProfiles: ["profile-1"],
      notes: null,
      dryRun: false,
    }, { cloudEnabled: true, recordModelCall: (call) => recordCalls.push(call) });

    assert.equal(result.results[0]?.status, "ok");
    assert.equal(requests[0]?.url, "/v1/chat/completions");
    assert.equal(requests[0]?.authorization, "Bearer secret-key");
    assert.equal(recordCalls.length, 1);
    assert.equal(recordCalls[0]?.sessionId, "session-1");
    assert.deepEqual(recordCalls[0]?.request.metadata, { source: "prompt-lab", promptId: "prompt-1", runId: result.run.id });
  } finally {
    if (previousApiKey === undefined) delete process.env.PROMPT_LAB_TEST_API_KEY;
    else process.env.PROMPT_LAB_TEST_API_KEY = previousApiKey;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("runPromptLab records failed model calls", async () => {
  const server = http.createServer((req, res) => {
    void req;
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "boom" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const recordCalls: Array<Parameters<ModelCallRecordedHook>[0]> = [];
  try {
    const result = await runPromptLab(makeStore({
      providers: [makeProvider({ baseUrl: `http://127.0.0.1:${getServerPort(server)}` })],
      profiles: [makeProfile("provider-1")],
    }), {
      projectId: "project-1",
      promptId: "prompt-1",
      selectedProfiles: ["profile-1"],
      notes: null,
      dryRun: false,
    }, { cloudEnabled: true, recordModelCall: (call) => recordCalls.push(call) });

    assert.equal(result.results[0]?.status, "fallback");
    assert.ok(recordCalls.some((call) => call.status === "failed"), "records the failed provider call before fallback");
    assert.ok(recordCalls.some((call) => call.status === "fallback"), "records the fallback call");
    assert.match(recordCalls.find((call) => call.status === "failed")?.error ?? "", /OpenAI-compatible invocation failed/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("runPromptLab blocks cloud providers before invoke when cloud is disabled", async () => {
  const recordCalls: Array<Parameters<ModelCallRecordedHook>[0]> = [];
  const result = await runPromptLab(makeStore({
    providers: [makeProvider({ kind: "cloud_openai_compat" })],
    profiles: [makeProfile("provider-1")],
  }), {
    projectId: "project-1",
    promptId: "prompt-1",
    selectedProfiles: ["profile-1"],
    notes: null,
    dryRun: false,
  }, { cloudEnabled: false, recordModelCall: (call) => recordCalls.push(call) });

  assert.equal(result.results[0]?.status, "blocked");
  assert.equal(result.results[0]?.error, "cloud disabled");
  assert.equal(recordCalls.length, 0);
});
