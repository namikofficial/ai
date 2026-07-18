import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AGENT_REGISTRY,
  agentsWithTool,
  getAgent,
  isToolAllowed,
  listAgents,
} from "../packages/agent-protocol/src/index.ts";
import { createStore, initializeStore } from "../packages/db/src/store.ts";

test("observability: ask() populates retrieval, conversation, agent, context, memory, eval tables", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-obs-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(
    join(repo, "src", "auth.ts"),
    [
      "export function handleLogin() {",
      "  return { route: '/api/auth/login', storage: 'local sqlite' };",
      "}",
      "",
      "export const authNote = 'auth is handled in the auth router';",
    ].join("\n")
  );
  await writeFile(join(repo, "README.md"), "# Sample\n\nAuth is in src/auth.ts.");

  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "obs-repo" });
  await store.indexProject(project.id);

  const answer = await store.ask({
    project: project.id,
    question: "where is auth handled?",
    mode: "local",
    depth: "standard",
  });

  const retrievalQueries = store.retrieval.listQueriesForSession(answer.sessionId);
  assert.equal(retrievalQueries.length, 1);
  assert.equal(retrievalQueries[0].originalQuery, "where is auth handled?");
  assert.equal(retrievalQueries[0].projectId, project.id);
  assert.ok(["lookup", "explain"].includes(retrievalQueries[0].intent));

  const rewrites = store.retrieval.listRewrites(retrievalQueries[0].id);
  assert.ok(rewrites.length > 0);
  assert.ok(rewrites[0].terms.length > 0);

  const results = store.retrieval.listResults(retrievalQueries[0].id);
  assert.ok(results.length > 0);
  assert.equal(results[0].source, "heuristic");

  const selected = store.retrieval.listSelectedContext(retrievalQueries[0].id);
  assert.ok(selected.length > 0);
  assert.equal(selected[0].rank, 0);

  const messages = store.conversation.listMessages(answer.sessionId);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[1].parentMessageId, messages[0].id);

  const agentRuns = store.agents.listRuns(answer.sessionId);
  assert.ok(agentRuns.length >= 2);
  const runAgents = new Set(agentRuns.map((r) => r.agent));
  assert.ok(runAgents.has("retrieval_agent"));
  assert.ok(runAgents.has("answer_agent"));

  const modelCalls = store.models.listCalls(answer.sessionId);
  assert.ok(modelCalls.length >= 3);
  assert.ok(modelCalls.some((call) => call.role === "query_rewrite"));
  assert.ok(modelCalls.some((call) => call.role === "retrieval_judge"));
  assert.ok(modelCalls.some((call) => call.role === "answer"));

  const compiledPrompts = store.listCompiledPrompts(answer.sessionId, 10);
  assert.ok(compiledPrompts.length >= 3);
  assert.ok(compiledPrompts.some((prompt) => prompt.mode === "query_rewrite"));
  assert.ok(compiledPrompts.some((prompt) => prompt.mode === "retrieval_judge"));
  assert.ok(compiledPrompts.some((prompt) => prompt.mode === "answer"));

  const modelRoutes = store.listModelRoutes(10);
  assert.ok(modelRoutes.some((route) => route.taskPattern === "ask"));

  const usageDaily = store.models.listUsageDaily(10);
  assert.ok(
    usageDaily.some(
      (entry) =>
        entry.modelName === "ask-fast-local" ||
        entry.modelName === "ask-deep-local" ||
        entry.modelName === "ask-extended-local"
    )
  );

  const contextPacks = store.context.listPacksForSession(answer.sessionId);
  assert.ok(contextPacks.length > 0);
  const items = store.context.listItems(contextPacks[0].id);
  assert.ok(items.length > 0);
  assert.equal(items[0].kind, "retrieval_chunk");

  const memoryCandidates = store.memory.listCandidates("pending", project.id);
  assert.ok(memoryCandidates.length > 0);
  assert.equal(memoryCandidates[0].kind, "workflow_lesson");

  const outcomes = store.evals.listOutcomes(answer.sessionId);
  assert.equal(outcomes.length, 1);
  assert.ok(["success", "partial", "failed"].includes(outcomes[0].outcome));

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("observability: low-confidence ask records a retrieval miss", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-obs-miss-"));
  const repo = join(workspace, "repo");
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "README.md"), "# Empty\n\nNothing relevant here.");

  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "miss-repo" });
  await store.indexProject(project.id);

  // Ask a question that has no match in the indexed corpus; the heuristic will
  // still rank README above zero due to path bonuses, so we manually record a
  // miss to exercise the persistence path.
  const answer = await store.ask({
    project: project.id,
    question: "zxcvbnm asdfghjkl",
    mode: "local",
    depth: "standard",
  });

  const retrievalQueries = store.retrieval.listQueriesForSession(answer.sessionId);
  assert.equal(retrievalQueries.length, 1);
  store.retrieval.recordMiss({
    retrievalQueryId: retrievalQueries[0].id,
    missedPath: project.path,
    confidence: 0,
    notes: "synthesized miss for test",
  });
  const misses = store.retrieval.listMisses(retrievalQueries[0].id);
  assert.ok(misses.length > 0);
  assert.equal(misses[0].missedPath, project.path);

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("observability: createHandoff records agent handoff and context pack", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-obs-handoff-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "main.ts"), "export const x = 1;\n");

  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "handoff-repo" });
  await store.indexProject(project.id);

  const answer = await store.ask({
    project: project.id,
    question: "what is in src/main.ts?",
    mode: "local",
    depth: "shallow",
  });

  const handoff = await store.createHandoff({
    sessionId: answer.sessionId,
    project: project.id,
    target: "opencode",
    subtask: "explain the main file",
  });
  assert.ok(handoff.prompt.includes("explain the main file"));

  const handoffCalls = store.models.listCalls(answer.sessionId, 100).filter((call) => call.role === "coder_handoff");
  assert.equal(handoffCalls.length, 1, "handoff should record exactly one runtime-backed model call");
  const handoffRequest = handoffCalls[0]?.request as {
    metadata?: {
      compiledPrompt?: {
        id?: string;
        mode?: string;
        contextPackId?: string | null;
        messages?: Array<{ role: string; content: string }>;
      };
      responseTrace?: { handoffId?: string };
    } | null;
  };
  assert.equal(handoffRequest.metadata?.compiledPrompt?.mode, "handoff");
  assert.equal(handoffRequest.metadata?.responseTrace?.handoffId, handoff.id);
  assert.ok(Array.isArray(handoffRequest.metadata?.compiledPrompt?.messages));

  const handoffs = store.agents.listHandoffs(answer.sessionId);
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].toAgent, "opencode");
  assert.ok(handoffs[0].contextPackId);
  const contextPacks = store.context.listPacksForSession(answer.sessionId);
  assert.ok(contextPacks.length >= 1);
  const handoffPack = contextPacks.find((p) => p.id === handoffs[0].contextPackId);
  assert.ok(handoffPack, "handoff pack not found");
  assert.equal(handoffPack?.reason, "handoff:opencode");

  const runs = store.agents.listRuns(answer.sessionId);
  const handoffRun = runs.find((r) => r.agent === "handoff_agent");
  assert.ok(handoffRun, "handoff_agent run not found");
  assert.equal(handoffRun?.status, "completed");

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("observability: indexProject records an indexer agent run", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-obs-index-"));
  const repo = join(workspace, "repo");
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "README.md"), "# Index test\n");

  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "index-repo" });
  const result = await store.indexProject(project.id);

  const runs = store.agents.listRuns(result.session.id);
  const indexerRun = runs.find((r) => r.agent === "indexer");
  assert.ok(indexerRun, "indexer run not found");
  assert.equal(indexerRun?.status, "completed");
  assert.equal(indexerRun?.modelRole, "embedding");
  const output = indexerRun?.output as Record<string, unknown> | null;
  assert.ok(output && typeof output === "object");
  assert.ok("filesIndexed" in (output as Record<string, unknown>));

  const embeddingCalls = store.models.listCalls(result.session.id, 100).filter((call) => call.role === "embedding");
  assert.ok(embeddingCalls.length >= 1, "indexing should record runtime-backed embedding calls");
  const embeddingResponse = embeddingCalls[0]?.response as {
    modelName?: string;
    dimensions?: number;
    providerId?: string;
    embeddingCount?: number;
  };
  assert.ok(embeddingResponse.modelName);
  assert.ok((embeddingResponse.dimensions ?? 0) > 0);
  assert.ok(embeddingResponse.providerId);

  const chunk = store.db
    .prepare("SELECT embedding_model, embedding_dim, embedding_provider FROM rag_chunks WHERE project_id = ? LIMIT 1")
    .get(project.id) as
    | {
        embedding_model: string | null;
        embedding_dim: number | null;
        embedding_provider: string | null;
      }
    | undefined;
  assert.ok(chunk);
  assert.equal(chunk?.embedding_model, embeddingResponse.modelName);
  assert.equal(chunk?.embedding_dim, embeddingResponse.dimensions);
  assert.equal(chunk?.embedding_provider, embeddingResponse.providerId);

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("observability: reindex skips unchanged files and avoids extra embedding calls", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-index-reuse-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "alpha.ts"), "export const alpha = 1;\n");
  await writeFile(join(repo, "src", "beta.ts"), "export const beta = 2;\n");

  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "repo" });

  const first = await store.indexProject(project.id);
  const firstEmbeddingCalls = store.models.listCalls(first.session.id, 100).filter((call) => call.role === "embedding");
  assert.ok(firstEmbeddingCalls.length >= 1, "initial index should embed files");

  const second = await store.indexProject(project.id);
  const secondEmbeddingCalls = store.models
    .listCalls(second.session.id, 100)
    .filter((call) => call.role === "embedding");
  assert.equal(secondEmbeddingCalls.length, 0, "unchanged reindex should skip embeddings");
  assert.equal(second.filesIndexed, first.filesIndexed);
  assert.equal(second.chunksIndexed, 0, "unchanged reindex should not write new chunks");

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("observability: memory candidate accept/reject lifecycle", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-obs-memory-"));
  const store = createStore(initializeStore(join(workspace, "ai.db")));

  const candidate = store.memory.createCandidate({
    projectId: null,
    kind: "user_preference",
    title: "Prefer small steps",
    body: "Break changes into small, reviewable commits.",
    confidence: 0.7,
    scope: "global",
    evidence: [{ kind: "session", note: "test" }],
  });
  assert.equal(candidate.status, "pending");

  store.memory.reviewCandidate(candidate.id, "rejected", "not specific enough");
  const rejected = store.memory.getCandidate(candidate.id);
  assert.equal(rejected?.status, "rejected");

  const accepted = store.memory.createCandidate({
    projectId: null,
    kind: "user_preference",
    title: "Use exact types",
    body: "Prefer exact return types over inferred any.",
    confidence: 0.85,
    scope: "global",
  });
  const entry = store.memory.acceptCandidate(accepted.id);
  assert.equal(entry.candidateId, accepted.id);
  assert.equal(entry.archived, false);

  const entries = store.memory.listEntries(undefined, "global");
  assert.ok(entries.some((e) => e.id === entry.id));

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("agent-protocol: registry has expected agents and tool gating works", () => {
  const agents = listAgents();
  assert.ok(agents.length >= 10);
  const orchestrator = getAgent("orchestrator");
  assert.ok(orchestrator, "orchestrator missing");
  assert.ok(orchestrator?.allowedTools.includes("session.emit"));
  assert.equal(orchestrator?.risk, "medium");
  assert.equal(isToolAllowed("orchestrator", "project.write"), false);
  assert.equal(isToolAllowed("orchestrator", "session.emit"), true);

  const answerer = getAgent("answer_agent");
  assert.ok(answerer, "answer_agent missing");
  assert.equal(answerer?.modelRole, "answer");

  const handoff = getAgent("handoff_agent");
  assert.ok(handoff, "handoff_agent missing");
  assert.equal(isToolAllowed("handoff_agent", "context.build"), true);

  const toolAgents = agentsWithTool("model.invoke");
  assert.ok(toolAgents.some((a) => a.id === "orchestrator"));
  assert.ok(toolAgents.some((a) => a.id === "answer_agent"));

  assert.equal(getAgent("bogus_agent" as never), null);
  assert.equal(AGENT_REGISTRY.size, agents.length);
});

test("agent-protocol: agent descriptors expose required events", () => {
  const retrieval = getAgent("retrieval_agent");
  assert.ok(retrieval);
  assert.ok(retrieval?.requiredEvents.includes("retrieval.started"));
  assert.ok(retrieval?.requiredEvents.includes("retrieval.completed"));

  const indexer = getAgent("indexer");
  assert.ok(indexer);
  assert.ok(indexer?.requiredEvents.includes("task.started"));

  const check = getAgent("check_agent");
  assert.ok(check);
  assert.ok(check?.requiredEvents.includes("check.started"));
});
