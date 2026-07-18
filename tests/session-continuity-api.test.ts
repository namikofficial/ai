import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkbenchServer } from "../apps/api/src/server.ts";
import { resolveConfig } from "../packages/config/src/index.ts";
import { createStore, initializeStore } from "../packages/db/src/store.ts";

function runGit(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (error) => (error ? reject(error) : resolve()));
  });
}

test("shared session continuity: answer becomes plan, run, and memory without changing project scope", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-session-continuity-"));
  const firstPath = join(workspace, "first");
  const secondPath = join(workspace, "second");
  await Promise.all([mkdir(firstPath), mkdir(secondPath)]);
  await writeFile(join(firstPath, "README.md"), "# First\n\nCanonical shared session project.\n");
  await writeFile(join(secondPath, "README.md"), "# Second\n");
  await runGit(firstPath, ["init", "-b", "main"]);
  await runGit(firstPath, ["config", "user.email", "test@example.invalid"]);
  await runGit(firstPath, ["config", "user.name", "Session Test"]);
  await runGit(firstPath, ["add", "README.md"]);
  await runGit(firstPath, ["commit", "-m", "Initial project context"]);
  await appendFile(join(firstPath, "README.md"), "\nChanged context for the active workflow.\n");
  await writeFile(join(firstPath, ".env"), "API_TOKEN=ghp_12345678901234567890\n");
  const config = resolveConfig({ databasePath: join(workspace, "ai.db"), runtimeDir: join(workspace, "runtime") });
  const store = createStore(initializeStore(config.databasePath));
  const firstProject = store.createProject({ path: firstPath, name: "First" });
  const secondProject = store.createProject({ path: secondPath, name: "Second" });
  await store.indexProject(firstProject.id);
  const handle = await startWorkbenchServer({ config, store, inProcess: true });

  const post = (url: string, body: Record<string, unknown>) =>
    handle.inject({
      method: "POST",
      url,
      headers: { accept: "application/json", "content-type": "application/json" },
      body,
    });

  try {
    const created = await post("/sessions", {
      projectId: firstProject.id,
      title: "One continuous job",
      userGoal: "Understand, plan, and implement the project change",
      source: "integration-test",
    });
    const sessionId = (JSON.parse(created.body) as { data: { id: string } }).data.id;

    const answer = await post("/ask", {
      project: firstProject.id,
      sessionId,
      question: "Where is the canonical session project described?",
      mode: "local",
      depth: "shallow",
    });
    assert.equal(answer.statusCode, 200);
    assert.equal((JSON.parse(answer.body) as { data: { sessionId: string } }).data.sessionId, sessionId);

    const preview = await handle.inject({
      method: "GET",
      url: `/sessions/${sessionId}/context`,
      headers: { accept: "application/json" },
    });
    const previewData = (
      JSON.parse(preview.body) as {
        data: { included: Array<{ kind: string; source: string }>; selectedFiles: string[] };
      }
    ).data;
    assert.ok(previewData.included.some((item) => item.kind === "git"));
    assert.ok(previewData.included.some((item) => item.kind === "changed_file" && item.source === "README.md"));
    assert.ok(previewData.included.some((item) => item.kind === "commit"));
    assert.ok(!previewData.selectedFiles.includes(".env"));
    assert.doesNotMatch(preview.body, /ghp_12345678901234567890/);

    const plan = await post("/plan", {
      project: firstProject.id,
      sessionId,
      goal: "Improve the project description",
      risk: "low",
    });
    assert.equal(plan.statusCode, 200);
    const planData = (JSON.parse(plan.body) as { data: { sessionId: string; taskGraph: Array<{ id: string }> } }).data;
    assert.equal(planData.sessionId, sessionId);
    assert.ok(planData.taskGraph.length > 0);
    assert.ok(store.listTasks(sessionId).every((task) => task.sessionId === sessionId));

    const dev = await post("/dev/run", {
      project: firstProject.id,
      sessionId,
      goal: "Improve the project description",
      mode: "local",
      approvalPolicy: "manual",
      approveEdits: false,
      checks: [],
      maxRepairs: 0,
    });
    assert.equal(dev.statusCode, 200);
    const runId = (JSON.parse(dev.body) as { data: { runId: string } }).data.runId;
    assert.ok(runId);
    assert.equal(store.dev.getRun(runId)?.sessionId, sessionId);

    const memory = await post(`/sessions/${sessionId}/memory`, {
      title: "Verified shared workflow",
      body: "Ask, Plan, and Dev reused one canonical session.",
      tags: ["workflow", "verified"],
    });
    assert.equal(memory.statusCode, 201);
    assert.ok(
      store.listProjectLessons(firstProject.id, 20).some((lesson) => lesson.title === "Verified shared workflow")
    );

    const handoff = await post("/handoff", {
      project: firstProject.id,
      sessionId,
      target: "codex",
      subtask: "Continue the verified shared workflow",
    });
    assert.equal(handoff.statusCode, 200);
    const handoffId = (JSON.parse(handoff.body) as { data: { id: string; sessionId: string } }).data.id;
    const handoffDetail = await handle.inject({
      method: "GET",
      url: `/handoffs/${handoffId}`,
      headers: { accept: "application/json" },
    });
    assert.equal(handoffDetail.statusCode, 200);
    assert.equal((JSON.parse(handoffDetail.body) as { data: { sessionId: string } }).data.sessionId, sessionId);
    const missingHandoff = await handle.inject({
      method: "GET",
      url: "/handoffs/missing",
      headers: { accept: "application/json" },
    });
    assert.equal(missingHandoff.statusCode, 404);

    const previewWithHandoff = await handle.inject({
      method: "GET",
      url: `/sessions/${sessionId}/context`,
      headers: { accept: "application/json" },
    });
    assert.ok(
      (JSON.parse(previewWithHandoff.body) as { data: { included: Array<{ kind: string }> } }).data.included.some(
        (item) => item.kind === "handoff"
      )
    );

    for (const endpoint of ["/ask", "/plan", "/dev/run"]) {
      const payload =
        endpoint === "/ask"
          ? { project: secondProject.id, sessionId, question: "Wrong project" }
          : { project: secondProject.id, sessionId, goal: "Wrong project" };
      const rejected = await post(endpoint, payload);
      assert.equal(rejected.statusCode, 409, `${endpoint} must reject cross-project session reuse`);
    }
  } finally {
    await handle.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
