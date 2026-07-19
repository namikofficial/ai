import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolveActiveContext } from "../packages/active-context/src/index.ts";
import type { DesktopObservation, ProjectManifest } from "../packages/contracts/src/index.ts";
import { createStore, initializeStore } from "../packages/db/src/store.ts";

const fixtures = JSON.parse(
  await readFile(new URL("./fixtures/contracts/v1-control-plane.json", import.meta.url), "utf8")
) as {
  ProjectManifest: ProjectManifest;
  DesktopObservation: DesktopObservation;
};
const manifest = fixtures.ProjectManifest;

function observation(patch: Partial<DesktopObservation> = {}): DesktopObservation {
  return {
    ...fixtures.DesktopObservation,
    explicitProjectId: null,
    browser: null,
    editor: null,
    terminal: null,
    process: null,
    tmux: null,
    ...patch,
  };
}

test("active context precedence prefers explicit override and persistent pin", () => {
  const explicit = resolveActiveContext({
    observation: observation({ explicitProjectId: manifest.id }),
    manifests: [manifest],
    selection: null,
    previous: null,
  });
  assert.equal(explicit.source, "explicit_override");
  const pinned = resolveActiveContext({
    observation: observation(),
    manifests: [manifest],
    selection: {
      projectId: manifest.id,
      source: "cli",
      pinScope: "persistent",
      workspaceId: null,
      sessionId: null,
      selectedAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
    },
    previous: null,
  });
  assert.equal(pinned.source, "manual_pin");
  assert.equal(pinned.pinned, true);
});

test("unverified tmux is rejected and cannot override focused process context", () => {
  const context = resolveActiveContext({
    observation: observation({
      window: { ...fixtures.DesktopObservation.window, className: "kitty", role: "terminal" },
      process: { pid: 10, parentPid: null, cwd: manifest.path, command: "zsh" },
      tmux: { clientPid: 99, session: "unrelated", paneId: "%1", cwd: "/tmp/other", associationVerified: false },
    }),
    manifests: [manifest],
    selection: null,
    previous: null,
  });
  assert.equal(context.source, "process_cwd");
  assert.equal(context.evidence[0]?.reason, "process-cwd matched a registered project");
  assert.ok(context.rejectedCandidates.some((entry) => entry.reason.includes("not proven")));
});

test("editor process cwd cannot impersonate an active file or workspace", () => {
  const context = resolveActiveContext({
    observation: observation({
      process: { pid: 10, parentPid: null, cwd: manifest.path, command: "code" },
    }),
    manifests: [manifest],
    selection: null,
    previous: null,
  });
  assert.equal(context.source, "unresolved");
  assert.equal(context.project, null);
  assert.ok(context.rejectedCandidates.some((entry) => entry.reason.includes("not proof")));
});

test("editor beats terminal and exposes rejected lower-precedence evidence", () => {
  const other: ProjectManifest = {
    ...manifest,
    id: "other",
    name: "Other",
    path: "/workspace/other",
    repositoryRoot: "/workspace/other",
    approvedRoots: ["/workspace/other"],
  };
  const context = resolveActiveContext({
    observation: observation({
      editor: { file: `${manifest.path}/src/main.ts`, workspace: manifest.path },
      terminal: { cwd: other.path, shell: "zsh" },
    }),
    manifests: [manifest, other],
    selection: null,
    previous: null,
  });
  assert.equal(context.project?.id, manifest.id);
  assert.equal(context.source, "focused_editor");
  assert.ok(context.rejectedCandidates.some((entry) => entry.value === other.path));
});

test("transient windows preserve previous context without project flapping", () => {
  const previous = resolveActiveContext({
    observation: observation({ editor: { file: `${manifest.path}/README.md`, workspace: manifest.path } }),
    manifests: [manifest],
    selection: null,
    previous: null,
  });
  const context = resolveActiveContext({
    observation: observation({ id: "obs_transient", transientWindow: true }),
    manifests: [manifest],
    selection: null,
    previous,
    now: previous.updatedAt,
  });
  assert.equal(context.project?.id, manifest.id);
  assert.equal(context.fallbackUsed, "transient-window");
});

test("workspace pin is rejected after the workspace changes", () => {
  const context = resolveActiveContext({
    observation: observation({ workspaceId: "2" }),
    manifests: [manifest],
    selection: {
      projectId: manifest.id,
      source: "cli",
      pinScope: "workspace",
      workspaceId: "1",
      sessionId: null,
      selectedAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
    },
    previous: null,
  });
  assert.equal(context.source, "unresolved");
  assert.ok(context.rejectedCandidates.some((entry) => entry.reason === "workspace pin expired"));
});

test("observation and resolved context persist as validated contracts", () => {
  const store = createStore(initializeStore(":memory:"));
  const seen = store.activeContext.recordObservation(observation());
  const context = resolveActiveContext({ observation: seen, manifests: [manifest], selection: null, previous: null });
  store.activeContext.saveContext(context, seen.id);
  assert.equal(store.activeContext.getLatestObservation()?.id, seen.id);
  assert.deepEqual(store.activeContext.getContext(), context);
  store.db.close();
});
