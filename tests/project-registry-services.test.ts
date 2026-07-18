import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProjectManifest } from "../packages/contracts/src/index.ts";
import { createStore, initializeStore } from "../packages/db/src/store.ts";
import {
  buildRegistryCache,
  compareConfigPrecedence,
  createWorkbenchBackup,
  diffProjectManifests,
  importLegacyProjectProfiles,
  readRegistryCache,
  refreshRegistryCache,
  validateWorkbenchBackup,
} from "../packages/project-registry/src/index.ts";

const legacySource = `profiles=(dotfiles nox-billings)
path_for() {
  case "$1" in
    dotfiles) printf '%s\\n' "$HOME/Documents/code/dotfiles" ;;
    nox-billings) printf '%s\\n' "$HOME/Documents/code/noxorigin/nox-billings" ;;
  esac
}
check_cmd_for() {
  case "$1" in
    nox-billings) printf '%s\\n' 'pnpm verify' ;;
  esac
}
dev_cmd_for() {
  case "$1:$2" in
    nox-billings:api) printf '%s\\n' 'just api' ;;
  esac
}`;

test("legacy profiles are parsed without executing shell and commands remain approval gated", () => {
  const manifests = importLegacyProjectProfiles(legacySource, {
    home: "/home/test",
    observedAt: "2026-07-18T10:00:00.000Z",
    sourceRef: "project-profile.sh",
  });
  assert.equal(manifests.length, 2);
  const billings = manifests.find((manifest) => manifest.id === "nox-billings");
  assert.ok(billings);
  assert.equal(billings.path, "/home/test/Documents/code/noxorigin/nox-billings");
  assert.equal(billings.packageManager, "pnpm");
  assert.deepEqual(billings.commands.check?.arguments, ["-lc", "pnpm verify"]);
  assert.ok(billings.commands.check?.requiresCapabilities.includes("legacy-shell-approval"));
});

test("registry cache is minimal, secret free, atomic and readable offline", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-registry-cache-"));
  const cachePath = join(workspace, "cache", "registry.json");
  const store = createStore(initializeStore(":memory:"));
  const project = store.createProject({ path: join(workspace, "project"), name: "Project" });
  const manifest = importLegacyProjectProfiles(legacySource, { home: "/home/test" })[0] as ProjectManifest;
  const canonical = {
    ...manifest,
    id: project.id,
    name: project.name,
    path: project.path,
    repositoryRoot: project.path,
    approvedRoots: [project.path],
    secretRefs: ["API_KEY"],
  };
  store.projectRegistry.saveApprovedManifest(project.id, canonical, "test");
  store.projectRegistry.selectProject(project.id, "test", "persistent");
  await refreshRegistryCache(store.projectRegistry, cachePath);
  const raw = await readFile(cachePath, "utf8");
  assert.ok(!raw.includes("API_KEY"));
  assert.ok(!raw.includes("commands"));
  assert.equal((await readRegistryCache(cachePath))?.selection?.projectId, project.id);
  assert.equal(buildRegistryCache([canonical], null).projects[0]?.id, project.id);
  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("manifest diff reports field-level proposed changes", () => {
  const manifest = importLegacyProjectProfiles(legacySource, { home: "/home/test" })[0] as ProjectManifest;
  const changes = diffProjectManifests(manifest, { ...manifest, packageManager: "pnpm" });
  assert.ok(changes.some((change) => change.path === "$.packageManager"));
});

test("configuration precedence keeps manual and persisted settings above detected input", () => {
  assert.ok(compareConfigPrecedence("manual_override", "persisted_workbench") < 0);
  assert.ok(compareConfigPrecedence("persisted_workbench", "approved_project_local") < 0);
  assert.ok(compareConfigPrecedence("imported_legacy", "automatic_detection") < 0);
});

test("SQLite backup is consistent and restore validation records migrations", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-registry-backup-"));
  const databasePath = join(workspace, "workbench.db");
  const backupPath = join(workspace, "backups", "workbench.db");
  const store = createStore(initializeStore(databasePath));
  store.createProject({ path: join(workspace, "project"), name: "Project" });
  const result = await createWorkbenchBackup(store.db, backupPath);
  assert.equal(result.integrity, "ok");
  assert.ok(result.migrations.includes("0014_active_context"));
  assert.equal(validateWorkbenchBackup(backupPath).integrity, "ok");
  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});
