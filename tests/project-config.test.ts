import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectConfig } from "../packages/config/src/index.ts";
import { startWorkbenchServer } from "../apps/api/src/server.ts";

test("project config loader supports local workbench config filenames", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-project-config-"));
  try {
    const cases = [
      { name: ".ai-workbench.json", include: ["src/**"], answer: "ask-deep-local" },
      { name: ".ai-workbench", include: ["apps/**"], answer: "ask-fast-local" },
      { name: ".aiconfig", include: ["packages/**"], answer: "ask-extended-local" },
    ];

    for (const [index, item] of cases.entries()) {
      const project = join(workspace, `project-${index + 1}`);
      await mkdir(project, { recursive: true });
      await writeFile(
        join(project, item.name),
        JSON.stringify(
          {
            include: item.include,
            models: {
              answer: item.answer,
              embedding: "embedding-local",
            },
          },
          null,
          2,
        ),
      );

      const config = resolveProjectConfig(project);
      assert.equal(config.sourcePath, join(project, item.name));
      assert.deepEqual(config.include, item.include);
      assert.equal(config.models.answer, item.answer);
      assert.equal(config.models.embedding, "embedding-local");
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("project graph and context explain expose code-aware selection details", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-project-graph-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(
    join(repo, ".ai-workbench.json"),
    JSON.stringify(
      {
        include: ["src/**"],
        retrieval: {
          boostPaths: ["src/**"],
          authHints: ["auth", "session"],
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(repo, "src", "auth.ts"),
    [
      "export function handleLogin() {",
      "  return { ok: true };",
      "}",
    ].join("\n"),
  );
  await writeFile(
    join(repo, "src", "router.ts"),
    [
      "import { handleLogin } from './auth';",
      "",
      "export function createRouter() {",
      "  return { login: () => handleLogin() };",
      "}",
    ].join("\n"),
  );

  const handle = await startWorkbenchServer({
    inProcess: true,
    config: {
      databasePath: join(workspace, "ai.db"),
      runtimeDir: join(workspace, "runtime"),
      apiUrl: "http://127.0.0.1:0",
      webPort: 0,
      apiPort: 0,
    },
  });

  try {
    const projectRes = await handle.inject({
      method: "POST",
      url: "/projects",
      body: { path: repo, name: "repo" },
    });
    assert.equal(projectRes.statusCode, 200);
    const project = JSON.parse(projectRes.body) as { data: { id: string } };

    const indexRes = await handle.inject({
      method: "POST",
      url: `/projects/${project.data.id}/index`,
      body: {},
    });
    assert.equal(indexRes.statusCode, 200);

    const graphRes = await handle.inject({
      method: "GET",
      url: `/projects/${project.data.id}/graph`,
    });
    assert.equal(graphRes.statusCode, 200);
    const graph = JSON.parse(graphRes.body) as {
      data: {
        project: { id: string };
        config: { sourcePath: string | null };
        graph: { routeFiles?: string[]; hotPaths?: string[] } | null;
        symbols: Array<{ name: string; kind: string }>;
        edges: Array<{ kind: string }>;
      };
    };
    assert.equal(graph.data.project.id, project.data.id);
    assert.ok(graph.data.config.sourcePath);
    assert.ok(graph.data.symbols.some((symbol) => symbol.name === "handleLogin"));
    assert.ok(graph.data.edges.length > 0);

    const explainRes = await handle.inject({
      method: "POST",
      url: "/context/explain",
      body: {
        project: project.data.id,
        query: "where is auth handled?",
        mode: "local",
        depth: "standard",
        limit: 6,
      },
    });
    assert.equal(explainRes.statusCode, 200);
    const explain = JSON.parse(explainRes.body) as {
      data: {
        project: { id: string };
        explanation: { selected: Array<{ path: string }> };
        selectionReasons: Array<{ path: string; finalScore: number }>;
      };
    };
    assert.equal(explain.data.project.id, project.data.id);
    assert.ok(explain.data.explanation.selected.length > 0);
    assert.ok(explain.data.selectionReasons.some((entry) => entry.path.includes("auth.ts")));
  } finally {
    await handle.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
