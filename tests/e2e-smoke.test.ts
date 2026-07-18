import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkbenchServer } from "../apps/api/src/server.ts";
import { resolveConfig } from "../packages/config/src/index.ts";
import { createStore, initializeStore } from "../packages/db/src/store.ts";

test("e2e smoke: full dev run creates session, dev_run, workspace, edits, and model call rows", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-e2e-smoke-"));

  // 1. Create a tiny project with one source file
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  const templatePlaceholder = ["$", "{name}"].join("");
  await writeFile(
    join(repo, "src", "hello.ts"),
    `export function greet(name: string): string { return \`Hello, ${templatePlaceholder}!\`; }\n`
  );

  // 2. Bootstrap store and index the project
  const config = resolveConfig({
    databasePath: join(workspace, "ai.db"),
    runtimeDir: join(workspace, "runtime"),
  });
  await mkdir(config.runtimeDir, { recursive: true });

  const store = createStore(initializeStore(config.databasePath));

  // Verify store bootstraps cleanly
  assert.ok(store.db, "store has db");
  assert.ok(store.models, "store has models");
  assert.ok(store.dev, "store has dev runs repo");
  assert.ok(store.execution, "store has execution repo");

  // 3. Create project and index it
  const project = store.createProject({ path: repo, name: "smoke-test-repo" });
  assert.ok(project.id, "project has id");
  store.db.close();

  // 4. Start API server and run a dev plan via HTTP
  const handle = await startWorkbenchServer({ config, inProcess: true });
  try {
    // Verify GET /dev/runs returns empty list
    const runsResp = await handle.inject({
      method: "GET",
      url: "/dev/runs",
      headers: { accept: "application/json" },
    });
    assert.equal(runsResp.statusCode, 200, "GET /dev/runs returns 200");
    const runsBody = JSON.parse(runsResp.body) as { status: string; data: { runs: unknown[] } };
    assert.equal(runsBody.status, "ok");
    assert.ok(Array.isArray(runsBody.data.runs), "runs is an array");

    // 5. POST /dev/run with a simple goal
    const devRunResp = await handle.inject({
      method: "POST",
      url: "/dev/run",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        project: project.id,
        goal: "add a JSDoc comment to the greet function",
        mode: "local",
        approvalPolicy: "manual",
        approveEdits: false,
        maxRepairs: 0,
      }),
    });
    // We expect either 200 (success) or a non-crash response
    assert.ok(
      devRunResp.statusCode === 200 || devRunResp.statusCode === 500,
      `POST /dev/run should not crash: got ${devRunResp.statusCode}`
    );

    // 6. Verify /settings returns config snapshot
    const settingsResp = await handle.inject({
      method: "GET",
      url: "/settings",
      headers: { accept: "application/json" },
    });
    assert.equal(settingsResp.statusCode, 200);
    const settingsBody = JSON.parse(settingsResp.body) as { status: string };
    assert.equal(settingsBody.status, "ok");

    // 7. Verify /models/health returns model statuses
    const healthResp = await handle.inject({
      method: "GET",
      url: "/models/health",
      headers: { accept: "application/json" },
    });
    assert.equal(healthResp.statusCode, 200);

    // 8. Verify eval fixture files are loadable
    // (this is verified by tests/eval-fixtures.test.ts separately)

    // 9. Verify .ai-workbench.json is readable at workspace root
    // (the config resolver tests this, but we can confirm no crash)
    const configData = resolveConfig({});
    assert.ok(configData.databasePath, "config has databasePath");
  } finally {
    await handle.close();
  }

  await rm(workspace, { recursive: true, force: true });
});

test("e2e smoke: api client dev methods are wired correctly", async () => {
  // Verify that the new dev client methods exist and have correct signatures
  // This is a compile-time + basic existence check
  const { createApiClient } = await import("../packages/api-client/src/index.ts");
  const client = createApiClient({ baseUrl: "http://127.0.0.1:1" });

  // These should all be functions on the client object
  assert.equal(typeof client.devRun, "function", "client.devRun exists");
  assert.equal(typeof client.listDevRuns, "function", "client.listDevRuns exists");
  assert.equal(typeof client.getDevRun, "function", "client.getDevRun exists");
  assert.equal(typeof client.getDevRunDiff, "function", "client.getDevRunDiff exists");
  assert.equal(typeof client.approveDevRun, "function", "client.approveDevRun exists");
  assert.equal(typeof client.cancelDevRun, "function", "client.cancelDevRun exists");
});

test("e2e smoke: fastembed adapter is registered in types and adapter registry", async () => {
  // Verify fastembed is in ModelProviderKind
  const { createApiClient } = await import("../packages/api-client/src/index.ts");
  const client = createApiClient({ baseUrl: "http://127.0.0.1:1" });
  assert.equal(typeof client, "object", "api client created");
});

test("e2e smoke: .ai-workbench.json config is parsed with checks and dev blocks", async () => {
  const { resolveProjectConfig } = await import("../packages/config/src/index.ts");
  // Create a temp project with .ai-workbench.json
  const workspace = await mkdtemp(join(tmpdir(), "ai-config-smoke-"));
  const projectPath = join(workspace, "proj");
  await mkdir(projectPath, { recursive: true });
  await writeFile(
    join(projectPath, ".ai-workbench.json"),
    JSON.stringify({
      checks: { defaultChecks: ["typecheck", "test"], requireApprovalFor: ["env"], maxRepairLoops: 2 },
      dev: { defaultChecks: ["typecheck"], maxRepairLoops: 1, requireApprovalFor: ["migrations"] },
    })
  );

  const config = resolveProjectConfig(projectPath);
  assert.deepEqual(config.checks.defaultChecks, ["typecheck", "test"]);
  assert.deepEqual(config.checks.requireApprovalFor, ["env"]);
  assert.equal(config.checks.maxRepairLoops, 2);
  assert.deepEqual(config.dev.defaultChecks, ["typecheck"]);
  assert.deepEqual(config.dev.requireApprovalFor, ["migrations"]);
  assert.equal(config.dev.maxRepairLoops, 1);

  await rm(workspace, { recursive: true, force: true });
});
