import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startWorkbenchServer } from "../apps/api/src/server.ts";

async function startTestServer(): Promise<{
  baseUrl: string;
  workspace: string;
  close: () => Promise<void>;
}> {
  const workspace = await mkdtemp(join(tmpdir(), "ai-obs-api-"));
  const repo = join(workspace, "sample");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(
    join(repo, "src", "auth.ts"),
    "export const authNote = 'auth is handled by handleLogin';\nexport function handleLogin() { return { route: '/login' }; }\n",
  );
  await writeFile(join(repo, "README.md"), "# Sample\n\nAuth is in src/auth.ts.");

  const handle = await startWorkbenchServer({
    config: {
      databasePath: join(workspace, "ai.db"),
      runtimeDir: join(workspace, "runtime"),
      apiUrl: "http://127.0.0.1:0",
      webPort: 0,
      apiPort: 0,
    },
  });
  return {
    baseUrl: handle.url,
    workspace,
    close: async () => {
      await handle.close();
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${url} -> ${res.status} ${res.statusText}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

test("observability api: retrieval queries endpoints return populated data", async () => {
  const ctx = await startTestServer();
  try {
    const add = await postJson<{ status: "ok"; data: { id: string; name: string } }>(
      `${ctx.baseUrl}/projects`,
      { path: join(ctx.workspace, "sample"), name: "sample" },
    );
    const projectId = add.data.id;
    await postJson(`${ctx.baseUrl}/projects/${projectId}/index`, {});

    const ask = await postJson<{
      status: "ok";
      data: { sessionId: string; retrievalQueryId: string };
    }>(`${ctx.baseUrl}/ask`, {
      project: projectId,
      question: "where is auth handled?",
      mode: "local",
      depth: "standard",
    });

    const list = await getJson<{
      status: "ok";
      data: Array<{ id: string; originalQuery: string; intent: string }>;
    }>(`${ctx.baseUrl}/retrieval/queries?sessionId=${ask.data.sessionId}`);
    assert.ok(list.data.length >= 1);
    assert.equal(list.data[0].originalQuery, "where is auth handled?");
    assert.ok(["lookup", "explain"].includes(list.data[0].intent));

    const detail = await getJson<{
      status: "ok";
      data: {
        query: { id: string };
        rewrites: Array<{ id: string; terms: string[] }>;
        results: Array<{ id: string; source: string }>;
        selected: Array<{ rank: number; chunkId: string }>;
        misses: Array<{ id: string }>;
      };
    }>(`${ctx.baseUrl}/retrieval/queries/${list.data[0].id}`);
    assert.equal(detail.data.query.id, list.data[0].id);
    assert.ok(detail.data.rewrites.length > 0);
    assert.ok(detail.data.rewrites[0].terms.length > 0);
    assert.ok(detail.data.results.length > 0);
    assert.equal(detail.data.results[0].source, "heuristic");
    assert.ok(detail.data.selected.length > 0);
    assert.equal(detail.data.selected[0].rank, 0);
  } finally {
    await ctx.close();
  }
});

test("observability api: conversations and agent runs expose full session trace", async () => {
  const ctx = await startTestServer();
  try {
    const add = await postJson<{ status: "ok"; data: { id: string } }>(`${ctx.baseUrl}/projects`, {
      path: join(ctx.workspace, "sample"),
      name: "sample",
    });
    await postJson(`${ctx.baseUrl}/projects/${add.data.id}/index`, {});
    const ask = await postJson<{ status: "ok"; data: { sessionId: string } }>(`${ctx.baseUrl}/ask`, {
      project: add.data.id,
      question: "where is auth handled?",
      mode: "local",
      depth: "shallow",
    });

    const messages = await getJson<{
      status: "ok";
      data: Array<{ role: string; content: string }>;
    }>(`${ctx.baseUrl}/conversations/${ask.data.sessionId}`);
    assert.equal(messages.data.length, 2);
    assert.equal(messages.data[0].role, "user");
    assert.equal(messages.data[1].role, "assistant");

    const runs = await getJson<{
      status: "ok";
      data: Array<{ agent: string; status: string; modelRole: string }>;
    }>(`${ctx.baseUrl}/agents/runs?sessionId=${ask.data.sessionId}`);
    const agents = new Set(runs.data.map((r) => r.agent));
    assert.ok(agents.has("retrieval_agent"));
    assert.ok(agents.has("answer_agent"));
    for (const run of runs.data) {
      assert.equal(run.status, "completed");
    }

    const handoffs = await getJson<{ status: "ok"; data: Array<unknown> }>(
      `${ctx.baseUrl}/agents/handoffs?sessionId=${ask.data.sessionId}`,
    );
    assert.equal(handoffs.data.length, 0);
  } finally {
    await ctx.close();
  }
});

test("observability api: memory candidate accept/reject lifecycle via HTTP", async () => {
  const ctx = await startTestServer();
  try {
    const add = await postJson<{ status: "ok"; data: { id: string } }>(`${ctx.baseUrl}/projects`, {
      path: join(ctx.workspace, "sample"),
      name: "sample",
    });
    const projectId = add.data.id;
    await postJson(`${ctx.baseUrl}/projects/${projectId}/index`, {});

    // Force a workflow_lesson candidate by asking, then listing candidates.
    await postJson(`${ctx.baseUrl}/ask`, {
      project: projectId,
      question: "explain the auth flow",
      mode: "local",
      depth: "standard",
    });
    const initial = await getJson<{
      status: "ok";
      data: Array<{ id: string; kind: string; status: string }>;
    }>(`${ctx.baseUrl}/memory/candidates?status=pending&projectId=${projectId}`);
    assert.ok(initial.data.length >= 1);
    const target = initial.data[0];

    const accepted = await postJson<{ status: "ok"; data: { candidateId: string } }>(
      `${ctx.baseUrl}/memory/candidates/${target.id}/accept`,
      { notes: "looks good" },
    );
    assert.equal(accepted.data.candidateId, target.id);

    const entries = await getJson<{ status: "ok"; data: Array<{ candidateId: string }> }>(
      `${ctx.baseUrl}/memory/entries`,
    );
    assert.ok(entries.data.some((e) => e.candidateId === target.id));

    // Reject a new candidate.
    const rejectTarget = (await getJson<{
      status: "ok";
      data: Array<{ id: string }>;
    }>(`${ctx.baseUrl}/memory/candidates?status=pending&projectId=${projectId}`)).data[0];
    if (rejectTarget) {
      const rejected = await postJson<{ status: "ok"; data: { status: string } }>(
        `${ctx.baseUrl}/memory/candidates/${rejectTarget.id}/reject`,
        { reason: "not actionable" },
      );
      assert.equal(rejected.data.status, "rejected");
    }
  } finally {
    await ctx.close();
  }
});

test("observability api: models, skills, context, eval endpoints respond cleanly", async () => {
  const ctx = await startTestServer();
  try {
    const providers = await getJson<{ status: "ok"; data: { providers: unknown[]; profiles: unknown[] } }>(
      `${ctx.baseUrl}/models/providers`,
    );
    assert.ok(Array.isArray(providers.data.providers));
    assert.ok(Array.isArray(providers.data.profiles));

    const health = await getJson<{ status: "ok"; data: { providers: unknown[]; recentCalls: unknown[] } }>(
      `${ctx.baseUrl}/models/health`,
    );
    assert.ok(Array.isArray(health.data.providers));
    assert.ok(Array.isArray(health.data.recentCalls));

    const skills = await getJson<{ status: "ok"; data: unknown[] }>(`${ctx.baseUrl}/skills`);
    assert.ok(Array.isArray(skills.data));

    const skillsPending = await getJson<{ status: "ok"; data: unknown[] }>(
      `${ctx.baseUrl}/skills/candidates?status=pending`,
    );
    assert.ok(Array.isArray(skillsPending.data));

    const evalCases = await getJson<{ status: "ok"; data: unknown[] }>(`${ctx.baseUrl}/eval/cases`);
    assert.ok(Array.isArray(evalCases.data));

    const created = await postJson<{
      status: "ok";
      data: { id: string; question: string; expectedAnswerContains: string };
    }>(`${ctx.baseUrl}/eval/cases`, {
      projectId: "unknown-project-id",
      question: "what does handleLogin do?",
      expectedAnswerContains: "login",
    });
    assert.ok(created.data.id);
    assert.equal(created.data.question, "what does handleLogin do?");

    const outcomes = await getJson<{ status: "ok"; data: unknown[] }>(`${ctx.baseUrl}/eval/outcomes`);
    assert.ok(Array.isArray(outcomes.data));
  } finally {
    await ctx.close();
  }
});

test("observability api: handoff records context pack, agent run, and handoff row", async () => {
  const ctx = await startTestServer();
  try {
    const add = await postJson<{ status: "ok"; data: { id: string } }>(`${ctx.baseUrl}/projects`, {
      path: join(ctx.workspace, "sample"),
      name: "sample",
    });
    await postJson(`${ctx.baseUrl}/projects/${add.data.id}/index`, {});
    const ask = await postJson<{ status: "ok"; data: { sessionId: string } }>(`${ctx.baseUrl}/ask`, {
      project: add.data.id,
      question: "what is in the auth file?",
      mode: "local",
      depth: "shallow",
    });

    const handoff = await postJson<{ status: "ok"; data: { id: string } }>(`${ctx.baseUrl}/handoff`, {
      sessionId: ask.data.sessionId,
      project: add.data.id,
      target: "opencode",
      subtask: "explain the auth file",
    });
    assert.ok(handoff.data.id);

    const packs = await getJson<{ status: "ok"; data: Array<{ id: string; reason: string }> }>(
      `${ctx.baseUrl}/context/packs?sessionId=${ask.data.sessionId}`,
    );
    assert.ok(packs.data.length >= 1);
    const handoffPack = packs.data.find((p) => p.reason === "handoff:opencode");
    assert.ok(handoffPack);

    const packDetail = await getJson<{ status: "ok"; data: { items: Array<unknown> } }>(
      `${ctx.baseUrl}/context/packs/${handoffPack!.id}`,
    );
    assert.ok(packDetail.data.items.length >= 1);

    const handoffs = await getJson<{ status: "ok"; data: Array<{ toAgent: string }> }>(
      `${ctx.baseUrl}/agents/handoffs?sessionId=${ask.data.sessionId}`,
    );
    assert.equal(handoffs.data.length, 1);
    assert.equal(handoffs.data[0].toAgent, "opencode");
  } finally {
    await ctx.close();
  }
});
