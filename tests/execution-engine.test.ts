import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyStructuredPatch,
  createTaskWorkspace,
  guardPath,
  listProjectFiles,
  readProjectChecksConfig,
  runAllowedChecks,
  searchProjectText,
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
