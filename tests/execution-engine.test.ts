import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyStructuredPatch,
  applyWorkspaceToOriginal,
  createTaskWorkspace,
  guardPath,
  listProjectFiles,
  readProjectChecksConfig,
  readProjectFile,
  resolveCheckCommand,
  runAllowedChecks,
  runValidationPipeline,
  searchProjectText,
  writeProjectFile,
} from "../packages/execution-engine/src/index.ts";

async function makeProject(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "ai-exec-engine-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "index.ts"), "export const answer = 41;\n");
  await writeFile(join(root, "src", "auth.ts"), "export const login = 'ok';\n");
  await writeFile(join(root, ".env"), "TOKEN=secret\n");
  return {
    root,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("execution-engine: guardPath blocks escape attempts", async () => {
  const project = await makeProject();
  try {
    const inside = guardPath({ root: project.root, candidate: "src/index.ts" });
    assert.equal(inside.ok, true);

    const escaped = guardPath({ root: project.root, candidate: "../outside.ts" });
    assert.equal(escaped.ok, false);
    assert.match(escaped.reason, /escapes root/);
  } finally {
    await project.cleanup();
  }
});

test("execution-engine: list/search helpers stay inside safe project files", async () => {
  const project = await makeProject();
  try {
    const files = await listProjectFiles({ root: project.root, glob: "src/*.ts" });
    assert.deepEqual(files.sort(), ["src/auth.ts", "src/index.ts"]);
    assert.ok(!files.includes(".env"));

    const matches = await searchProjectText({ root: project.root, query: "login" });
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.path, "src/auth.ts");
  } finally {
    await project.cleanup();
  }
});

test("execution-engine: file helpers refuse repository symlinks", async () => {
  const project = await makeProject();
  const outside = await mkdtemp(join(tmpdir(), "ai-exec-outside-"));
  try {
    const externalFile = join(outside, "secret.txt");
    await writeFile(externalFile, "outside secret\n");
    await symlink(externalFile, join(project.root, "src", "linked.txt"));

    await assert.rejects(readProjectFile(project.root, "src/linked.txt"), /symbolic link/);
    const write = await writeProjectFile({
      root: project.root,
      candidate: "src/linked.txt",
      contents: "overwritten\n",
      overwrite: true,
    });
    assert.equal(write.ok, false);
    assert.match(write.reason, /symbolic link/);
    assert.equal(await readFile(externalFile, "utf8"), "outside secret\n");

    const matches = await searchProjectText({ root: project.root, query: "outside secret" });
    assert.deepEqual(matches, []);
  } finally {
    await rm(outside, { recursive: true, force: true });
    await project.cleanup();
  }
});

test("execution-engine: structured patches cannot escape the workspace root", async () => {
  const project = await makeProject();
  try {
    const results = await applyStructuredPatch({
      root: project.root,
      edits: [
        {
          path: "src/index.ts",
          changeType: "replace",
          oldText: "41",
          newText: "42",
        },
        {
          path: "../outside.ts",
          changeType: "create",
          newText: "nope",
        },
      ],
    });
    assert.equal(results[0]?.ok, true);
    assert.equal(results[1]?.ok, false);
    assert.match(results[1]?.reason ?? "", /escapes root/);
    assert.match(await readFile(join(project.root, "src", "index.ts"), "utf8"), /42/);
  } finally {
    await project.cleanup();
  }
});

test("execution-engine: check allowlist blocks unknown commands and parses evidence", async () => {
  const project = await makeProject();
  try {
    const result = await runAllowedChecks({
      cwd: project.root,
      commandNames: ["unknown-check"],
      projectConfig: readProjectChecksConfig({ checks: {} }),
      timeoutMs: 1000,
    });
    assert.equal(result[0]?.status, "blocked");
    assert.equal(result[0]?.exitCode, null);
    assert.ok(result[0]?.parsedErrors.some((line) => line.includes("not in the allowlist")));
  } finally {
    await project.cleanup();
  }
});

test("execution-engine: workspaces use runtime/dev-runs/<runId>/workspace", async () => {
  const project = await makeProject();
  const runtime = await mkdtemp(join(tmpdir(), "ai-runtime-"));
  try {
    const created = await createTaskWorkspace({
      projectPath: project.root,
      runtimeDir: runtime,
      runId: "run_123",
      sessionId: "session_abc",
    });
    assert.match(created.workspace.path, /dev-runs\/run_run_123\/workspace$/);
    await created.cleanup();
  } finally {
    await rm(runtime, { recursive: true, force: true });
    await project.cleanup();
  }
});

test("execution-engine: apply refuses workspace and target symlink escapes", async () => {
  const project = await makeProject();
  const runtime = await mkdtemp(join(tmpdir(), "ai-runtime-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "ai-outside-"));
  try {
    const created = await createTaskWorkspace({
      projectPath: project.root,
      runtimeDir: runtime,
      runId: "run_symlink",
      sessionId: "session_symlink",
      strategy: "safe_copy",
    });
    await rm(join(created.workspace.path, "src", "index.ts"));
    await writeFile(join(outside, "secret.ts"), "outside\n");
    await symlink(join(outside, "secret.ts"), join(created.workspace.path, "src", "index.ts"));
    await assert.rejects(
      applyWorkspaceToOriginal({
        workspace: created.workspace,
        originalRoot: project.root,
        paths: ["src/index.ts"],
        allowedRoots: [project.root],
      }),
      /symlink/
    );

    await mkdir(join(created.workspace.path, "linked"), { recursive: true });
    await writeFile(join(created.workspace.path, "linked", "escape.ts"), "escape\n");
    await symlink(outside, join(project.root, "linked"));
    await assert.rejects(
      applyWorkspaceToOriginal({
        workspace: created.workspace,
        originalRoot: project.root,
        paths: ["linked/escape.ts"],
        allowedRoots: [project.root],
      }),
      /symlink/
    );
    await created.cleanup();
  } finally {
    await rm(runtime, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
    await project.cleanup();
  }
});

test("execution-engine: apply refuses changed branch and dirty reviewed paths", async () => {
  const project = await makeProject();
  const runtime = await mkdtemp(join(tmpdir(), "ai-runtime-branch-"));
  try {
    execFileSync("git", ["init"], { cwd: project.root });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: project.root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: project.root });
    execFileSync("git", ["add", "src/index.ts", "src/auth.ts"], { cwd: project.root });
    execFileSync("git", ["commit", "-m", "fixture"], { cwd: project.root });
    const created = await createTaskWorkspace({
      projectPath: project.root,
      runtimeDir: runtime,
      runId: "run_branch",
      sessionId: "session_branch",
      strategy: "git_worktree",
    });
    await writeFile(join(created.workspace.path, "src", "index.ts"), "export const answer = 42;\n");

    execFileSync("git", ["switch", "-c", "other-branch"], { cwd: project.root });
    await assert.rejects(
      applyWorkspaceToOriginal({
        workspace: created.workspace,
        originalRoot: project.root,
        paths: ["src/index.ts"],
        allowedRoots: [project.root],
      }),
      /branch changed/
    );

    execFileSync("git", ["switch", created.workspace.originalBranch ?? "master"], { cwd: project.root });
    await writeFile(join(project.root, "src", "index.ts"), "export const answer = 99;\n");
    await assert.rejects(
      applyWorkspaceToOriginal({
        workspace: created.workspace,
        originalRoot: project.root,
        paths: ["src/index.ts"],
        allowedRoots: [project.root],
      }),
      /reviewed patch paths changed/
    );
    await created.cleanup();
  } finally {
    await rm(runtime, { recursive: true, force: true });
    await project.cleanup();
  }
});

test("execution-engine: new security checks resolve as builtins", () => {
  const config = readProjectChecksConfig({ checks: {} });
  for (const name of ["semgrep", "osv", "playwright"]) {
    const spec = resolveCheckCommand(name, config);
    assert.ok(spec, `expected builtin check to resolve: ${name}`);
    assert.equal(spec?.id, name);
  }
});

test("execution-engine: validation pipeline runs in order and stops at first failure", async () => {
  const project = await makeProject();
  try {
    const config = readProjectChecksConfig({
      checks: {
        pass: "echo ok",
        fail: "false",
        pass2: "echo again",
      },
    });
    const pipeline = await runValidationPipeline({
      cwd: project.root,
      projectConfig: config,
      checks: ["pass", "fail", "pass2"],
      timeoutMs: 10_000,
    });
    assert.equal(pipeline.results.length, 2, "pipeline should stop after the failing check");
    assert.equal(pipeline.results[0]?.name, "pass");
    assert.equal(pipeline.results[0]?.status, "completed");
    assert.equal(pipeline.results[1]?.name, "fail");
    assert.equal(pipeline.results[1]?.status, "failed");
    assert.equal(pipeline.stoppedAt, "fail");
    assert.equal(pipeline.allPassed, false);
  } finally {
    await project.cleanup();
  }
});

test("execution-engine: validation pipeline records blocked unknown check and stops", async () => {
  const project = await makeProject();
  try {
    const config = readProjectChecksConfig({ checks: {} });
    const pipeline = await runValidationPipeline({
      cwd: project.root,
      projectConfig: config,
      checks: ["definitely-unknown", "typecheck"],
      timeoutMs: 10_000,
    });
    assert.equal(pipeline.results.length, 1);
    assert.equal(pipeline.results[0]?.status, "blocked");
    assert.equal(pipeline.stoppedAt, "definitely-unknown");
    assert.equal(pipeline.allPassed, false);
  } finally {
    await project.cleanup();
  }
});

test("execution-engine: validation pipeline rejects denied binaries in project checks", async () => {
  const project = await makeProject();
  try {
    const config = readProjectChecksConfig({ checks: { wipe: "rm -rf /" } });
    const spec = resolveCheckCommand("wipe", config);
    assert.equal(spec, null, "denied binary must not resolve to a command");
    const pipeline = await runValidationPipeline({
      cwd: project.root,
      projectConfig: config,
      checks: ["wipe"],
      timeoutMs: 10_000,
    });
    assert.equal(pipeline.results[0]?.status, "blocked");
  } finally {
    await project.cleanup();
  }
});

test("execution-engine: validation pipeline continues on failure when requested", async () => {
  const project = await makeProject();
  try {
    const config = readProjectChecksConfig({
      checks: {
        fail: "false",
        pass: "echo ok",
      },
    });
    const pipeline = await runValidationPipeline({
      cwd: project.root,
      projectConfig: config,
      checks: ["fail", "pass"],
      continueOnFailure: true,
      timeoutMs: 10_000,
    });
    assert.equal(pipeline.results.length, 2);
    assert.equal(pipeline.results[0]?.status, "failed");
    assert.equal(pipeline.results[1]?.status, "completed");
    assert.equal(pipeline.stoppedAt, null);
    assert.equal(pipeline.allPassed, false);
  } finally {
    await project.cleanup();
  }
});
