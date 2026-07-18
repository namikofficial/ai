import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type ProjectManifest, projectStatusSchema } from "../packages/contracts/src/index.ts";
import { createStore, initializeStore } from "../packages/db/src/store.ts";
import {
  buildProjectStatus,
  type CommandResult,
  type CommandRunner,
  collectComposeStatus,
  collectGitChangedPaths,
  collectGitStatus,
  compactProjectStatus,
  defaultProjectStatusCachePath,
  detectPackageManager,
  parseGitChangedPaths,
  parseGitPorcelainV2,
  recommendedActionsFromManifest,
  writeProjectStatusCache,
} from "../packages/project-status/src/index.ts";

function result(stdout = "", stderr = "", exitCode = 0): CommandResult {
  return { stdout, stderr, exitCode, timedOut: false };
}

test("Git porcelain v2 covers untracked-only, staged, renamed, conflicts, detached, unborn, stash and divergence", () => {
  const status = parseGitPorcelainV2(`
# branch.oid (initial)
# branch.head (detached)
# branch.ab +3 -2
# stash 4
1 M. N... 000000 000000 000000 aaaaa bbbbb staged.ts
1 .M N... 000000 000000 000000 aaaaa bbbbb modified.ts
1 .D N... 000000 000000 000000 aaaaa bbbbb deleted.ts
2 R. N... 000000 000000 000000 aaaaa bbbbb R100 renamed.ts\toriginal.ts
u UU N... 000000 000000 000000 000000 aaaaa bbbbb ccccc conflict.ts
? new-file.ts
`);
  assert.equal(status.unborn, true);
  assert.equal(status.detached, true);
  assert.equal(status.ahead, 3);
  assert.equal(status.behind, 2);
  assert.equal(status.stashes, 4);
  assert.equal(status.staged, 2);
  assert.equal(status.modified, 2);
  assert.equal(status.deleted, 1);
  assert.equal(status.renamed, 1);
  assert.equal(status.conflicts, 1);
  assert.equal(status.untracked, 1);
  assert.equal(status.dirty, true);
});

test("Git changed-file collection preserves spaces and rename destinations", async () => {
  const porcelain = " M src/with space.ts\0R  src/new.ts\0src/old.ts\0?? new-file.ts\0";
  assert.deepEqual(parseGitChangedPaths(porcelain), ["src/with space.ts", "src/new.ts", "new-file.ts"]);
  const calls: string[][] = [];
  const runner: CommandRunner = {
    async run(binary, args) {
      calls.push([binary, ...args]);
      return result(porcelain);
    },
  };
  assert.deepEqual((await collectGitChangedPaths("/project", runner)).paths, [
    "src/with space.ts",
    "src/new.ts",
    "new-file.ts",
  ]);
  assert.deepEqual(calls[0], ["git", "status", "--porcelain=v1", "-z", "--untracked-files=normal"]);
});

test("Git collection uses porcelain v2 and treats untracked-only repositories as dirty", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    async run(binary, args) {
      calls.push([binary, ...args]);
      return result("# branch.oid abc123\n# branch.head main\n? only-untracked.txt\n");
    },
  };
  const collected = await collectGitStatus("/project", runner);
  assert.equal(collected.status?.dirty, true);
  assert.equal(collected.status?.untracked, 1);
  assert.deepEqual(calls[0], [
    "git",
    "status",
    "--porcelain=v2",
    "--branch",
    "--show-stash",
    "--untracked-files=normal",
  ]);
});

test("Compose discovery uses config --services so volumes cannot be reported as services", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    async run(binary, args) {
      calls.push([binary, ...args]);
      if (args.includes("config")) return result("api\ndb\n");
      return result(
        `${JSON.stringify({ Service: "api", State: "running", Health: "healthy", Status: "Up" })}\n${JSON.stringify({ Service: "db", State: "exited", Status: "Exited (1)" })}\n`
      );
    },
  };
  const collected = await collectComposeStatus("/project", runner, ["compose.yml"], ["dev"]);
  assert.deepEqual(
    collected.services.map((service) => [service.name, service.state]),
    [
      ["api", "ready"],
      ["db", "offline"],
    ]
  );
  assert.ok(!collected.services.some((service) => service.name === "volumes"));
  assert.deepEqual(calls[0], [
    "docker",
    "compose",
    "--file",
    "compose.yml",
    "--profile",
    "dev",
    "config",
    "--services",
  ]);
});

test("Compose distinguishes missing configuration and inaccessible Docker", async () => {
  const missing: CommandRunner = {
    async run() {
      return result("", "no configuration file provided", 1);
    },
  };
  const offline: CommandRunner = {
    async run() {
      return result("", "Cannot connect to the Docker daemon", 1);
    },
  };
  assert.equal((await collectComposeStatus("/project", missing)).state, "unknown");
  assert.equal((await collectComposeStatus("/project", offline)).state, "offline");
});

test("Compose reports unhealthy containers as failed and absent containers as stopped", async () => {
  const runner: CommandRunner = {
    async run(_binary, args) {
      if (args.includes("config")) return result("api\nworker\n");
      return result(JSON.stringify({ Service: "api", State: "running", Health: "unhealthy" }));
    },
  };
  const collected = await collectComposeStatus("/project", runner);
  assert.equal(collected.state, "failed");
  assert.equal(collected.services.find((service) => service.name === "api")?.state, "failed");
  assert.equal(collected.services.find((service) => service.name === "worker")?.detail, "stopped");
});

test("package manager detection honors manifest configuration and bounded root markers", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-package-manager-"));
  await mkdir(join(workspace, "nested"));
  await writeFile(join(workspace, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  assert.equal(await detectPackageManager(workspace), "pnpm");
  assert.equal(await detectPackageManager(workspace, "cargo"), "cargo");
  await rm(workspace, { recursive: true, force: true });
});

test("package manager detection supports every declared project ecosystem", async () => {
  const cases = [
    ["pnpm-lock.yaml", "pnpm"],
    ["package-lock.json", "npm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["Cargo.toml", "cargo"],
    ["uv.lock", "uv"],
    ["poetry.lock", "poetry"],
    ["build.gradle.kts", "gradle"],
    ["pom.xml", "maven"],
    ["go.mod", "go"],
    ["Makefile", "make"],
    ["justfile", "just"],
  ] as const;
  for (const [marker, expected] of cases) {
    const workspace = await mkdtemp(join(tmpdir(), "ai-package-marker-"));
    await writeFile(join(workspace, marker), "\n");
    assert.equal(await detectPackageManager(workspace), expected, marker);
    await rm(workspace, { recursive: true, force: true });
  }
});

test("recommended actions come from canonical manifest commands without inventing npm scripts", () => {
  const manifest = {
    id: "project",
    commands: {
      verify: {
        id: "verify",
        name: "Verify",
        description: "Run checks",
        category: "check",
        executable: "just",
        arguments: ["verify"],
        workingDirectory: null,
        environmentRefs: [],
        interactive: false,
        mutation: "read_only",
        timeoutSeconds: 60,
        requiresCapabilities: [],
        visibleWhen: [],
      },
    },
  } as unknown as ProjectManifest;
  const actions = recommendedActionsFromManifest(manifest, "2026-07-18T00:00:00.000Z");
  assert.equal(actions[0]?.workflowId, "verify");
  assert.equal(actions[0]?.approvalRequired, false);
  assert.equal(actions[0]?.state, "ready");
  assert.equal(actions[0]?.disabledReason, null);
  assert.ok(!JSON.stringify(actions).includes("npm run dev"));
});

test("recommended actions expose policy reasons for commands the direct executor cannot run", () => {
  const manifest = {
    id: "project",
    commands: {
      deploy: {
        id: "deploy",
        name: "Deploy",
        description: "Deploy the project",
        category: "development",
        executable: "just",
        arguments: ["deploy"],
        workingDirectory: null,
        environmentRefs: ["deploy-token"],
        interactive: false,
        mutation: "external",
        timeoutSeconds: 60,
        requiresCapabilities: [],
        visibleWhen: [],
      },
    },
  } as unknown as ProjectManifest;
  const [action] = recommendedActionsFromManifest(manifest, "2026-07-18T00:00:00.000Z");
  assert.equal(action?.state, "waiting");
  assert.equal(action?.approvalRequired, true);
  assert.match(action?.disabledReason ?? "", /approval/i);
});

test("compact status is human-readable and the offline cache is atomic and versioned", async () => {
  const fixtures = JSON.parse(
    await readFile(new URL("./fixtures/contracts/v1-control-plane.json", import.meta.url), "utf8")
  ) as { ProjectStatus: Parameters<typeof compactProjectStatus>[0] };
  const compact = compactProjectStatus(fixtures.ProjectStatus);
  assert.ok(compact.tooltip.includes("Git:"));
  assert.ok(!compact.tooltip.includes("{"));
  const workspace = await mkdtemp(join(tmpdir(), "ai-project-status-cache-"));
  const cachePath = join(workspace, "nested", "status.json");
  await writeProjectStatusCache(fixtures.ProjectStatus, cachePath);
  const raw = JSON.parse(await readFile(cachePath, "utf8")) as { schemaVersion: number; compact: unknown };
  assert.equal(raw.schemaVersion, 1);
  assert.ok(raw.compact);
  assert.ok(defaultProjectStatusCachePath().endsWith("project-status-v1.json"));
  await rm(workspace, { recursive: true, force: true });
});

test("aggregated project status scopes checks and actions to the canonical selected project", async () => {
  const fixtureData = JSON.parse(
    await readFile(new URL("./fixtures/contracts/v1-control-plane.json", import.meta.url), "utf8")
  ) as { ProjectManifest: ProjectManifest };
  const store = createStore(initializeStore(":memory:"));
  const project = store.createProject({ path: "/projects/selected", name: "Selected" });
  const other = store.createProject({ path: "/projects/other", name: "Other" });
  const manifest = {
    ...fixtureData.ProjectManifest,
    id: project.id,
    name: project.name,
    path: project.path,
    repositoryRoot: project.path,
    approvedRoots: [project.path],
  };
  store.projectRegistry.saveApprovedManifest(project.id, manifest, "test");
  store.projectRegistry.selectProject(project.id, "test", "persistent");
  store.createCheckRun({ projectId: project.id, name: "verify", status: "failed", exitCode: 1 });
  store.createCheckRun({ projectId: other.id, name: "foreign", status: "failed", exitCode: 1 });
  const runner: CommandRunner = {
    async run(binary, args) {
      if (binary === "git") return result("# branch.oid abc123\n# branch.head main\n");
      if (args.includes("config")) return result("");
      return result("");
    },
  };
  const status = await buildProjectStatus(store, { runner, now: "2026-07-18T00:00:00.000Z" });
  assert.equal(projectStatusSchema.parse(status).project?.id, project.id);
  assert.equal(status.checks.failed, 1);
  assert.equal(
    status.blockers.some((blocker) => blocker.code === "checks_failed"),
    true
  );
  assert.equal(status.recommendedActions[0]?.projectId, project.id);
  store.db.close();
});
