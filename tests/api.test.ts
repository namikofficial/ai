import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeStore, createStore } from "../packages/db/src/store.ts";

test("indexes a repo and answers from the local retrieval store", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-api-"));
  const repo = join(workspace, "sample-repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(
    join(repo, "src", "auth.ts"),
    [
      "export function handleLogin() {",
      "  return { route: '/api/auth/login', storage: 'local sqlite' };",
      "}",
      "",
      "export const authNote = 'auth is handled in the auth router';",
    ].join("\n"),
  );
  await writeFile(join(repo, "README.md"), "# Sample repo\n\nAuth is handled in src/auth.ts.");

  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "sample-repo" });
  assert.equal(project.status, "new");

  const indexResult = await store.indexProject(project.id);
  assert.equal(indexResult.project.status, "ready");
  assert.ok(indexResult.filesIndexed > 0);
  assert.ok(indexResult.chunksIndexed > 0);
  assert.ok(indexResult.events.some((event) => event.type === "session.completed"));

  const answer = await store.ask({
    project: project.id,
    question: "where is auth handled?",
    mode: "local",
    depth: "standard",
  });
  assert.equal(answer.projectId, project.id);
  assert.ok(answer.answer.includes("auth"));
  assert.ok(answer.citations.length > 0);
  assert.ok(store.listSessions(20).length >= 2);

  const sessionEvents = store.listEvents(answer.sessionId);
  assert.ok(sessionEvents.some((event) => event.type === "retrieval.completed" || event.type === "retrieval.low_confidence"));
  assert.ok(sessionEvents.some((event) => event.type === "session.completed"));

  const plan = store.createPlan({
    project: project.id,
    goal: "reduce auth complexity",
    risk: "medium",
  });
  assert.equal(plan.response.projectId, project.id);
  assert.ok(plan.response.taskGraph.length > 0);
  assert.equal(store.listTasks(plan.session.id, 10).length, plan.response.taskGraph.length);
  assert.equal(store.getTask(plan.response.taskGraph[0].id)?.title, plan.response.taskGraph[0].title);
  assert.equal(store.getTask(plan.response.taskGraph[0].id)?.status, "queued");

  const handoff = store.createHandoff({
    sessionId: answer.sessionId,
    project: project.id,
    target: "manual",
    subtask: "update the auth router",
  });
  assert.equal(handoff.projectId, project.id);
  assert.ok(handoff.prompt.includes("update the auth router"));

  const check = store.createCheckRun({
    projectId: project.id,
    sessionId: answer.sessionId,
    name: "typecheck",
    status: "completed",
    output: "ok",
    exitCode: 0,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });
  assert.equal(check.status, "completed");

  const settings = store.getSettings({
    databasePath: join(workspace, "ai.db"),
    runtimeDir: join(workspace, "runtime"),
    apiUrl: "http://127.0.0.1:4242",
    webPort: 4242,
    apiPort: 4242,
    cloudEnabled: false,
    qdrantEnabled: false,
    qdrantUrl: null,
    qdrantCollection: "ai_chunks",
  });
  assert.equal(settings.projectCount >= 1, true);

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});
