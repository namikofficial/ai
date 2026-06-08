import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkbenchServer } from "../apps/api/src/server.ts";

async function startTestServer(): Promise<{
  workspace: string;
  request: (
    method: string,
    url: string,
    body?: unknown
  ) => Promise<{ statusCode: number; body: string }>;
  close: () => Promise<void>;
}> {
  const workspace = await mkdtemp(join(tmpdir(), "ai-obs-api-"));
  const repo = join(workspace, "sample");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(
    join(repo, "src", "auth.ts"),
    "export const authNote = 'auth is handled by handleLogin';\nexport function handleLogin() { return { route: '/login' }; }\n"
  );
  await writeFile(join(repo, "README.md"), "# Sample\n\nAuth is in src/auth.ts.");

  const handle = await startWorkbenchServer({
    inProcess: true,
    config: {
      databasePath: join(workspace, "ai.db"),
      runtimeDir: join(workspace, "runtime"),
      apiUrl: "http://127.0.0.1:0",
      webPort: 0,
      apiPort: 0,
    },
  });
  return {
    workspace,
    request: async (method: string, url: string, body?: unknown) =>
      handle.inject({ method, url, body }),
    close: async () => {
      await handle.close();
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

async function getJson<T>(
  request: (
    method: string,
    url: string,
    body?: unknown
  ) => Promise<{ statusCode: number; body: string }>,
  url: string
): Promise<T> {
  const res = await request("GET", url);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`GET ${url} -> ${res.statusCode}`);
  }
  return JSON.parse(res.body) as T;
}

async function postJson<T>(
  request: (
    method: string,
    url: string,
    body?: unknown
  ) => Promise<{ statusCode: number; body: string }>,
  url: string,
  body: unknown
): Promise<T> {
  const res = await request("POST", url, body);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`POST ${url} -> ${res.statusCode}: ${res.body}`);
  }
  return JSON.parse(res.body) as T;
}

test("observability api: retrieval queries endpoints return populated data", async () => {
  const ctx = await startTestServer();
  try {
    const add = await postJson<{ status: "ok"; data: { id: string; name: string } }>(
      ctx.request,
      "/projects",
      { path: join(ctx.workspace, "sample"), name: "sample" }
    );
    const projectId = add.data.id;
    await postJson(ctx.request, `/projects/${projectId}/index`, {});

    const ask = await postJson<{
      status: "ok";
      data: { sessionId: string; retrievalQueryId: string };
    }>(ctx.request, "/ask", {
      project: projectId,
      question: "where is auth handled?",
      mode: "local",
      depth: "standard",
    });

    const list = await getJson<{
      status: "ok";
      data: Array<{ id: string; originalQuery: string; intent: string }>;
    }>(ctx.request, `/retrieval/queries?sessionId=${ask.data.sessionId}`);
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
    }>(ctx.request, `/retrieval/queries/${list.data[0].id}`);
    assert.equal(detail.data.query.id, list.data[0].id);
    assert.ok(detail.data.rewrites.length > 0);
    assert.ok(detail.data.rewrites[0].terms.length > 0);
    assert.ok(detail.data.results.length > 0);
    assert.equal(detail.data.results[0].source, "heuristic");
    assert.ok(detail.data.selected.length > 0);
    assert.equal(detail.data.selected[0].rank, 0);

    const trace = await getJson<{
      status: "ok";
      data: {
        session: { id: string };
        modelCalls: Array<{ role: string }>;
        contextPacks: Array<{ pack: { id: string } }>;
        compiledPrompts: Array<{ id: string; mode: string; role: string }>;
      };
    }>(ctx.request, `/sessions/${ask.data.sessionId}/trace`);
    assert.equal(trace.data.session.id, ask.data.sessionId);
    assert.ok(trace.data.modelCalls.some((call) => call.role === "answer"));
    assert.ok(trace.data.contextPacks.length > 0);
    assert.ok(trace.data.compiledPrompts.length > 0);

    const timeline = await getJson<{
      status: "ok";
      data: {
        session: { id: string };
        timeline: Array<{ id: string; kind: string; ts: string }>;
        items: Array<{ id: string }>;
        counts: {
          messages: number;
          events: number;
          agentRuns: number;
          modelCalls: number;
          compiledPrompts: number;
          retrievalQueries: number;
          contextPacks: number;
          outcomes: number;
        };
      };
    }>(ctx.request, `/sessions/${ask.data.sessionId}/timeline`);
    assert.equal(timeline.data.session.id, ask.data.sessionId);
    assert.ok(Array.isArray(timeline.data.timeline));
    assert.equal(timeline.data.timeline.length, timeline.data.items.length);
    assert.ok(timeline.data.counts.messages >= 2);
    assert.ok(timeline.data.counts.modelCalls >= 1);
    assert.ok(
      timeline.data.timeline.every(
        (item) => typeof item.ts === "string" && typeof item.kind === "string"
      )
    );

    const prompts = await getJson<{
      status: "ok";
      data: Array<{ id: string; sessionId: string | null; mode: string; role: string }>;
    }>(ctx.request, `/prompts?sessionId=${ask.data.sessionId}`);
    assert.ok(prompts.data.length > 0);
    assert.equal(prompts.data[0].sessionId, ask.data.sessionId);

    const promptDetail = await getJson<{
      status: "ok";
      data: { id: string; mode: string; role: string; messagesJson: string };
    }>(ctx.request, `/prompts/${prompts.data[0].id}`);
    assert.equal(promptDetail.data.id, prompts.data[0].id);
    assert.equal(promptDetail.data.mode, prompts.data[0].mode);
    assert.ok(promptDetail.data.messagesJson.includes("system"));
  } finally {
    await ctx.close();
  }
});

test("observability api: health and status expose read-only operational state", async () => {
  const ctx = await startTestServer();
  try {
    const add = await postJson<{ status: "ok"; data: { id: string } }>(ctx.request, "/projects", {
      path: join(ctx.workspace, "sample"),
      name: "sample",
    });
    await postJson(ctx.request, `/projects/${add.data.id}/index`, {});
    await postJson(ctx.request, "/ask", {
      project: add.data.id,
      question: "where is auth handled?",
      mode: "local",
      depth: "standard",
    });

    const health = await getJson<{
      status: "ok";
      data: {
        databaseReachable: boolean;
        migrations: { applied: number };
        projectCount: number;
        sessionCount: number;
        qdrant: { enabled: boolean; url: string | null; collection: string };
        cloudEnabled: boolean;
        modelProviderCount: number;
        promptCount: number;
      };
    }>(ctx.request, "/health");
    assert.equal(health.data.databaseReachable, true);
    assert.ok(health.data.migrations.applied >= 1);
    assert.ok(health.data.projectCount >= 1);
    assert.ok(health.data.sessionCount >= 1);
    assert.equal(typeof health.data.qdrant.enabled, "boolean");
    assert.equal(typeof health.data.cloudEnabled, "boolean");
    assert.ok(health.data.modelProviderCount >= 1);
    assert.ok(health.data.promptCount >= 1);

    const status = await getJson<{
      status: "ok";
      data: {
        health: {
          databaseReachable: boolean;
          migrations: { applied: number };
          projectCount: number;
          sessionCount: number;
        };
        summary: { projects: number; activeSessions: number; sessions: number };
      };
    }>(ctx.request, "/status");
    assert.equal(status.data.health.databaseReachable, true);
    assert.ok(status.data.health.migrations.applied >= 1);
    assert.ok(status.data.summary.projects >= 1);
  } finally {
    await ctx.close();
  }
});

test("observability api: conversations and agent runs expose full session trace", async () => {
  const ctx = await startTestServer();
  try {
    const add = await postJson<{ status: "ok"; data: { id: string } }>(ctx.request, "/projects", {
      path: join(ctx.workspace, "sample"),
      name: "sample",
    });
    await postJson(ctx.request, `/projects/${add.data.id}/index`, {});
    const ask = await postJson<{ status: "ok"; data: { sessionId: string } }>(ctx.request, "/ask", {
      project: add.data.id,
      question: "where is auth handled?",
      mode: "local",
      depth: "shallow",
    });

    const messages = await getJson<{
      status: "ok";
      data: Array<{ role: string; content: string }>;
    }>(ctx.request, `/conversations/${ask.data.sessionId}`);
    assert.equal(messages.data.length, 2);
    assert.equal(messages.data[0].role, "user");
    assert.equal(messages.data[1].role, "assistant");

    const runs = await getJson<{
      status: "ok";
      data: Array<{ agent: string; status: string; modelRole: string }>;
    }>(ctx.request, `/agents/runs?sessionId=${ask.data.sessionId}`);
    const agents = new Set(runs.data.map((r) => r.agent));
    assert.ok(agents.has("retrieval_agent"));
    assert.ok(agents.has("answer_agent"));
    for (const run of runs.data) {
      assert.equal(run.status, "completed");
    }

    const handoffs = await getJson<{ status: "ok"; data: Array<unknown> }>(
      ctx.request,
      `/agents/handoffs?sessionId=${ask.data.sessionId}`
    );
    assert.equal(handoffs.data.length, 0);

    const trace = await getJson<{
      status: "ok";
      data: {
        messages: Array<{ role: string }>;
        retrievalQueries: Array<{ originalQuery: string }>;
        modelCalls: Array<{ role: string }>;
      };
    }>(ctx.request, `/sessions/${ask.data.sessionId}/trace`);
    assert.equal(trace.data.messages.length, 2);
    assert.ok(
      trace.data.retrievalQueries.some((query) => query.originalQuery === "where is auth handled?")
    );
    assert.ok(trace.data.modelCalls.some((call) => call.role === "retrieval_judge"));
  } finally {
    await ctx.close();
  }
});

test("observability api: memory candidate accept/reject lifecycle via HTTP", async () => {
  const ctx = await startTestServer();
  try {
    const add = await postJson<{ status: "ok"; data: { id: string } }>(ctx.request, "/projects", {
      path: join(ctx.workspace, "sample"),
      name: "sample",
    });
    const projectId = add.data.id;
    await postJson(ctx.request, `/projects/${projectId}/index`, {});

    // Force a workflow_lesson candidate by asking, then listing candidates.
    await postJson(ctx.request, "/ask", {
      project: projectId,
      question: "explain the auth flow",
      mode: "local",
      depth: "standard",
    });
    const initial = await getJson<{
      status: "ok";
      data: Array<{ id: string; kind: string; status: string }>;
    }>(ctx.request, `/memory/candidates?status=pending&projectId=${projectId}`);
    assert.ok(initial.data.length >= 1);
    const target = initial.data[0];

    const accepted = await postJson<{ status: "ok"; data: { candidateId: string } }>(
      ctx.request,
      `/memory/candidates/${target.id}/accept`,
      { notes: "looks good" }
    );
    assert.equal(accepted.data.candidateId, target.id);

    const entries = await getJson<{ status: "ok"; data: Array<{ candidateId: string }> }>(
      ctx.request,
      "/memory/entries"
    );
    assert.ok(entries.data.some((e) => e.candidateId === target.id));

    // Reject a new candidate.
    const rejectTarget = (
      await getJson<{
        status: "ok";
        data: Array<{ id: string }>;
      }>(ctx.request, `/memory/candidates?status=pending&projectId=${projectId}`)
    ).data[0];
    if (rejectTarget) {
      const rejected = await postJson<{ status: "ok"; data: { status: string } }>(
        ctx.request,
        `/memory/candidates/${rejectTarget.id}/reject`,
        { reason: "not actionable" }
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
    const providers = await getJson<{
      status: "ok";
      data: { providers: unknown[]; profiles: unknown[] };
    }>(ctx.request, "/models/providers");
    assert.ok(Array.isArray(providers.data.providers));
    assert.ok(Array.isArray(providers.data.profiles));

    const health = await getJson<{
      status: "ok";
      data: { providers: unknown[]; recentCalls: unknown[] };
    }>(ctx.request, "/models/health");
    assert.ok(Array.isArray(health.data.providers));
    assert.ok(Array.isArray(health.data.recentCalls));

    const routed = await postJson<{
      status: "ok";
      data: { route: { taskPattern: string }; profile: { id: string } | null };
    }>(ctx.request, "/models/route", {
      taskPattern: "ask",
      mode: "local",
      question: "where is auth handled?",
    });
    assert.equal(routed.data.route.taskPattern, "ask");
    assert.ok(routed.data.profile);

    const routes = await getJson<{ status: "ok"; data: Array<{ taskPattern: string }> }>(
      ctx.request,
      "/models/routes"
    );
    assert.ok(routes.data.some((route) => route.taskPattern === "ask"));

    const skills = await getJson<{ status: "ok"; data: unknown[] }>(ctx.request, "/skills");
    assert.ok(Array.isArray(skills.data));

    const skillsPending = await getJson<{ status: "ok"; data: unknown[] }>(
      ctx.request,
      "/skills/candidates?status=pending"
    );
    assert.ok(Array.isArray(skillsPending.data));

    const evalCases = await getJson<{ status: "ok"; data: unknown[] }>(ctx.request, "/eval/cases");
    assert.ok(Array.isArray(evalCases.data));

    const created = await postJson<{
      status: "ok";
      data: { id: string; question: string; expectedAnswerContains: string };
    }>(ctx.request, "/eval/cases", {
      projectId: "unknown-project-id",
      question: "what does handleLogin do?",
      expectedAnswerContains: "login",
    });
    assert.ok(created.data.id);
    assert.equal(created.data.question, "what does handleLogin do?");

    const outcomes = await getJson<{ status: "ok"; data: unknown[] }>(
      ctx.request,
      "/eval/outcomes"
    );
    assert.ok(Array.isArray(outcomes.data));
  } finally {
    await ctx.close();
  }
});

test("observability api: handoff records context pack, agent run, and handoff row", async () => {
  const ctx = await startTestServer();
  try {
    const add = await postJson<{ status: "ok"; data: { id: string } }>(ctx.request, "/projects", {
      path: join(ctx.workspace, "sample"),
      name: "sample",
    });
    await postJson(ctx.request, `/projects/${add.data.id}/index`, {});
    const ask = await postJson<{ status: "ok"; data: { sessionId: string } }>(ctx.request, "/ask", {
      project: add.data.id,
      question: "what is in the auth file?",
      mode: "local",
      depth: "shallow",
    });

    const handoff = await postJson<{ status: "ok"; data: { id: string } }>(
      ctx.request,
      "/handoff",
      {
        sessionId: ask.data.sessionId,
        project: add.data.id,
        target: "opencode",
        subtask: "explain the auth file",
      }
    );
    assert.ok(handoff.data.id);

    const packs = await getJson<{ status: "ok"; data: Array<{ id: string; reason: string }> }>(
      ctx.request,
      `/context/packs?sessionId=${ask.data.sessionId}`
    );
    assert.ok(packs.data.length >= 1);
    const handoffPack = packs.data.find((p) => p.reason === "handoff:opencode");
    assert.ok(handoffPack);

    const packDetail = await getJson<{ status: "ok"; data: { items: Array<unknown> } }>(
      ctx.request,
      `/context/packs/${handoffPack!.id}`
    );
    assert.ok(packDetail.data.items.length >= 1);

    const handoffs = await getJson<{ status: "ok"; data: Array<{ toAgent: string }> }>(
      ctx.request,
      `/agents/handoffs?sessionId=${ask.data.sessionId}`
    );
    assert.equal(handoffs.data.length, 1);
    assert.equal(handoffs.data[0].toAgent, "opencode");
  } finally {
    await ctx.close();
  }
});
