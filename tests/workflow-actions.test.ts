import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkbenchServer } from "../apps/api/src/server.ts";
import { processNextJob, recoverAbandonedBackgroundWorkflows } from "../apps/worker/src/worker.ts";
import type { ProjectManifest, WorkflowDefinition, WorkflowStepDefinition } from "../packages/contracts/src/index.ts";
import { createStore, initializeStore } from "../packages/db/src/store.ts";
import { runAllowedCommand } from "../packages/execution-engine/src/index.ts";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/contracts/v1-control-plane.json", import.meta.url), "utf8")
) as { ProjectManifest: ProjectManifest; WorkflowDefinition: WorkflowDefinition };
function execFileAsync(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}

function command(
  id: string,
  executable: string,
  args: string[],
  mutation: "read_only" | "workspace_write" | "project_write" = "read_only"
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
    executionMode: "direct",
    mutation,
    timeoutSeconds: 30,
    retryLimit: 0,
    retryDelaySeconds: 0,
    expectedArtifacts: [],
    successCriteria: [],
    recoveryWorkflowIds: [],
    requiresCapabilities: [],
    visibleWhen: [],
  };
}

function workflowStep(id: string, workflowId: string, dependsOn: string[] = []): WorkflowStepDefinition {
  return {
    id,
    name: id,
    workflowId,
    dependsOn,
    executionMode: "direct",
    mutation: "read_only",
    approvalRequired: false,
    timeoutSeconds: 30,
    retryLimit: 0,
    successCriteria: ["exit code is zero"],
    recoveryWorkflowIds: [],
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
        executionMode: "direct",
        mutation: "read_only",
        timeoutSeconds: 10,
        retryLimit: 0,
        retryDelaySeconds: 0,
        expectedArtifacts: [],
        successCriteria: [],
        recoveryWorkflowIds: [],
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
        executionMode: "direct",
        mutation: "read_only",
        timeoutSeconds: 10,
        retryLimit: 0,
        retryDelaySeconds: 0,
        expectedArtifacts: [],
        successCriteria: [],
        recoveryWorkflowIds: [],
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

    const definitions = await handle.inject({
      method: "GET",
      url: `/projects/${project.id}/workflows`,
      headers: { accept: "application/json" },
    });
    assert.equal(definitions.statusCode, 200);
    assert.equal((JSON.parse(definitions.body).data as Array<{ id: string }>).length, 2);
    const canonicalDefinition = store.workflows.getDefinition(project.id, "version");
    assert.ok(canonicalDefinition?.command);
    const manualDefinition = {
      ...canonicalDefinition,
      name: "Manual version policy",
      command: { ...canonicalDefinition.command, executable: "false", arguments: [] },
      updatedAt: new Date().toISOString(),
    };
    const savedDefinition = await handle.inject({
      method: "PUT",
      url: `/projects/${project.id}/workflows/version`,
      headers: { accept: "application/json", "content-type": "application/json" },
      body: manualDefinition,
    });
    assert.equal(savedDefinition.statusCode, 200, savedDefinition.body);
    const manualRun = await handle.inject({
      method: "POST",
      url: "/actions/version/run",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: { projectId: project.id },
    });
    assert.equal(manualRun.statusCode, 422, manualRun.body);
    assert.equal(JSON.parse(manualRun.body).data.execution.state, "failed");
    assert.ok(store.listEvents().some((event) => event.type === "workflow.definition_saved"));

    const rejected = await handle.inject({
      method: "POST",
      url: "/actions/unsafe-reset/run",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: { projectId: project.id },
    });
    assert.equal(rejected.statusCode, 409);
    assert.match(rejected.body, /declares read-only/);
    assert.ok(store.listEvents().some((event) => event.type === "workflow.blocked"));

    const otherPath = join(workspace, "other-project");
    await mkdir(otherPath);
    const otherProject = store.createProject({ path: otherPath, name: "Other Project" });
    const otherSession = store.createSession({
      projectId: otherProject.id,
      title: "Other project session",
      userGoal: "must remain scoped",
      mode: "check",
      source: "test",
    });
    const confused = await handle.inject({
      method: "POST",
      url: "/actions/version/run",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: { projectId: project.id, sessionId: otherSession.id },
    });
    assert.equal(confused.statusCode, 409);
    assert.match(confused.body, /different project/);

    const otherTask = store.createTask({
      sessionId: otherSession.id,
      title: "Other task",
      description: "Must not cross session scope",
      type: "workflow",
    });
    const confusedTask = await handle.inject({
      method: "POST",
      url: "/actions/version/run",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: { projectId: project.id, taskId: otherTask.id },
    });
    assert.equal(confusedTask.statusCode, 409);
    assert.match(confusedTask.body, /requested session/);
  } finally {
    await handle.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("background workflows use the durable queue and recover abandoned supervision", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-workflow-background-"));
  const store = createStore(initializeStore(join(workspace, "workbench.db")));
  const project = store.createProject({ path: workspace, name: "Background Project" });
  const background = command("background-version", "git", ["--version"]);
  background.executionMode = "background";
  background.category = "check";
  const backgroundRetry = command("background-retry", "false", []);
  backgroundRetry.executionMode = "background";
  backgroundRetry.retryLimit = 1;
  const prepare = command("background-prepare", "true", []);
  const manifest: ProjectManifest = {
    ...fixture.ProjectManifest,
    id: project.id,
    name: project.name,
    path: project.path,
    repositoryRoot: project.path,
    approvedRoots: [project.path],
    commands: { background, backgroundRetry, prepare },
  };
  store.projectRegistry.saveApprovedManifest(project.id, manifest, "test");
  const planTimestamp = new Date().toISOString();
  store.workflows.saveDefinition(
    {
      ...fixture.WorkflowDefinition,
      id: "background-pipeline",
      projectId: project.id,
      name: "Background pipeline",
      command: null,
      steps: [
        workflowStep("prepare-step", "background-prepare"),
        {
          ...workflowStep("background-step", "background-version", ["prepare-step"]),
          executionMode: "background",
        },
      ],
      expectedArtifacts: [],
      approvalRequired: false,
      createdAt: planTimestamp,
      updatedAt: planTimestamp,
    },
    "manual"
  );
  const handle = await startWorkbenchServer({
    store,
    inProcess: true,
    config: { databasePath: join(workspace, "workbench.db"), runtimeDir: join(workspace, "runtime"), apiPort: 0 },
  });
  const request = (workflowId = "background-version") =>
    handle.inject({
      method: "POST",
      url: `/actions/${workflowId}/run`,
      headers: { accept: "application/json", "content-type": "application/json" },
      body: { projectId: project.id },
    });
  try {
    const queued = await request();
    assert.equal(queued.statusCode, 202, queued.body);
    const queuedData = JSON.parse(queued.body).data as {
      execution: { id: string; state: string };
      backgroundJob: { state: string };
    };
    assert.equal(queuedData.execution.state, "starting");
    assert.equal(queuedData.backgroundJob.state, "queued");
    assert.equal(await processNextJob(store, { workerInstanceId: "test-worker" }), true);
    assert.equal(store.workflows.get(queuedData.execution.id)?.execution.state, "completed");
    assert.equal(store.workflows.getBackgroundJob(queuedData.execution.id)?.state, "completed");
    assert.equal(store.listCheckRuns(10, project.id)[0]?.status, "completed");

    const planData = JSON.parse((await request("background-pipeline")).body).data as {
      execution: { id: string; state: string };
    };
    assert.equal(planData.execution.state, "starting");
    assert.equal(
      await processNextJob(store, { workerInstanceId: "test-worker", runtimeDir: join(workspace, "runtime") }),
      true
    );
    assert.equal(store.workflows.get(planData.execution.id)?.execution.state, "completed");
    assert.deepEqual(
      store.workflows.listStepExecutions(planData.execution.id).map((step) => step.state),
      ["completed", "completed"]
    );

    const retryData = JSON.parse((await request("background-retry")).body).data as {
      execution: { id: string };
    };
    assert.equal(await processNextJob(store, { workerInstanceId: "test-worker" }), true);
    const retried = store.workflows.get(retryData.execution.id)?.execution;
    assert.equal(retried?.state, "failed");
    assert.equal(retried?.stepStates["command.attempt.1"], "failed");
    assert.equal(retried?.stepStates["command.attempt.2"], "failed");

    const cancelled = JSON.parse((await request()).body).data as { execution: { id: string } };
    const cancel = await handle.inject({
      method: "POST",
      url: `/actions/executions/${cancelled.execution.id}/cancel`,
      headers: { accept: "application/json" },
    });
    assert.equal(cancel.statusCode, 200, cancel.body);
    assert.equal(store.workflows.get(cancelled.execution.id)?.execution.state, "cancelled");
    assert.equal(store.workflows.getBackgroundJob(cancelled.execution.id)?.state, "cancelled");

    const changed = JSON.parse((await request()).body).data as { execution: { id: string } };
    store.projectRegistry.saveApprovedManifest(
      project.id,
      { ...manifest, commands: { background: { ...background, executionMode: "direct" } } },
      "test"
    );
    assert.equal(await processNextJob(store, { workerInstanceId: "test-worker" }), true);
    assert.equal(store.workflows.get(changed.execution.id)?.execution.state, "failed");
    assert.equal(store.workflows.get(changed.execution.id)?.execution.errorCode, "background_execution_failed");
    assert.equal(store.workflows.getBackgroundJob(changed.execution.id)?.state, "failed");
    store.projectRegistry.saveApprovedManifest(project.id, manifest, "test");

    const abandoned = JSON.parse((await request()).body).data as { execution: { id: string } };
    const claimed = store.claimNextJob();
    assert.ok(claimed);
    const abandonedRecord = store.workflows.get(abandoned.execution.id);
    assert.ok(abandonedRecord);
    const startedAt = new Date().toISOString();
    store.workflows.save({
      ...abandonedRecord,
      execution: {
        ...abandonedRecord.execution,
        state: "running",
        startedAt,
        updatedAt: startedAt,
        stepStates: { command: "running" },
      },
    });
    store.workflows.transitionBackgroundJob({
      executionId: abandoned.execution.id,
      expectedState: "queued",
      state: "running",
      workerInstanceId: "dead-worker",
      startedAt,
    });
    assert.equal(recoverAbandonedBackgroundWorkflows(store), 1);
    const recovered = store.workflows.get(abandoned.execution.id)?.execution;
    assert.equal(recovered?.state, "failed");
    assert.equal(recovered?.errorCode, "worker_restarted");
    assert.equal(store.workflows.getBackgroundJob(abandoned.execution.id)?.state, "failed");
  } finally {
    await handle.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("running background worker processes are cancelled by process group without retry", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-workflow-background-cancel-"));
  const store = createStore(initializeStore(join(workspace, "workbench.db")));
  const project = store.createProject({ path: workspace, name: "Background Cancellation Project" });
  const server = command("background-server", "python3", ["-m", "http.server", "0"]);
  server.executionMode = "background";
  server.retryLimit = 1;
  const manifest: ProjectManifest = {
    ...fixture.ProjectManifest,
    id: project.id,
    name: project.name,
    path: project.path,
    repositoryRoot: project.path,
    approvedRoots: [project.path],
    commands: { server },
  };
  store.projectRegistry.saveApprovedManifest(project.id, manifest, "test");
  const handle = await startWorkbenchServer({
    store,
    inProcess: true,
    config: { databasePath: join(workspace, "workbench.db"), runtimeDir: join(workspace, "runtime"), apiPort: 0 },
  });
  try {
    const queued = await handle.inject({
      method: "POST",
      url: "/actions/background-server/run",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: { projectId: project.id },
    });
    const executionId = (JSON.parse(queued.body).data as { execution: { id: string } }).execution.id;
    const processing = processNextJob(store, {
      workerInstanceId: "background-cancel-worker",
      runtimeDir: join(workspace, "runtime"),
    });
    let running = false;
    for (let attempt = 0; attempt < 100 && !running; attempt += 1) {
      const background = store.workflows.getBackgroundJob(executionId);
      running = background?.state === "running" && background.processPid !== null;
      if (!running) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(running, true);
    const cancel = await handle.inject({
      method: "POST",
      url: `/actions/executions/${executionId}/cancel`,
      headers: { accept: "application/json" },
    });
    assert.equal(cancel.statusCode, 202, cancel.body);
    assert.equal(await processing, true);
    const execution = store.workflows.get(executionId)?.execution;
    assert.equal(execution?.state, "cancelled");
    assert.equal(execution?.stepStates["command.attempt.2"], undefined);
    assert.equal(store.workflows.getBackgroundJob(executionId)?.state, "cancelled");
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

test("approved secret references reach commands without entering responses or audit logs", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-workflow-secrets-"));
  const secretFile = join(workspace, "workflow-secrets.env");
  const secretValue = "workflow-secret-value-should-never-persist";
  await writeFile(secretFile, `WORKBENCH_TEST_TOKEN=${secretValue}\n`, { mode: 0o600 });
  const previousProvider = process.env.AI_WORKBENCH_SECRET_FILE;
  process.env.AI_WORKBENCH_SECRET_FILE = secretFile;
  const store = createStore(initializeStore(join(workspace, "workbench.db")));
  const project = store.createProject({ path: workspace, name: "Secret Workflow Project" });
  const approved = command("approved-secret", "printenv", ["WORKBENCH_TEST_TOKEN"]);
  approved.environmentRefs = ["WORKBENCH_TEST_TOKEN"];
  const unapproved = command("unapproved-secret", "printenv", ["OTHER_TOKEN"]);
  unapproved.environmentRefs = ["OTHER_TOKEN"];
  const desktop = { ...approved, id: "desktop-secret", name: "desktop-secret", executionMode: "terminal" as const };
  const background = {
    ...approved,
    id: "background-secret",
    name: "background-secret",
    executionMode: "background" as const,
  };
  const manifest: ProjectManifest = {
    ...fixture.ProjectManifest,
    id: project.id,
    name: project.name,
    path: project.path,
    repositoryRoot: project.path,
    approvedRoots: [project.path],
    secretRefs: ["WORKBENCH_TEST_TOKEN"],
    commands: { approved, unapproved, desktop, background },
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
    const ran = await request("approved-secret");
    assert.equal(ran.statusCode, 200, ran.body);
    const executionId = (JSON.parse(ran.body).data as { execution: { id: string } }).execution.id;
    assert.match(ran.body, /REDACTED_SECRET/);
    assert.doesNotMatch(ran.body, new RegExp(secretValue));
    assert.doesNotMatch(JSON.stringify(store.workflows.get(executionId)), new RegExp(secretValue));

    const queued = await request("background-secret");
    assert.equal(queued.statusCode, 202, queued.body);
    const backgroundExecutionId = (JSON.parse(queued.body).data as { execution: { id: string } }).execution.id;
    assert.equal(await processNextJob(store, { workerInstanceId: "secret-test-worker" }), true);
    const backgroundRecord = store.workflows.get(backgroundExecutionId);
    assert.equal(backgroundRecord?.execution.state, "completed");
    assert.match(backgroundRecord?.stdout ?? "", /REDACTED_SECRET/);
    assert.doesNotMatch(JSON.stringify(backgroundRecord), new RegExp(secretValue));

    const rejected = await request("unapproved-secret");
    assert.equal(rejected.statusCode, 409);
    assert.match(rejected.body, /not approved by the manifest/);
    const desktopRejected = await request("desktop-secret");
    assert.equal(desktopRejected.statusCode, 409);
    assert.match(desktopRejected.body, /cannot deliver secret references/);

    await chmod(secretFile, 0o644);
    const insecure = await request("approved-secret");
    assert.equal(insecure.statusCode, 422, insecure.body);
    assert.match(insecure.body, /mode 0600/);
    assert.doesNotMatch(insecure.body, new RegExp(secretValue));
  } finally {
    if (previousProvider === undefined) delete process.env.AI_WORKBENCH_SECRET_FILE;
    else process.env.AI_WORKBENCH_SECRET_FILE = previousProvider;
    await handle.close();
    await rm(workspace, { recursive: true, force: true });
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

test("workflow retries are audited, required artifacts are enforced, and mutating retries are rejected", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-workflow-policy-"));
  const outside = await mkdtemp(join(tmpdir(), "ai-workflow-artifact-outside-"));
  await writeFile(join(outside, "result.json"), "{}\n");
  await symlink(join(outside, "result.json"), join(workspace, "escaped-result.json"));
  const store = createStore(initializeStore(join(workspace, "workbench.db")));
  const project = store.createProject({ path: workspace, name: "Workflow Policy Project" });
  const retry = command("retry", "false", []);
  retry.retryLimit = 2;
  const missingArtifact = command("missing-artifact", "true", []);
  missingArtifact.expectedArtifacts = [{ id: "report", path: "report.json", kind: "file", required: true }];
  const unsafeRetry = command("unsafe-retry", "git", ["tag", "unsafe-retry"], "project_write");
  unsafeRetry.retryLimit = 1;
  const escapingArtifact = command("escaping-artifact", "true", []);
  escapingArtifact.expectedArtifacts = [
    { id: "escaped-report", path: "escaped-result.json", kind: "file", required: true },
  ];
  const manifest: ProjectManifest = {
    ...fixture.ProjectManifest,
    id: project.id,
    name: project.name,
    path: project.path,
    repositoryRoot: project.path,
    approvedRoots: [project.path],
    commands: { retry, missingArtifact, unsafeRetry, escapingArtifact },
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
    const retried = await request("retry");
    assert.equal(retried.statusCode, 422, retried.body);
    const retriedExecution = JSON.parse(retried.body).data.execution as {
      stepStates: Record<string, string>;
    };
    assert.equal(retriedExecution.stepStates["command.attempt.1"], "failed");
    assert.equal(retriedExecution.stepStates["command.attempt.2"], "failed");
    assert.equal(retriedExecution.stepStates["command.attempt.3"], "failed");
    assert.equal(store.listEvents().filter((event) => event.type === "workflow.attempt_completed").length, 3);

    const artifact = await request("missing-artifact");
    assert.equal(artifact.statusCode, 422, artifact.body);
    const artifactExecution = JSON.parse(artifact.body).data.execution as { errorCode: string; errorSummary: string };
    assert.equal(artifactExecution.errorCode, "expected_artifact_failed");
    assert.match(artifactExecution.errorSummary, /missing: report/);

    const escaped = await request("escaping-artifact");
    assert.equal(escaped.statusCode, 422, escaped.body);
    assert.match(escaped.body, /resolves outside workflow working directory/);

    const unsafe = await request("unsafe-retry");
    assert.equal(unsafe.statusCode, 409, unsafe.body);
    assert.match(unsafe.body, /cannot automatically retry/);
  } finally {
    await handle.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("workflow definition DAGs execute in dependency order and block downstream steps after failure", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-workflow-dag-"));
  await execFileAsync("git", ["init", "-q", workspace]);
  await execFileAsync("git", ["-C", workspace, "config", "user.email", "workflow-dag@example.test"]);
  await execFileAsync("git", ["-C", workspace, "config", "user.name", "Workflow DAG Test"]);
  await execFileAsync("git", ["-C", workspace, "commit", "--allow-empty", "-qm", "initial"]);
  const store = createStore(initializeStore(join(workspace, "workbench.db")));
  const project = store.createProject({ path: workspace, name: "Workflow DAG Project" });
  const first = command("first", "true", []);
  const second = command("second", "true", []);
  const failing = command("failing", "false", []);
  const never = command("never", "true", []);
  const tag = command("tag", "git", ["tag", "--no-sign", "workflow-dag-approved"], "project_write");
  const manifest: ProjectManifest = {
    ...fixture.ProjectManifest,
    id: project.id,
    name: project.name,
    path: project.path,
    repositoryRoot: project.path,
    approvedRoots: [project.path],
    commands: { first, second, failing, never, tag },
  };
  store.projectRegistry.saveApprovedManifest(project.id, manifest, "test");
  const timestamp = new Date().toISOString();
  const definition = (id: string, steps: WorkflowStepDefinition[]): WorkflowDefinition => ({
    ...fixture.WorkflowDefinition,
    id,
    projectId: project.id,
    name: id,
    command: null,
    steps,
    expectedArtifacts: [],
    approvalRequired: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  store.workflows.saveDefinition(
    definition("success-pipeline", [
      workflowStep("second-step", "second", ["first-step"]),
      workflowStep("first-step", "first"),
    ]),
    "manual"
  );
  const mutatingStep: WorkflowStepDefinition = {
    ...workflowStep("tag-step", "tag", ["first-step"]),
    mutation: "project_write",
    approvalRequired: true,
  };
  store.workflows.saveDefinition(
    {
      ...definition("approval-pipeline", [workflowStep("first-step", "first"), mutatingStep]),
      approvalRequired: true,
    },
    "manual"
  );
  store.workflows.saveDefinition(
    definition("failure-pipeline", [
      workflowStep("first-step", "first"),
      workflowStep("failure-step", "failing", ["first-step"]),
      workflowStep("downstream-step", "never", ["failure-step"]),
    ]),
    "manual"
  );
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
    const actions = await handle.inject({
      method: "GET",
      url: `/actions?projectId=${project.id}`,
      headers: { accept: "application/json" },
    });
    assert.ok(
      (JSON.parse(actions.body).data as Array<{ workflowId: string }>).some(
        (item) => item.workflowId === "success-pipeline"
      )
    );

    const succeeded = await request("success-pipeline");
    assert.equal(succeeded.statusCode, 200, succeeded.body);
    const succeededData = JSON.parse(succeeded.body).data as { execution: { id: string; state: string } };
    assert.equal(succeededData.execution.state, "completed");
    assert.deepEqual(
      store.workflows.listStepExecutions(succeededData.execution.id).map((step) => [step.stepId, step.state]),
      [
        ["first-step", "completed"],
        ["second-step", "completed"],
      ]
    );
    const status = await handle.inject({
      method: "GET",
      url: `/actions/executions/${succeededData.execution.id}`,
      headers: { accept: "application/json" },
    });
    assert.equal((JSON.parse(status.body).data.steps as unknown[]).length, 2);

    const failed = await request("failure-pipeline");
    assert.equal(failed.statusCode, 422, failed.body);
    const failedData = JSON.parse(failed.body).data as {
      execution: { id: string; state: string; stepStates: Record<string, string> };
    };
    assert.equal(failedData.execution.state, "failed");
    assert.equal(failedData.execution.stepStates["failure-step"], "failed");
    assert.equal(failedData.execution.stepStates["downstream-step"], "blocked");
    assert.equal(
      store.workflows.listStepExecutions(failedData.execution.id).find((step) => step.stepId === "downstream-step")
        ?.errorCode,
      "dependency_failed"
    );

    const pending = await request("approval-pipeline");
    assert.equal(pending.statusCode, 202, pending.body);
    const pendingData = JSON.parse(pending.body).data as { execution: { id: string; state: string } };
    assert.equal(pendingData.execution.state, "waiting");
    const approved = await handle.inject({
      method: "POST",
      url: `/actions/executions/${pendingData.execution.id}/approve`,
      headers: { accept: "application/json", "content-type": "application/json" },
      body: { decidedBy: "workflow-dag-test" },
    });
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal(JSON.parse(approved.body).data.execution.state, "completed");
    assert.match((await execFileAsync("git", ["-C", workspace, "tag", "--list"])).stdout, /workflow-dag-approved/);
  } finally {
    await handle.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("interactive workflows use token-bound terminal and tmux launch handoffs", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-workflow-launch-"));
  const store = createStore(initializeStore(join(workspace, "workbench.db")));
  const project = store.createProject({ path: workspace, name: "Interactive Project" });
  const interactive = command("interactive", "git", ["--version"]);
  interactive.interactive = true;
  interactive.executionMode = "terminal";
  const mutating = command("interactive-mutate", "git", ["tag", "interactive-approved"], "project_write");
  mutating.interactive = true;
  mutating.executionMode = "tmux";
  const manifest: ProjectManifest = {
    ...fixture.ProjectManifest,
    id: project.id,
    name: project.name,
    path: project.path,
    repositoryRoot: project.path,
    approvedRoots: [project.path],
    desktop: { ...fixture.ProjectManifest.desktop, tmuxSession: "interactive-project" },
    commands: { interactive, mutating },
  };
  store.projectRegistry.saveApprovedManifest(project.id, manifest, "test");
  const session = store.createSession({
    projectId: project.id,
    title: "Interactive session",
    userGoal: "launch safely",
    mode: "check",
    source: "test",
  });
  const handle = await startWorkbenchServer({
    store,
    inProcess: true,
    config: { databasePath: join(workspace, "workbench.db"), runtimeDir: join(workspace, "runtime"), apiPort: 0 },
  });
  try {
    const requested = await handle.inject({
      method: "POST",
      url: "/actions/interactive/run",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: { projectId: project.id, sessionId: session.id, executionMode: "terminal" },
    });
    assert.equal(requested.statusCode, 202, requested.body);
    const ready = JSON.parse(requested.body).data as {
      execution: { id: string; state: string };
      launch: { state: string; mode: string; environment: Record<string, string> };
    };
    assert.equal(ready.execution.state, "ready");
    assert.equal(ready.launch.state, "ready");
    assert.equal(ready.launch.mode, "terminal");
    assert.equal(ready.launch.environment.AI_WORKBENCH_PROJECT_ID, project.id);
    assert.equal(ready.launch.environment.AI_WORKBENCH_SESSION_ID, session.id);
    assert.ok(!JSON.stringify(ready.launch).includes("token"));

    const authorized = await handle.inject({
      method: "POST",
      url: `/actions/executions/${ready.execution.id}/launch/authorize`,
      headers: { accept: "application/json", "content-type": "application/json" },
      body: {},
    });
    assert.equal(authorized.statusCode, 200);
    const capability = JSON.parse(authorized.body).data as {
      token: string;
      launch: { authorizationExpiresAt: string };
    };
    assert.ok(capability.token.length >= 64);
    assert.ok(Date.parse(capability.launch.authorizationExpiresAt) > Date.now());
    assert.ok(
      !JSON.stringify(store.workflows.getLaunchForExecution(ready.execution.id)?.launch).includes(capability.token)
    );

    const invalid = await handle.inject({
      method: "POST",
      url: `/actions/executions/${ready.execution.id}/launch/start`,
      headers: { accept: "application/json", "content-type": "application/json" },
      body: { token: "wrong", launcherInstanceId: "test-launcher", pid: process.pid },
    });
    assert.equal(invalid.statusCode, 409);

    const started = await handle.inject({
      method: "POST",
      url: `/actions/executions/${ready.execution.id}/launch/start`,
      headers: { accept: "application/json", "content-type": "application/json" },
      body: { token: capability.token, launcherInstanceId: "test-launcher", pid: process.pid },
    });
    assert.equal(started.statusCode, 200, started.body);
    assert.equal(JSON.parse(started.body).data.execution.state, "running");
    const replayStart = await handle.inject({
      method: "POST",
      url: `/actions/executions/${ready.execution.id}/launch/start`,
      headers: { accept: "application/json", "content-type": "application/json" },
      body: { token: capability.token, launcherInstanceId: "replay", pid: process.pid },
    });
    assert.equal(replayStart.statusCode, 409);

    const completed = await handle.inject({
      method: "POST",
      url: `/actions/executions/${ready.execution.id}/launch/complete`,
      headers: { accept: "application/json", "content-type": "application/json" },
      body: { token: capability.token, exitCode: 0 },
    });
    assert.equal(completed.statusCode, 200, completed.body);
    assert.equal(JSON.parse(completed.body).data.execution.state, "completed");
    const replayComplete = await handle.inject({
      method: "POST",
      url: `/actions/executions/${ready.execution.id}/launch/complete`,
      headers: { accept: "application/json", "content-type": "application/json" },
      body: { token: capability.token, exitCode: 0 },
    });
    assert.equal(replayComplete.statusCode, 409);

    const pending = await handle.inject({
      method: "POST",
      url: "/actions/interactive-mutate/run",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: { projectId: project.id, executionMode: "tmux" },
    });
    assert.equal(pending.statusCode, 202);
    const pendingData = JSON.parse(pending.body).data as { execution: { id: string }; launch?: unknown };
    assert.equal(store.workflows.getLaunchForExecution(pendingData.execution.id)?.launch.state, "waiting");
    const approved = await handle.inject({
      method: "POST",
      url: `/actions/executions/${pendingData.execution.id}/approve`,
      headers: { accept: "application/json", "content-type": "application/json" },
      body: { decidedBy: "test" },
    });
    assert.equal(approved.statusCode, 202, approved.body);
    const approvedData = JSON.parse(approved.body).data as {
      execution: { state: string };
      launch: { mode: string; tmuxSession: string };
    };
    assert.equal(approvedData.execution.state, "ready");
    assert.equal(approvedData.launch.mode, "tmux");
    assert.equal(approvedData.launch.tmuxSession, "interactive-project");
    assert.ok(store.listEvents().some((event) => event.type === "workflow.launch_ready"));
    const cancelled = await handle.inject({
      method: "POST",
      url: `/actions/executions/${pendingData.execution.id}/cancel`,
      headers: { accept: "application/json" },
    });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(JSON.parse(cancelled.body).data.execution.state, "cancelled");
    assert.equal(store.workflows.getLaunchForExecution(pendingData.execution.id)?.launch.state, "cancelled");
    const authorizeCancelled = await handle.inject({
      method: "POST",
      url: `/actions/executions/${pendingData.execution.id}/launch/authorize`,
      headers: { accept: "application/json", "content-type": "application/json" },
      body: {},
    });
    assert.equal(authorizeCancelled.statusCode, 409);
  } finally {
    await handle.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("isolated workflows retain review artifacts without mutating the canonical project", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-workflow-isolated-"));
  await writeFile(join(workspace, "app.py"), "value = 1\n");
  const store = createStore(initializeStore(join(workspace, "workbench.db")));
  const project = store.createProject({ path: workspace, name: "Isolated Project" });
  const isolated = command("compile", "python3", ["-m", "compileall", "app.py"], "workspace_write");
  isolated.executionMode = "isolated";
  isolated.expectedArtifacts = [{ id: "bytecode", path: "__pycache__", kind: "directory", required: true }];
  const manifest: ProjectManifest = {
    ...fixture.ProjectManifest,
    id: project.id,
    name: project.name,
    path: project.path,
    repositoryRoot: project.path,
    approvedRoots: [project.path],
    commands: { isolated },
  };
  store.projectRegistry.saveApprovedManifest(project.id, manifest, "test");
  const handle = await startWorkbenchServer({
    store,
    inProcess: true,
    config: { databasePath: join(workspace, "workbench.db"), runtimeDir: join(workspace, "runtime"), apiPort: 0 },
  });
  try {
    const downgrade = await handle.inject({
      method: "POST",
      url: "/actions/compile/run",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: { projectId: project.id, executionMode: "terminal" },
    });
    assert.equal(downgrade.statusCode, 409);
    assert.match(downgrade.body, /override is valid only/);
    const pending = await handle.inject({
      method: "POST",
      url: "/actions/compile/run",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: { projectId: project.id },
    });
    assert.equal(pending.statusCode, 202);
    const executionId = JSON.parse(pending.body).data.execution.id as string;
    await assert.rejects(access(join(workspace, "__pycache__")));

    const approved = await handle.inject({
      method: "POST",
      url: `/actions/executions/${executionId}/approve`,
      headers: { accept: "application/json", "content-type": "application/json" },
      body: { decidedBy: "test" },
    });
    assert.equal(approved.statusCode, 200, approved.body);
    const completed = JSON.parse(approved.body).data as {
      execution: { state: string; artifacts: string[] };
      command: { workingDirectory: string };
    };
    assert.equal(completed.execution.state, "completed");
    assert.equal(completed.execution.artifacts.length, 2);
    assert.equal(completed.command.workingDirectory, completed.execution.artifacts[0]);
    assert.equal(completed.execution.artifacts[1], join(completed.execution.artifacts[0] ?? "", "__pycache__"));
    await access(completed.execution.artifacts[1] ?? "");
    await assert.rejects(access(join(workspace, "__pycache__")));
  } finally {
    await handle.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
