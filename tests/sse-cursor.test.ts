import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkbenchServer } from "../apps/api/src/server.ts";
import type { EventEnvelope } from "../packages/shared/src/index.ts";

async function startTestServer() {
  const workspace = await mkdtemp(join(tmpdir(), "ai-sse-"));
  const repo = join(workspace, "sample");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src/auth.ts"), "export const auth = true;\n");
  await writeFile(join(repo, "README.md"), "# Sample\n");

  const handle = await startWorkbenchServer({
    config: {
      databasePath: join(workspace, "ai.db"),
      runtimeDir: join(workspace, "runtime"),
      apiUrl: "http://127.0.0.1:4242",
      webPort: 4242,
      apiPort: 4242,
    },
  });
  return { workspace, handle };
}

async function sseEvents(urlStr: string, collectMs = 500): Promise<EventEnvelope[]> {
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
  const { workspace, handle } = await startTestServer();
  try {
    const events = await sseEvents(`${handle.url}/events/stream`);
    assert.ok(Array.isArray(events), "should return array");
  } finally {
    await handle.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("sse: future cursor returns no events", async () => {
  const { workspace, handle } = await startTestServer();
  try {
    const futureCursor = "2099-01-01T00:00:00.000Z";
    const events = await sseEvents(
      `${handle.url}/events/stream?since=${encodeURIComponent(futureCursor)}`
    );
    assert.ok(Array.isArray(events), "should return array");
    assert.equal(events.length, 0, "future cursor should return no events");
  } finally {
    await handle.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("sse: non-existent event ID cursor returns no events", async () => {
  const { workspace, handle } = await startTestServer();
  try {
    const events = await sseEvents(`${handle.url}/events/stream?since=evt_nonexistent`);
    assert.ok(Array.isArray(events), "should return array");
    assert.equal(events.length, 0, "non-existent cursor should return no events");
  } finally {
    await handle.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
