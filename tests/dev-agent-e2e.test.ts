import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DevEdit, DevRun } from "../packages/shared/src/index.ts";
import { createId } from "../packages/shared/src/index.ts";

// ---------------------------------------------------------------------------
// End-to-end test: approve → apply flow
//
// Verifies:
// 1. approveDevRun transitions a run from awaiting_approval to approved
// 2. applyApprovedDevRun copies workspace files back to the original project
// ---------------------------------------------------------------------------

import { applyApprovedDevRun, approvalContextHash, approveDevRun } from "../packages/dev-agent/src/index.ts";
import { createTaskWorkspace } from "../packages/execution-engine/src/index.ts";

test("approveDevRun: transitions awaiting_approval run to approved", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-approve-test-"));
  const projectPath = join(workspace, "repo");
  await mkdir(join(projectPath, "src"), { recursive: true });
  await writeFile(join(projectPath, "src", "index.ts"), "export const x = 1;\n");

  const runs: Array<{ id: string; status: string; sessionId: string; projectId: string; goal: string }> = [];
  const approvals: Array<{
    id: string;
    runId: string;
    status: "pending" | "approved" | "rejected";
    decidedBy: string | null;
  }> = [];

  const devRuns: any = {
    createRun: (input: any) => {
      const run = { id: createId("run"), status: "awaiting_approval", ...input };
      runs.push(run);
      return run;
    },
    updateRun: (id: string, updates: any) => {
      const run = runs.find((r) => r.id === id);
      if (run) Object.assign(run, updates);
      return run;
    },
    getRun: (id: string) => runs.find((r) => r.id === id) ?? null,
    addEdit: () => createId("ed"),
    listEdits: () => [] as DevEdit[],
    listRuns: () => runs,
    getRunWithEdits: () => null,
  };

  const execution: any = {
    listApprovals: (runId: string) => approvals.filter((a) => a.runId === runId),
    createApproval: (input: any) => {
      const approval = { id: createId("appr"), status: "pending" as const, ...input };
      approvals.push(approval);
      return approval;
    },
    decideApproval: (input: any) => {
      const approval = approvals.find((a) => a.id === input.id);
      if (approval) {
        approval.status = input.status as "approved" | "rejected";
        approval.decidedBy = input.decidedBy;
      }
    },
    getWorkspaceForRun: (runId: string) => ({
      id: "ws_approve",
      runId,
      projectId: "proj_1",
      path: projectPath,
      strategy: "safe_copy",
      branch: null,
      baseCommit: null,
      originalBranch: null,
      isGitWorktree: false,
      originalRoot: projectPath,
    }),
    createWorkspace: () => null,
    recordPatch: () => {},
  };

  const runtime = { devRuns, execution };

  const run = devRuns.createRun({
    sessionId: "sess_1",
    projectId: "proj_1",
    goal: "add y",
    mode: "local",
    approvalPolicy: "manual",
  });

  execution.createApproval({
    runId: run.id,
    projectId: "proj_1",
    policy: "manual",
    risk: "low",
    requiresExplicit: false,
    reason: "test",
    contextHash: approvalContextHash({
      runId: run.id,
      projectId: "proj_1",
      diffText: "",
      paths: [],
      baseCommit: null,
      originalBranch: null,
    }),
  });

  const result = await approveDevRun({ runId: run.id, runtime, decidedBy: "test-user" });

  assert.equal(result.ok, true);
  assert.equal(result.run?.status, "approved");
  assert.match(result.run?.summary ?? "", /Approved|approved/i);

  await rm(workspace, { recursive: true, force: true });
});

test("applyApprovedDevRun: copies workspace files back to original", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-apply-test-"));
  const projectPath = join(workspace, "repo");
  const srcDir = join(projectPath, "src");
  await mkdir(srcDir, { recursive: true });
  await writeFile(join(srcDir, "index.ts"), "export const x = 1;\n");

  const runtimeDir = await mkdtemp(join(tmpdir(), "ai-runtime-"));

  // Create a real isolated workspace.
  const created = await createTaskWorkspace({
    projectPath,
    runtimeDir,
    runId: "run_apply_test",
    sessionId: "sess_apply",
  });

  // Apply simulated edits inside the workspace.
  await writeFile(join(created.workspace.path, "src", "index.ts"), "export const x = 2;\n");
  await writeFile(join(created.workspace.path, "src", "new.ts"), "export const y = 3;\n");

  // Build minimal runtime with real workspace via execution repo.
  const runs: Array<{ id: string; status: string; appliedFiles?: string[] }> = [];
  const workspaces: Array<{ id: string; runId: string; path: string; originalRoot: string }> = [];
  const patches: Array<{ id: string; runId: string; applied: string[] }> = [];

  const devRuns: any = {
    createRun: (input: any) => {
      const run = { id: input.id ?? createId("run"), status: "approved", ...input };
      runs.push(run);
      return run;
    },
    updateRun: (id: string, updates: any) => {
      const run = runs.find((r) => r.id === id);
      if (run) Object.assign(run, updates);
    },
    getRun: (id: string) => runs.find((r) => r.id === id) ?? null,
    addEdit: () => createId("ed"),
    listEdits: () => [
      {
        id: createId("e1"),
        path: "src/index.ts",
        reason: "x",
        newText: "",
        changeType: "replace" as const,
        status: "applied",
        risk: "low" as const,
        blockedReason: null,
        errorMessage: null,
      },
      {
        id: createId("e2"),
        path: "src/new.ts",
        reason: "x",
        newText: "export const y = 3;",
        changeType: "create" as const,
        status: "applied",
        risk: "low" as const,
        blockedReason: null,
        errorMessage: null,
      },
    ],
    listRuns: () => runs,
    getRunWithEdits: () => null,
  };

  const execution: any = {
    createWorkspace: (input: any) => {
      const ws = { id: createId("ws"), ...input };
      workspaces.push(ws);
      return ws;
    },
    getWorkspaceForRun: (runId: string) => workspaces.find((w) => w.runId === runId) ?? null,
    recordPatch: (input: any) => {
      patches.push({ id: createId("patch"), ...input });
    },
  };

  const runtime = { devRuns, execution };

  const run = devRuns.createRun({
    id: "run_apply_test",
    sessionId: "sess_apply",
    projectId: "proj_1",
    goal: "apply test",
  });
  execution.createWorkspace({
    runId: run.id,
    projectId: "proj_1",
    strategy: created.workspace.strategy,
    path: created.workspace.path,
    branch: created.workspace.branch,
    isGitWorktree: created.workspace.isGitWorktree,
    baseCommit: created.workspace.baseCommit,
    originalBranch: created.workspace.originalBranch,
    originalRoot: projectPath,
  });

  execution.listApprovals = () => [
    {
      id: "approval_apply",
      runId: run.id,
      projectId: "proj_1",
      status: "approved",
      contextHash: approvalContextHash({
        runId: run.id,
        projectId: "proj_1",
        diffText: "",
        paths: ["src/index.ts", "src/new.ts"],
        baseCommit: created.workspace.baseCommit,
        originalBranch: created.workspace.originalBranch,
      }),
    },
  ];

  const result = await applyApprovedDevRun({ runId: run.id, projectPath, runtime });

  assert.equal(result.ok, true);
  assert.ok(
    result.applied.length >= 1,
    `expected at least 1 applied file, got ${result.applied.length}: ${JSON.stringify(result.applied)}`
  );

  // Verify original file was mutated.
  const content = await readFile(join(projectPath, "src", "index.ts"), "utf8");
  assert.match(content, /2/);

  await created.cleanup();
  await rm(workspace, { recursive: true, force: true });
  await rm(runtimeDir, { recursive: true, force: true });
});

test("applyApprovedDevRun rejects approval bypass, stale review context, and project confusion", async () => {
  const baseRun = {
    id: "run_guard",
    sessionId: "session_guard",
    projectId: "project_guard",
    status: "awaiting_approval",
    diffText: "reviewed diff",
    createdAt: "2026-07-18T00:00:00.000Z",
  } as unknown as DevRun;
  const workspace = {
    id: "workspace_guard",
    runId: baseRun.id,
    projectId: baseRun.projectId,
    strategy: "safe_copy" as const,
    path: "/tmp/workspace-guard",
    branch: null,
    isGitWorktree: false,
    baseCommit: null,
    originalBranch: null,
    originalRoot: "/tmp/project-guard",
    cleanedUp: false,
    createdAt: baseRun.createdAt,
    updatedAt: baseRun.createdAt,
  };
  const runtimeFor = (run: DevRun, workspaceProjectId = run.projectId, contextHash = "stale") =>
    ({
      devRuns: {
        getRun: () => run,
        listEdits: () => [],
      },
      execution: {
        getWorkspaceForRun: () => ({ ...workspace, projectId: workspaceProjectId }),
        listApprovals: () => [
          {
            id: "approval_guard",
            runId: run.id,
            projectId: run.projectId,
            status: "approved",
            contextHash,
          },
        ],
      },
    }) as unknown as Parameters<typeof applyApprovedDevRun>[0]["runtime"];

  const bypass = await applyApprovedDevRun({
    runId: baseRun.id,
    projectPath: workspace.originalRoot,
    runtime: runtimeFor(baseRun),
  });
  assert.equal(bypass.ok, false);
  assert.match(bypass.error ?? "", /cannot apply.*awaiting_approval/);

  const approvedRun = { ...baseRun, status: "approved" } as DevRun;
  const stale = await applyApprovedDevRun({
    runId: approvedRun.id,
    projectPath: workspace.originalRoot,
    runtime: runtimeFor(approvedRun),
  });
  assert.equal(stale.ok, false);
  assert.match(stale.error ?? "", /no approved decision matches/);

  const confused = await applyApprovedDevRun({
    runId: approvedRun.id,
    projectPath: workspace.originalRoot,
    runtime: runtimeFor(approvedRun, "different-project"),
  });
  assert.equal(confused.ok, false);
  assert.match(confused.error ?? "", /workspace project does not match/);
});
