import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { startWorkbenchServer } from "../apps/api/src/server.ts";
import type { ProjectManifest } from "../packages/contracts/src/index.ts";
import { createStore, initializeStore } from "../packages/db/src/store.ts";
import { runAllowedCommand } from "../packages/execution-engine/src/index.ts";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/contracts/v1-control-plane.json", import.meta.url), "utf8")
) as { ProjectManifest: ProjectManifest };
const execFileAsync = promisify(execFile);

function command(
  id: string,
  executable: string,
  args: string[],
  mutation: "read_only" | "project_write" = "read_only"
): ProjectManifest["commands"][string] {
  return {
    id,
    name: id,
    description: `${id} test command`,
    category: "utility",
    executable,
    arguments: args,
    workingDirectory: null,
    environmentRefs: [],
    interactive: false,
    mutation,
    timeoutSeconds: 30,
    requiresCapabilities: [],
    visibleWhen: [],
  };
}

test("workflow actions list approved commands, execute read-only work, and persist audit state", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-workflow-actions-"));
  const store = createStore(initializeStore(join(workspace, "workbench.db")));
  const project = store.createProject({ path: workspace, name: "Workflow Project" });
  const manifest: ProjectManifest = {
    ...fixture.ProjectManifest,
    id: project.id,
    name: project.name,
    path: project.path,
    repositoryRoot: project.path,
    approvedRoots: [project.path],
    commands: {
      version: {
        id: "version",
        name: "Git version",
        description: "Read the installed Git version",
        category: "utility",
        executable: "git",
        arguments: ["--version"],
        workingDirectory: null,
        environmentRefs: [],
        interactive: false,
        mutation: "read_only",
        timeoutSeconds: 10,
        requiresCapabilities: [],
        visibleWhen: [],
      },
      unsafeReset: {
        id: "unsafe-reset",
        name: "Unsafe reset",
        description: "Invalid read-only declaration used by the policy regression",
        category: "git",
        executable: "git",
        arguments: ["reset", "--hard"],
        workingDirectory: null,
        environmentRefs: [],
        interactive: false,
        mutation: "read_only",
        timeoutSeconds: 10,
        requiresCapabilities: [],
        visibleWhen: [],
      },
    },
  };
  store.projectRegistry.saveApprovedManifest(project.id, manifest, "test");
  store.projectRegistry.selectProject(project.id, "test", "persistent");
  const handle = await startWorkbenchServer({
    store,
    inProcess: true,
    config: { databasePath: join(workspace, "workbench.db"), runtimeDir: join(workspace, "runtime"), apiPort: 0 },
  });
  try {
    const listed = await handle.inject({ method: "GET", url: "/actions", headers: { accept: "application/json" } });
    assert.equal(listed.statusCode, 200);
    const actions = JSON.parse(listed.body).data as Array<{ workflowId: string }>;
    assert.deepEqual(actions.map((action) => action.workflowId).sort(), ["unsafe-reset", "version"]);

    const run = await handle.inject({
      method: "POST",
      url: "/actions/version/run",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: { projectId: project.id },
    });
    assert.equal(run.statusCode, 200);
    const record = JSON.parse(run.body).data as {
      execution: { id: string; state: string; projectId: string; workflowId: string };
      stdout: string;
    };
    assert.equal(record.execution.state, "completed");
    assert.equal(record.execution.projectId, project.id);
    assert.equal(record.execution.workflowId, "version");
    assert.match(record.stdout, /git version/i);
    assert.equal(store.workflows.get(record.execution.id)?.execution.state, "completed");
    assert.ok(store.listEvents().some((event) => event.type === "workflow.completed"));

    const rejected = await handle.inject({
      method: "POST",
      url: "/actions/unsafe-reset/run",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: { projectId: project.id },
    });
    assert.equal(rejected.statusCode, 409);
    assert.match(rejected.body, /declares read-only/);
    assert.ok(store.listEvents().some((event) => event.type === "workflow.blocked"));
  } finally {
    await handle.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("execution environment excludes ambient secrets and inline code", async () => {
  const previous = process.env.AI_WORKBENCH_TEST_SECRET;
  process.env.AI_WORKBENCH_TEST_SECRET = "must-not-leak";
  try {
    const result = await runAllowedCommand({
      cwd: process.cwd(),
      command: {
        id: "secret-check",
        description: "Verify ambient secret filtering",
        binary: "printenv",
        args: ["AI_WORKBENCH_TEST_SECRET"],
        cwdFrom: "project",
      },
      timeoutMs: 5_000,
    });
    assert.equal(result.status, "failed");
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /must-not-leak/);

    const inline = await runAllowedCommand({
      cwd: process.cwd(),
      command: {
        id: "inline-code",
        description: "Must be blocked",
        binary: "node",
        args: ["-e", "process.exit(0)"],
        cwdFrom: "project",
      },
    });
    assert.equal(inline.status, "blocked");
    assert.match(inline.blockedReason ?? "", /inline code/);
  } finally {
    if (previous === undefined) delete process.env.AI_WORKBENCH_TEST_SECRET;
    else process.env.AI_WORKBENCH_TEST_SECRET = previous;
  }
});

test("mutating workflow approvals bind context, reject replay, and support rejection", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-workflow-approval-"));
  await execFileAsync("git", ["init", "-q", workspace]);
  await execFileAsync("git", ["-C", workspace, "config", "user.email", "workflow@example.test"]);
  await execFileAsync("git", ["-C", workspace, "config", "user.name", "Workflow Test"]);
  await execFileAsync("git", ["-C", workspace, "commit", "--allow-empty", "-qm", "initial"]);
  const store = createStore(initializeStore(join(workspace, "workbench.db")));
  const project = store.createProject({ path: workspace, name: "Approval Project" });
  const manifest: ProjectManifest = {
    ...fixture.ProjectManifest,
    id: project.id,
    name: project.name,
    path: project.path,
    repositoryRoot: project.path,
    approvedRoots: [project.path],
    commands: {
      approvedTag: command("approved-tag", "git", ["tag", "--no-sign", "workflow-approved"], "project_write"),
      rejectedTag: command("rejected-tag", "git", ["tag", "--no-sign", "workflow-rejected"], "project_write"),
      staleTag: command("stale-tag", "git", ["tag", "--no-sign", "workflow-stale"], "project_write"),
    },
  };
  store.projectRegistry.saveApprovedManifest(project.id, manifest, "test");
  const handle = await startWorkbenchServer({
    store,
    inProcess: true,
    config: { databasePath: join(workspace, "workbench.db"), runtimeDir: join(workspace, "runtime"), apiPort: 0 },
  });
  const request = (workflowId: string) =>
    handle.inject({
      method: "POST",
      url: `/actions/${workflowId}/run`,
      headers: { accept: "application/json", "content-type": "application/json" },
      body: { projectId: project.id },
    });
  try {
    const pending = await request("approved-tag");
    assert.equal(pending.statusCode, 202);
    const pendingData = JSON.parse(pending.body).data as {
      execution: { id: string; state: string; approvalId: string };
      approval: { id: string; status: string; contextHash: string };
      deepLink: string;
    };
    assert.equal(pendingData.execution.state, "waiting");
    assert.equal(pendingData.approval.status, "pending");
    assert.equal(pendingData.execution.approvalId, pendingData.approval.id);
    assert.match(pendingData.deepLink, /\/approvals\//);
    await assert.rejects(execFileAsync("git", ["-C", workspace, "rev-parse", "workflow-approved"]));

    const approvalView = await handle.inject({
      method: "GET",
      url: `/approvals/${pendingData.approval.id}`,
      headers: { accept: "application/json" },
    });
    assert.equal(approvalView.statusCode, 200);
    assert.equal(JSON.parse(approvalView.body).data.kind, "workflow");

    const approved = await handle.inject({
      method: "POST",
      url: `/actions/executions/${pendingData.execution.id}/approve`,
      headers: { accept: "application/json", "content-type": "application/json" },
      body: { decidedBy: "test" },
    });
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal(JSON.parse(approved.body).data.execution.state, "completed");
    assert.match((await execFileAsync("git", ["-C", workspace, "tag", "--list"])).stdout, /workflow-approved/);

    const replay = await handle.inject({
      method: "POST",
      url: `/actions/executions/${pendingData.execution.id}/approve`,
      headers: { accept: "application/json", "content-type": "application/json" },
      body: {},
    });
    assert.equal(replay.statusCode, 409);

    const rejectedPending = JSON.parse((await request("rejected-tag")).body).data as {
      execution: { id: string };
    };
    const rejected = await handle.inject({
      method: "POST",
      url: `/actions/executions/${rejectedPending.execution.id}/reject`,
      headers: { accept: "application/json", "content-type": "application/json" },
      body: { notes: "not now" },
    });
    assert.equal(rejected.statusCode, 200);
    assert.equal(JSON.parse(rejected.body).data.execution.state, "cancelled");
    await assert.rejects(execFileAsync("git", ["-C", workspace, "rev-parse", "workflow-rejected"]));

    const stalePending = JSON.parse((await request("stale-tag")).body).data as {
      execution: { id: string };
    };
    await execFileAsync("git", ["-C", workspace, "commit", "--allow-empty", "-qm", "context changed"]);
    const stale = await handle.inject({
      method: "POST",
      url: `/actions/executions/${stalePending.execution.id}/approve`,
      headers: { accept: "application/json", "content-type": "application/json" },
      body: {},
    });
    assert.equal(stale.statusCode, 409);
    assert.match(stale.body, /stale/);
    assert.equal(store.workflows.get(stalePending.execution.id)?.execution.state, "cancelled");
    await assert.rejects(execFileAsync("git", ["-C", workspace, "rev-parse", "workflow-stale"]));
  } finally {
    await handle.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("running workflow cancellation terminates execution and persists cancelled state", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-workflow-cancel-"));
  const store = createStore(initializeStore(join(workspace, "workbench.db")));
  const project = store.createProject({ path: workspace, name: "Cancellation Project" });
  const manifest: ProjectManifest = {
    ...fixture.ProjectManifest,
    id: project.id,
    name: project.name,
    path: project.path,
    repositoryRoot: project.path,
    approvedRoots: [project.path],
    commands: { server: command("server", "python3", ["-m", "http.server", "0"]) },
  };
  store.projectRegistry.saveApprovedManifest(project.id, manifest, "test");
  const handle = await startWorkbenchServer({
    store,
    inProcess: true,
    config: { databasePath: join(workspace, "workbench.db"), runtimeDir: join(workspace, "runtime"), apiPort: 0 },
  });
  try {
    const runningRequest = handle.inject({
      method: "POST",
      url: "/actions/server/run",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: { projectId: project.id },
    });
    let executionId: string | null = null;
    for (let attempt = 0; attempt < 100 && !executionId; attempt += 1) {
      executionId =
        store.workflows.list(project.id).find((record) => record.execution.state === "running")?.execution.id ?? null;
      if (!executionId) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(executionId, "workflow should enter running state");
    const cancel = await handle.inject({
      method: "POST",
      url: `/actions/executions/${executionId}/cancel`,
      headers: { accept: "application/json" },
    });
    assert.equal(cancel.statusCode, 202);
    const finished = await runningRequest;
    assert.equal(finished.statusCode, 422);
    assert.equal(JSON.parse(finished.body).data.execution.state, "cancelled");
    assert.equal(store.workflows.get(executionId)?.execution.state, "cancelled");
    assert.ok(store.listEvents().some((event) => event.type === "workflow.cancelled"));
  } finally {
    await handle.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
