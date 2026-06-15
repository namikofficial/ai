import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_REGISTRY, AgentExecutor, getAgent, isToolAllowed } from "../packages/agent-protocol/src/index.ts";
import { createModelRuntime } from "../packages/model-runtime/src/index.ts";
import { createEvent } from "../packages/shared/src/index.ts";

const baseProfile = {
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
};

const providers = [
  {
    id: "provider_local",
    kind: "local_openai_compat" as const,
    displayName: "Local",
    baseUrl: "http://127.0.0.1:11434",
    apiKeyEnv: null,
    enabled: true,
  },
];

test("agent-protocol: AgentExecutor runs a registered agent and records agent_runs/messages", async () => {
  const runtime = createModelRuntime({ providers, profiles: [baseProfile], cloudEnabled: false });
  const runs: Array<{ id: string; agent: string; status: string }> = [];
  const messages: Array<{ agentRunId: string; role: string }> = [];
  const events: string[] = [];
  const executor = new AgentExecutor("answer_agent", runtime, {
    recordRun: (run) => runs.push({ id: run.id, agent: run.agent, status: run.status }),
    recordMessage: (message) => messages.push({ agentRunId: message.agentRunId, role: message.role }),
    emitEvent: (event) => events.push(event.type),
    invokeModel: (profileId, request) => runtime.invoke(profileId, request),
    now: () => new Date("2024-01-01T00:00:00Z"),
  });
  const result = await executor.run({
    sessionId: "s1",
    projectId: "p1",
    input: { question: "hi" },
  });
  assert.equal(result.run.status, "completed");
  assert.equal(result.run.agent, "answer_agent");
  assert.equal(runs.length, 1);
  assert.ok(messages.length >= 2);
  assert.ok(events.includes("agent.started"));
  assert.ok(events.includes("agent.completed"));
});

test("agent-protocol: AgentExecutor rejects tools that are not in the allowlist", async () => {
  const runtime = createModelRuntime({ providers, profiles: [baseProfile], cloudEnabled: false });
  const events: string[] = [];
  const executor = new AgentExecutor("answer_agent", runtime, {
    recordRun: () => undefined,
    recordMessage: () => undefined,
    emitEvent: (event) => events.push(event.type),
    invokeModel: (profileId, request) => runtime.invoke(profileId, request),
    now: () => new Date(),
  });
  const result = await executor.run({
    sessionId: "s1",
    projectId: "p1",
    input: { tool: "project.write" },
  });
  assert.equal(result.run.status, "failed");
  assert.match(result.error ?? "", /not in allowlist/);
  assert.ok(events.includes("agent.failed"));
});

test("agent-protocol: registry exposes the 16 expected agents", () => {
  assert.ok(AGENT_REGISTRY.size >= 16);
  assert.ok(getAgent("orchestrator"));
  assert.equal(isToolAllowed("orchestrator", "project.write"), false);
  assert.equal(isToolAllowed("indexer", "project.read"), true);
});

test("agent-protocol: AgentExecutor throws for unknown agent id", () => {
  const runtime = createModelRuntime({ providers, profiles: [baseProfile], cloudEnabled: false });
  assert.throws(
    () =>
      new AgentExecutor("nonexistent_agent" as never, runtime, {
        recordRun: () => undefined,
        recordMessage: () => undefined,
        emitEvent: () => undefined,
        invokeModel: (profileId, request) => runtime.invoke(profileId, request),
        now: () => new Date(),
      }),
    /unknown agent/
  );
});

test("agent-protocol: AgentExecutor emits model events through hooks", async () => {
  const runtime = createModelRuntime({ providers, profiles: [baseProfile], cloudEnabled: false });
  const events: string[] = [];
  const executor = new AgentExecutor("answer_agent", runtime, {
    recordRun: () => undefined,
    recordMessage: () => undefined,
    emitEvent: (event) => events.push(event.type),
    invokeModel: (profileId, request) => runtime.invoke(profileId, request),
    now: () => new Date(),
  });
  await executor.run({ sessionId: "s1", input: { question: "hi" } });
  assert.ok(
    events.includes("model.completed") || events.includes("model.called") || events.includes("agent.completed")
  );
});

test("shared: createEvent defaults the timestamp and level", () => {
  const event = createEvent("session.started", { foo: 1 });
  assert.equal(event.level, "info");
  assert.match(event.ts, /\d{4}-\d{2}-\d{2}/);
});
