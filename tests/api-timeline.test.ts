import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkbenchServer } from "../apps/api/src/server.ts";
import { createStore, initializeStore } from "../packages/db/src/store.ts";

test("api: session timeline endpoint", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-api-timeline-"));
  const store = createStore(initializeStore(join(workspace, "ai.db")));

  const session = store.createSession({
    projectId: null,
    title: "Test Session",
    userGoal: "Test timeline",
    mode: "local",
    source: "test",
  });

  const handle = await startWorkbenchServer({
    config: {
      apiUrl: "http://127.0.0.1:0",
      apiPort: 0,
      webPort: 0,
      databasePath: join(workspace, "ai.db"),
      runtimeDir: workspace,
      cloudEnabled: false,
      qdrantEnabled: false,
      qdrantUrl: null,
      qdrantCollection: "ai",
    },
    store,
    inProcess: true,
  });

  try {
    const res = await handle.inject({
      method: "GET",
      url: `/sessions/${session.id}/timeline`,
    });
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.data.session.id, session.id);
    assert.ok(Array.isArray(body.data.timeline));
    assert.ok(body.data.counts);

    const missing = await handle.inject({
      method: "GET",
      url: "/sessions/unknown-session/timeline",
    });
    assert.equal(missing.statusCode, 404);
  } finally {
    await handle.close();
    store.db.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
