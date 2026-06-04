import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeStore, createStore } from "../packages/db/src/store.ts";
import { startWorkbenchServer } from "../apps/api/src/server.ts";

async function startTestServer(): Promise<{
  workspace: string;
  request: (method: string, url: string, body?: unknown) => Promise<{ statusCode: number; body: string }>;
  close: () => Promise<void>;
}> {
  const workspace = await mkdtemp(join(tmpdir(), "ai-trace-lab-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(
    join(repo, "src", "auth.ts"),
    [
      "export function handleLogin() {",
      "  return { route: '/api/auth/login' };",
      "}",
      "",
      "export const authNote = 'auth is handled here';",
    ].join("\n"),
  );

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
    request: async (method: string, url: string, body?: unknown) => handle.inject({ method, url, body }),
    close: async () => {
      await handle.close();
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

test("timeline, replay, and prompt lab endpoints are replayable and local-first", async () => {
  const ctx = await startTestServer();
  try {
    const projectRes = await ctx.request("POST", "/projects", { path: join(ctx.workspace, "repo"), name: "repo" });
    assert.equal(projectRes.statusCode, 200);
    const project = JSON.parse(projectRes.body) as { data: { id: string } };

    const indexRes = await ctx.request("POST", `/projects/${project.data.id}/index`, {});
    assert.equal(indexRes.statusCode, 200);

    const askRes = await ctx.request("POST", "/ask", {
      project: project.data.id,
      question: "where is auth handled?",
      mode: "local",
      depth: "standard",
    });
    assert.equal(askRes.statusCode, 200);
    const ask = JSON.parse(askRes.body) as { data: { sessionId: string } };

    const timelineRes = await ctx.request("GET", `/sessions/${ask.data.sessionId}/timeline`);
    assert.equal(timelineRes.statusCode, 200);
    const timeline = JSON.parse(timelineRes.body) as {
      data: {
        session: { id: string };
        items: Array<{ kind: string; ts: string; payload: unknown }>;
      };
    };
    assert.equal(timeline.data.session.id, ask.data.sessionId);
    assert.ok(timeline.data.items.length > 0);
    const kinds = new Set(timeline.data.items.map((item) => item.kind));
    assert.ok(kinds.has("event"));
    assert.ok(kinds.has("model_call"));
    assert.ok(kinds.has("compiled_prompt"));
    assert.ok(kinds.has("retrieval_query"));

    const promptsRes = await ctx.request("GET", `/prompts?sessionId=${ask.data.sessionId}`);
    assert.equal(promptsRes.statusCode, 200);
    const prompts = JSON.parse(promptsRes.body) as { data: Array<{ id: string; sessionId: string | null }> };
    assert.ok(prompts.data.length > 0);

    const replayRes = await ctx.request("POST", `/sessions/${ask.data.sessionId}/replay`, {
      selectedPromptId: prompts.data[0].id,
      modelProfileId: "ask-fast-local",
      editedUserRequest: "where is auth handled in the replay?",
    });
    assert.equal(replayRes.statusCode, 200);
    const replay = JSON.parse(replayRes.body) as {
      data: {
        parentSessionId: string;
        childSession: { id: string; projectId: string | null };
        replay: { result: { sessionId: string } };
      };
    };
    assert.equal(replay.data.parentSessionId, ask.data.sessionId);
    assert.notEqual(replay.data.childSession.id, ask.data.sessionId);
    assert.equal(replay.data.replay.result.sessionId, replay.data.childSession.id);

    const verifier = createStore(initializeStore(join(ctx.workspace, "ai.db")));
    try {
      const row = verifier.db
        .prepare("SELECT parent_session_id, child_session_id, source_session_id FROM session_replays WHERE child_session_id = ?")
        .get(replay.data.childSession.id) as { parent_session_id: string; child_session_id: string; source_session_id: string | null } | undefined;
      assert.ok(row);
      assert.equal(row!.parent_session_id, ask.data.sessionId);
      assert.equal(row!.child_session_id, replay.data.childSession.id);
    } finally {
      verifier.db.close();
    }

    const promptLabRes = await ctx.request("POST", "/prompt-lab/run", {
      projectId: project.data.id,
      promptId: prompts.data[0].id,
      modelProfileIds: ["ask-fast-local", "ask-cloud-router"],
      notes: "compare local vs blocked cloud",
    });
    assert.equal(promptLabRes.statusCode, 200);
    const promptLab = JSON.parse(promptLabRes.body) as {
      data: {
        run: { id: string; projectId: string; promptId: string; selectedProfiles: string[] };
        results: Array<{ profileId: string; status: string; latencyMs: number; promptTokens: number }>;
      };
    };
    assert.equal(promptLab.data.run.projectId, project.data.id);
    assert.ok(promptLab.data.results.length >= 2);
    assert.ok(promptLab.data.results.some((result) => result.profileId === "ask-fast-local" && result.status === "ok"));
    assert.ok(promptLab.data.results.length >= 1);
    assert.ok(promptLab.data.results.some((result) => result.profileId === "ask-cloud-router"));
;
  } finally {
    await ctx.close();
  }
});
