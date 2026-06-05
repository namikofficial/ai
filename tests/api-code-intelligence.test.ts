import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeStore, createStore } from "../packages/db/src/store.ts";
import { startWorkbenchServer } from "../apps/api/src/server.ts";

test("api: code intelligence endpoints", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-api-code-intel-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(
    join(repo, ".ai-workbench.json"),
    JSON.stringify({
      include: ["src/**"],
      codeIntelligence: {
        enabled: true,
      },
    }),
  );
  await writeFile(join(repo, "src", "auth.ts"), "export function login() {}");

  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "repo" });

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
    inProcess: true,
  });

  try {
    // 1. Initial state: no symbols
    const res1 = await handle.inject({
      method: "GET",
      url: `/projects/${project.id}/symbols`,
    });
    const body1 = JSON.parse(res1.body);
    if (res1.statusCode !== 200 || !body1.data) console.error('res1 error:', res1.body);
    assert.equal(res1.statusCode, 200);
    assert.equal(body1.data.symbols.length, 0);

    // 2. Index project
    await store.indexProject(project.id);

    // 3. List symbols
    const res2 = await handle.inject({
      method: "GET",
      url: `/projects/${project.id}/symbols`,
    });
    const body2 = JSON.parse(res2.body);
    assert.equal(res2.statusCode, 200);
    assert.ok(body2.data.symbols.length > 0);
    const symbolId = body2.data.symbols[0].id;

    // 4. Get symbol detail
    const res3 = await handle.inject({
      method: "GET",
      url: `/symbols/${symbolId}`,
    });
    const body3 = JSON.parse(res3.body);
    assert.equal(res3.statusCode, 200);
    assert.equal(body3.data.symbol.id, symbolId);
    assert.equal(body3.data.projectId, project.id);
    assert.equal(body3.data.filePath, "src/auth.ts");
    assert.equal(body3.data.projectPath, repo);
    assert.equal(body3.data.symbolPath, "src/auth.ts");
    assert.ok(Array.isArray(body3.data.chunks));
    assert.ok(Array.isArray(body3.data.edges));
    assert.ok(Array.isArray(body3.data.relatedSymbols));

    // 5. Unknown symbol
    const res4 = await handle.inject({
      method: "GET",
      url: "/symbols/unknown",
    });
    assert.equal(res4.statusCode, 404);

    // 6. Graph endpoint
    const res5 = await handle.inject({
      method: "GET",
      url: `/projects/${project.id}/graph`,
    });
    const body5 = JSON.parse(res5.body);
    assert.equal(res5.statusCode, 200);
    assert.ok(body5.data.graph);

  } finally {
    await handle.close();
    store.db.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
