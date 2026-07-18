import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ProjectManifest } from "../packages/contracts/src/index.ts";
import { createStore, initializeStore } from "../packages/db/src/store.ts";

const fixtures = JSON.parse(
  await readFile(new URL("./fixtures/contracts/v1-control-plane.json", import.meta.url), "utf8")
) as { ProjectManifest: ProjectManifest };

function manifestFor(project: { id: string; name: string; path: string }): ProjectManifest {
  return {
    ...fixtures.ProjectManifest,
    id: project.id,
    name: project.name,
    path: project.path,
    repositoryRoot: project.path,
    approvedRoots: [project.path],
  };
}

test("project registry stores only validated manifests for existing projects", () => {
  const store = createStore(initializeStore(":memory:"));
  const project = store.createProject({ path: "/tmp/registry-one", name: "Registry One" });
  const manifest = manifestFor(project);

  const saved = store.projectRegistry.saveApprovedManifest(project.id, manifest, "manual");
  assert.equal(saved.id, project.id);
  assert.deepEqual(store.projectRegistry.getManifest(project.id), manifest);
  assert.equal(store.projectRegistry.listManifests().length, 1);
  assert.throws(
    () => store.projectRegistry.saveApprovedManifest(project.id, { ...manifest, id: "wrong-project" }, "manual"),
    /does not match/
  );
  assert.throws(
    () => store.projectRegistry.saveApprovedManifest("missing", { ...manifest, id: "missing" }, "manual"),
    /unknown project/
  );
  store.db.close();
});

test("manifest proposals require explicit approval before replacing canonical configuration", () => {
  const store = createStore(initializeStore(":memory:"));
  const project = store.createProject({ path: "/tmp/registry-two", name: "Registry Two" });
  const initial = manifestFor(project);
  store.projectRegistry.saveApprovedManifest(project.id, initial, "manual");

  const changed = { ...initial, packageManager: "npm" as const, updatedAt: "2026-07-18T11:00:00.000Z" };
  const proposal = store.projectRegistry.proposeManifest(project.id, changed, ".ai-workbench.json");
  assert.equal(proposal.status, "pending");
  assert.equal(store.projectRegistry.getManifest(project.id)?.packageManager, "pnpm");

  const approved = store.projectRegistry.resolveProposal(proposal.id, "approved", "approved-local-manifest");
  assert.equal(approved.status, "approved");
  assert.equal(store.projectRegistry.getManifest(project.id)?.packageManager, "npm");
  assert.throws(() => store.projectRegistry.resolveProposal(proposal.id, "approved"), /already approved/);
  store.db.close();
});

test("active project selection and pin scope are durable singleton state", () => {
  const db = initializeStore(":memory:");
  const store = createStore(db);
  const first = store.createProject({ path: "/tmp/registry-first", name: "First" });
  const second = store.createProject({ path: "/tmp/registry-second", name: "Second" });

  store.projectRegistry.selectProject(first.id, "workbench", null);
  assert.equal(store.projectRegistry.getSelection()?.projectId, first.id);
  store.projectRegistry.selectProject(second.id, "cli", "persistent");
  assert.deepEqual(store.projectRegistry.getSelection()?.pinScope, "persistent");
  assert.equal(createStore(db).projectRegistry.getSelection()?.projectId, second.id);
  assert.equal(store.projectRegistry.clearSelection("cli").projectId, null);
  store.db.close();
});
