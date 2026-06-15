import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkbenchServer } from "../apps/api/src/server.ts";
import { createStore, initializeStore } from "../packages/db/src/store.ts";

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
    ].join("\n")
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
    const projectRes = await ctx.request("POST", "/projects", {
      path: join(ctx.workspace, "repo"),
      name: "repo",
    });
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
    const prompts = JSON.parse(promptsRes.body) as {
      data: Array<{ id: string; sessionId: string | null }>;
    };
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
        .prepare(
          "SELECT parent_session_id, child_session_id, source_session_id FROM session_replays WHERE child_session_id = ?"
        )
        .get(replay.data.childSession.id) as
        | { parent_session_id: string; child_session_id: string; source_session_id: string | null }
        | undefined;
      assert.ok(row);
      assert.equal(row!.parent_session_id, ask.data.sessionId);
      assert.equal(row!.child_session_id, replay.data.childSession.id);

      // 400: missing info
      const promptLabBadRes = await ctx.request("POST", "/prompt-lab/run", {
        projectId: project.data.id,
        modelProfileIds: [],
      });
      assert.equal(promptLabBadRes.statusCode, 400);

      // 400: > 3 profiles
      const promptLabTooManyRes = await ctx.request("POST", "/prompt-lab/run", {
        projectId: project.data.id,
        promptId: prompts.data[0].id,
        modelProfileIds: ["1", "2", "3", "4"],
      });
      assert.equal(promptLabTooManyRes.statusCode, 400);

      // 404: unknown project
      const promptLabUnknownProjectRes = await ctx.request("POST", "/prompt-lab/run", {
        projectId: "unknown-proj-123",
        promptId: prompts.data[0].id,
        modelProfileIds: ["ask-fast-local"],
      });
      assert.equal(promptLabUnknownProjectRes.statusCode, 404);

      // 404: unknown prompt
      const promptLabUnknownPromptRes = await ctx.request("POST", "/prompt-lab/run", {
        projectId: project.data.id,
        promptId: "unknown-prompt-123",
        modelProfileIds: ["ask-fast-local"],
      });
      assert.equal(promptLabUnknownPromptRes.statusCode, 404);

      const promptLabRes = await ctx.request("POST", "/prompt-lab/run", {
        projectId: project.data.id,
        promptId: prompts.data[0].id,
        modelProfileIds: ["ask-fast-local", "ask-cloud-router"],
        notes: "compare local vs blocked cloud",
      });
      assert.equal(promptLabRes.statusCode, 200);
      console.log("[TEST] body length:", promptLabRes.body.length, "body start:", promptLabRes.body.slice(0, 100), "body end:", promptLabRes.body.slice(-200));
      const promptLab = JSON.parse(promptLabRes.body) as {
        data: {
          run: { id: string; projectId: string; promptId: string; selectedProfiles: string[] };
          results: Array<{
            profileId: string;
            status: string;
            latencyMs: number;
            promptTokens: number;
          }>;
        };
      };
      assert.equal(promptLab.data.run.projectId, project.data.id);
      console.log("[TEST] parsed.data keys:", Object.keys(promptLab.data), "results length:", promptLab.data.results?.length, "results is array:", Array.isArray(promptLab.data.results));
      assert.ok(promptLab.data.results.length >= 2);
      assert.ok(
        promptLab.data.results.some(
          (result) => result.profileId === "ask-fast-local" && (result.status === "ok" || result.status === "fallback")
        )
      );
      assert.ok(
        promptLab.data.results.some((result) => result.profileId === "ask-cloud-router" && result.status === "blocked")
      );

      // 400: invalid messages_json (insert a bad prompt directly)
      const badPromptId = "bad-prompt-json";
      verifier.db
        .prepare(
          "INSERT INTO compiled_prompts (id, session_id, mode, role, messages_json, estimated_tokens, included_context_json, omitted_context_json, safety_notes_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(badPromptId, ask.data.sessionId, "answer", "answer", "not valid json", 0, "[]", "[]", "{}", "2026-01-01");
      const badJsonRes = await ctx.request("POST", "/prompt-lab/run", {
        projectId: project.data.id,
        promptId: badPromptId,
        modelProfileIds: ["ask-fast-local"],
      });
      assert.equal(badJsonRes.statusCode, 400);

      // 400: messages_json is not an array
      verifier.db
        .prepare("UPDATE compiled_prompts SET messages_json = ? WHERE id = ?")
        .run('{"role":"user","content":"hi"}', badPromptId);
      const notArrayRes = await ctx.request("POST", "/prompt-lab/run", {
        projectId: project.data.id,
        promptId: badPromptId,
        modelProfileIds: ["ask-fast-local"],
      });
      assert.equal(notArrayRes.statusCode, 400);

      // 400: messages_json has invalid message
      verifier.db
        .prepare("UPDATE compiled_prompts SET messages_json = ? WHERE id = ?")
        .run('[{"role":"invalid","content":"test"}]', badPromptId);
      const badMsgRes = await ctx.request("POST", "/prompt-lab/run", {
        projectId: project.data.id,
        promptId: badPromptId,
        modelProfileIds: ["ask-fast-local"],
      });
      assert.equal(badMsgRes.statusCode, 400);

      // Profile ID normalization: trimming and deduplication
      const normRes = await ctx.request("POST", "/prompt-lab/run", {
        projectId: project.data.id,
        promptId: prompts.data[0].id,
        modelProfileIds: ["  ask-fast-local  ", "ask-fast-local", "ask-cloud-router"],
      });
      assert.equal(normRes.statusCode, 200);
      const normBody = JSON.parse(normRes.body) as {
        data: { results: Array<{ profileId: string }> };
      };
      const normProfileIds = normBody.data.results.map((r) => r.profileId);
      assert.equal(new Set(normProfileIds).size, normProfileIds.length, "deduped profile IDs");
      assert.ok(normProfileIds.includes("ask-fast-local"), "trimmed and preserved");
      assert.ok(normProfileIds.includes("ask-cloud-router"), "normal preserved");
    } finally {
      verifier.db.close();
    }
  } finally {
    await ctx.close();
  }
});
