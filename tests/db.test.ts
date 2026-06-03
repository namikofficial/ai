import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeStore, createStore } from "../packages/db/src/store.ts";

test("applies the migration and stores projects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ai-db-"));
  const dbPath = join(dir, "ai.db");
  await writeFile(
    join(dir, "README.md"),
    [
      "# Temp Project",
      "",
      "Auth is documented here.",
    ].join("\n"),
  );
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(
    join(dir, "src", "auth.ts"),
    [
      "export function authenticateUser() {",
      "  return true;",
      "}",
    ].join("\n"),
  );
  const store = createStore(initializeStore(dbPath));

  const project = store.createProject({ path: dir, name: "temp-project" });
  assert.equal(project.name, "temp-project");
  assert.equal(store.listProjects().length, 1);

  await store.indexProject(project.id);
  const chunks = store.searchChunks(project.id, "readme", { limit: 4 });
  assert.ok(chunks.length > 0);
  assert.equal(chunks[0].path, "README.md");

  const session = store.createSession({
    projectId: project.id,
    title: "Test session",
    userGoal: "verify persistence",
    mode: "local",
    source: "test",
  });

  store.appendEvent({
    id: "evt_test",
    type: "session.started",
    sessionId: session.id,
    taskId: null,
    projectId: project.id,
    agent: "test",
    level: "info",
    ts: new Date().toISOString(),
    payload: { ok: true },
  });

  const events = store.listEvents(session.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "session.started");

  store.db.close();
  await rm(dir, { recursive: true, force: true });
});
