import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkbenchServer } from "../apps/api/src/server.ts";
import { resolveConfig } from "../packages/config/src/index.ts";
import type { DesktopObservation, ProjectManifest } from "../packages/contracts/src/index.ts";
import { createStore, initializeStore } from "../packages/db/src/store.ts";

const fixtures = JSON.parse(
  await readFile(new URL("./fixtures/contracts/v1-control-plane.json", import.meta.url), "utf8")
) as {
  ProjectManifest: ProjectManifest;
  DesktopObservation: DesktopObservation;
};

test("control-plane API approves manifests, persists selection, and resolves desktop observations", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-control-plane-api-"));
  const config = resolveConfig({ databasePath: join(workspace, "ai.db"), runtimeDir: join(workspace, "runtime") });
  const store = createStore(initializeStore(config.databasePath));
  const projectPath = join(workspace, "project");
  await mkdir(projectPath);
  const project = store.createProject({ path: projectPath, name: "API Project" });
  const manifest: ProjectManifest = {
    ...fixtures.ProjectManifest,
    id: project.id,
    name: project.name,
    path: project.path,
    repositoryRoot: project.path,
    approvedRoots: [project.path],
  };
  const proposal = store.projectRegistry.proposeManifest(project.id, manifest, "test");
  const session = store.createSession({
    projectId: project.id,
    title: "Approval session",
    userGoal: "Review a safe change",
    mode: "dev",
    source: "test",
  });
  const run = store.dev.createRun({
    sessionId: session.id,
    projectId: project.id,
    goal: session.userGoal,
    mode: "local",
    approvalPolicy: "manual",
    approveEdits: false,
    maxRepairs: 1,
  });
  store.dev.updateRun(run.id, { status: "awaiting_approval" });
  const approval = store.execution.requestApproval({
    runId: run.id,
    projectId: project.id,
    policy: "manual",
    risk: "low",
    requiresExplicit: true,
    reason: "Review the proposed patch",
    contextHash: "test-context",
  });
  const previousCacheHome = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = join(workspace, "cache");
  const handle = await startWorkbenchServer({ config, store, inProcess: true });
  try {
    const approved = await handle.inject({
      method: "POST",
      url: `/registry/proposals/${proposal.id}/approve`,
      headers: { accept: "application/json", "content-type": "application/json" },
      body: {},
    });
    assert.equal(approved.statusCode, 200);

    const selected = await handle.inject({
      method: "POST",
      url: "/context/selection",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: { projectId: project.id, source: "test", pinScope: "persistent" },
    });
    assert.equal(selected.statusCode, 200);

    const observation: DesktopObservation = {
      ...fixtures.DesktopObservation,
      id: "api_observation",
      editor: { file: join(project.path, "src", "main.ts"), workspace: project.path },
      tmux: { clientPid: 999, session: "wrong", paneId: "%9", cwd: "/tmp/wrong", associationVerified: false },
    };
    const observed = await handle.inject({
      method: "POST",
      url: "/desktop/observations",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: observation,
    });
    assert.equal(observed.statusCode, 200);
    const observedBody = JSON.parse(observed.body) as { data: { project: { id: string }; source: string } };
    assert.equal(observedBody.data.project.id, project.id);
    assert.equal(observedBody.data.source, "manual_pin");

    const explained = await handle.inject({
      method: "GET",
      url: "/context/explain",
      headers: { accept: "application/json" },
    });
    assert.equal(explained.statusCode, 200);
    assert.match(explained.body, /not proven/);

    const status = await handle.inject({
      method: "GET",
      url: "/project-status/compact",
      headers: { accept: "application/json" },
    });
    assert.equal(status.statusCode, 200);
    const statusBody = JSON.parse(status.body) as {
      data: { project: { id: string }; tooltip: string; generatedAt: string };
    };
    assert.equal(statusBody.data.project.id, project.id);
    assert.match(statusBody.data.tooltip, /API Project/);
    assert.ok(statusBody.data.generatedAt);
    const cached = await readFile(join(workspace, "cache", "ai-workbench", "project-status-v1.json"), "utf8");
    assert.match(cached, /API Project/);

    const approvalResponse = await handle.inject({
      method: "GET",
      url: `/approvals/${approval.id}`,
      headers: { accept: "application/json" },
    });
    assert.equal(approvalResponse.statusCode, 200);
    const approvalBody = JSON.parse(approvalResponse.body) as {
      data: { approval: { id: string }; run: { id: string } };
    };
    assert.equal(approvalBody.data.approval.id, approval.id);
    assert.equal(approvalBody.data.run.id, run.id);
    const fullStatus = await handle.inject({
      method: "GET",
      url: "/project-status",
      headers: { accept: "application/json" },
    });
    const fullStatusBody = JSON.parse(fullStatus.body) as { data: { activeWork: { approvalId: string } } };
    assert.equal(fullStatusBody.data.activeWork.approvalId, approval.id);
  } finally {
    await handle.close();
    process.env.XDG_CACHE_HOME = previousCacheHome;
    await rm(workspace, { recursive: true, force: true });
  }
});
