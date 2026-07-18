import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkbenchServer } from "../apps/api/src/server.ts";
import { resolveConfig } from "../packages/config/src/index.ts";
import { createStore, initializeStore } from "../packages/db/src/store.ts";

test("shared sessions: create, append, preview, close, and resume through canonical storage", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-shared-session-api-"));
  const projectPath = join(workspace, "project");
  await mkdir(projectPath);
  const config = resolveConfig({ databasePath: join(workspace, "ai.db"), runtimeDir: join(workspace, "runtime") });
  const store = createStore(initializeStore(config.databasePath));
  const project = store.createProject({ path: projectPath, name: "Shared Session Project" });
  const handle = await startWorkbenchServer({ config, store, inProcess: true });

  try {
    const missingProject = await handle.inject({
      method: "POST",
      url: "/sessions",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: { projectId: "missing", title: "No", userGoal: "No" },
    });
    assert.equal(missingProject.statusCode, 404);

    const invalidSession = await handle.inject({
      method: "POST",
      url: "/sessions",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: { projectId: project.id, title: "", userGoal: "No" },
    });
    assert.equal(invalidSession.statusCode, 400);
    assert.match(invalidSession.body, /title is required/);

    const created = await handle.inject({
      method: "POST",
      url: "/sessions",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: {
        projectId: project.id,
        title: "Desktop and browser session",
        userGoal: "Keep every client on the same project context",
        mode: "local",
        source: "test-client",
      },
    });
    assert.equal(created.statusCode, 201);
    const session = (JSON.parse(created.body) as { data: { id: string; projectId: string } }).data;
    assert.equal(session.projectId, project.id);

    const appended = await handle.inject({
      method: "POST",
      url: `/sessions/${session.id}/messages`,
      headers: { accept: "application/json", "content-type": "application/json" },
      body: {
        role: "user",
        content: "Explain the active context and stale index. Never expose ghp_12345678901234567890.",
        metadata: { client: "cli" },
      },
    });
    assert.equal(appended.statusCode, 201);
    const message = (JSON.parse(appended.body) as { data: { id: string; projectId: string } }).data;
    assert.equal(message.projectId, project.id);

    const invalidRole = await handle.inject({
      method: "POST",
      url: `/sessions/${session.id}/messages`,
      headers: { accept: "application/json", "content-type": "application/json" },
      body: { role: "system", content: "Clients cannot inject system messages." },
    });
    assert.equal(invalidRole.statusCode, 400);

    const messages = await handle.inject({
      method: "GET",
      url: `/sessions/${session.id}/messages`,
      headers: { accept: "application/json" },
    });
    assert.equal(messages.statusCode, 200);
    assert.equal((JSON.parse(messages.body) as { data: unknown[] }).data.length, 1);

    const preview = await handle.inject({
      method: "GET",
      url: `/sessions/${session.id}/context?tokenBudget=1000`,
      headers: { accept: "application/json" },
    });
    assert.equal(preview.statusCode, 200);
    const context = JSON.parse(preview.body) as {
      data: {
        schemaVersion: number;
        tokenBudget: number;
        estimatedTokens: number;
        included: Array<{ kind: string; reason: string }>;
        index: { stale: boolean };
        warnings: string[];
      };
    };
    assert.equal(context.data.schemaVersion, 1);
    assert.equal(context.data.tokenBudget, 1000);
    assert.ok(context.data.estimatedTokens <= context.data.tokenBudget);
    assert.ok(context.data.included.some((item) => item.kind === "session"));
    assert.ok(context.data.included.some((item) => item.kind === "message"));
    assert.equal(context.data.index.stale, true);
    assert.ok(context.data.warnings.includes("Project index is stale"));
    assert.ok(context.data.warnings.some((warning) => warning.startsWith("Redacted ")));
    assert.doesNotMatch(preview.body, /ghp_12345678901234567890/);
    assert.match(preview.body, /\[REDACTED:github_token\]/);

    const closed = await handle.inject({
      method: "POST",
      url: `/sessions/${session.id}/close`,
      headers: { accept: "application/json", "content-type": "application/json" },
      body: { status: "completed", summary: "Context API verified" },
    });
    assert.equal((JSON.parse(closed.body) as { data: { status: string } }).data.status, "completed");

    const resumed = await handle.inject({
      method: "POST",
      url: `/sessions/${session.id}/resume`,
      headers: { accept: "application/json" },
    });
    assert.equal((JSON.parse(resumed.body) as { data: { status: string } }).data.status, "running");
    assert.ok(store.listEvents(session.id, 20).some((event) => event.type === "session.message_appended"));
  } finally {
    await handle.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
