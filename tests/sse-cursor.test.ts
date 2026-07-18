import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkbenchServer } from "../apps/api/src/server.ts";
import { createStore, initializeStore } from "../packages/db/src/store.ts";
import { createEvent, type EventEnvelope } from "../packages/shared/src/index.ts";

async function startTestServer() {
  const workspace = await mkdtemp(join(tmpdir(), "ai-sse-"));
  const repo = join(workspace, "sample");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src/auth.ts"), "export const auth = true;\n");
  await writeFile(join(repo, "README.md"), "# Sample\n");

  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const handle = await startWorkbenchServer({
    store,
    config: {
      databasePath: join(workspace, "ai.db"),
      runtimeDir: join(workspace, "runtime"),
      apiUrl: "http://127.0.0.1:4242",
      webPort: 4242,
      apiPort: 4242,
    },
  });
  return { workspace, handle, store };
}

async function sseEvents(urlStr: string, collectMs = 500, onConnected?: () => void): Promise<EventEnvelope[]> {
  return new Promise((resolve, reject) => {
    const events: EventEnvelope[] = [];
    const url = new URL(urlStr);

    const req = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method: "GET",
        headers: {
          accept: "text/event-stream",
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        onConnected?.();
        const decoder = new TextDecoder();
        res.on("data", (chunk: Buffer) => {
          const text = decoder.decode(chunk, { stream: true });
          const lines = text.split("\n");
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                events.push(JSON.parse(line.slice(6)));
              } catch {
                // skip non-JSON
              }
            }
          }
        });
        res.on("error", reject);
      }
    );

    req.on("error", reject);
    req.end();

    // Collect events for a fixed time, then destroy the connection
    setTimeout(() => {
      req.destroy();
      resolve(events);
    }, collectMs);
  });
}

test("sse: no cursor returns recent events", async () => {
  const { workspace, handle, store } = await startTestServer();
  try {
    const events = await sseEvents(`${handle.url}/events/stream`);
    assert.ok(Array.isArray(events), "should return array");
  } finally {
    await handle.close();
    store.db.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("sse: future cursor returns no events", async () => {
  const { workspace, handle, store } = await startTestServer();
  try {
    const futureCursor = "2099-01-01T00:00:00.000Z";
    const events = await sseEvents(`${handle.url}/events/stream?since=${encodeURIComponent(futureCursor)}`);
    assert.ok(Array.isArray(events), "should return array");
    assert.equal(events.length, 0, "future cursor should return no events");
  } finally {
    await handle.close();
    store.db.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("sse: non-existent event ID cursor returns no events", async () => {
  const { workspace, handle, store } = await startTestServer();
  try {
    const events = await sseEvents(`${handle.url}/events/stream?since=evt_nonexistent`);
    assert.ok(Array.isArray(events), "should return array");
    assert.equal(events.length, 0, "non-existent cursor should return no events");
  } finally {
    await handle.close();
    store.db.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("sse: every persisted store event is published live with normalized fields", async () => {
  const { workspace, handle, store } = await startTestServer();
  try {
    const event = createEvent(
      "run.failed",
      { reason: "typecheck" },
      {
        projectId: "proj_1",
        sessionId: "sess_1",
        runId: "run_1",
        summary: "Typecheck failed",
        correlationId: "run_1",
      }
    );
    const events = await sseEvents(`${handle.url}/events/stream?since=2099-01-01T00:00:00.000Z`, 500, () => {
      store.appendEvent(event);
    });
    const received = events.find((candidate) => candidate.id === event.id);
    assert.ok(received, "persisted event should be emitted without a route-specific publish call");
    assert.equal(received.schemaVersion, 1);
    assert.equal(received.runId, "run_1");
    assert.equal(received.summary, "Typecheck failed");
    assert.equal(received.correlationId, "run_1");
  } finally {
    await handle.close();
    store.db.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("sse: event-id cursors recover later events sharing the same timestamp", async () => {
  const { workspace, handle, store } = await startTestServer();
  try {
    const timestamp = "2026-01-01T00:00:00.000Z";
    const first = createEvent("task.started", { title: "first" }, { id: "evt_same_1", ts: timestamp });
    const second = createEvent("task.completed", { title: "second" }, { id: "evt_same_2", ts: timestamp });
    store.appendEvent(first);
    store.appendEvent(second);
    const events = await sseEvents(`${handle.url}/events/stream?since=${first.id}`);
    assert.equal(
      events.some((event) => event.id === first.id),
      false
    );
    assert.equal(
      events.some((event) => event.id === second.id),
      true
    );
  } finally {
    await handle.close();
    store.db.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
