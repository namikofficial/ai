import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractCodeIntelligence, linkSymbolsToChunks } from "../packages/code-intelligence/src/index.ts";
import { initializeStore, createStore } from "../packages/db/src/store.ts";
import { indexProject } from "../packages/indexer/src/index.ts";
import { searchProjectChunks } from "../packages/retrieval-engine/src/search.ts";

test("code-intelligence: extracts TypeScript symbols and links them to chunks", () => {
  const result = extractCodeIntelligence({
    projectId: "p1",
    fileId: "f1",
    path: "src/auth.ts",
    language: "typescript",
    content: [
      "import { router } from './router';",
      "",
      "export class AuthService {",
      "  login(user: string) {",
      "    return user;",
      "  }",
      "}",
      "",
      "export function handleLogin() {",
      "  return router.get('/login');",
      "}",
    ].join("\n"),
  });

  assert.ok(result.symbols.some((symbol) => symbol.kind === "class" && symbol.name === "AuthService"));
  assert.ok(result.symbols.some((symbol) => symbol.kind === "function" && symbol.name === "handleLogin"));
  assert.ok(result.symbols.some((symbol) => symbol.kind === "import"));

  const chunks = [
    { id: "c1", startLine: 1, endLine: 4, tokenCount: 20 },
    { id: "c2", startLine: 5, endLine: 11, tokenCount: 20 },
  ];
  const links = linkSymbolsToChunks(result.symbols, chunks);
  assert.ok(links.links.length > 0);
  assert.ok(links.metadataByChunkId.has("c1") || links.metadataByChunkId.has("c2"));
  assert.ok(Array.from(links.metadataByChunkId.values()).flat().every((entry) => entry.confidence > 0));
});

test("code-intelligence: extracts Python symbols with fallback parsing", () => {
  const result = extractCodeIntelligence({
    projectId: "p1",
    fileId: "f2",
    path: "src/auth.py",
    language: "python",
    content: [
      "from .router import router",
      "",
      "class AuthService:",
      "    def login(self, user):",
      "        return user",
      "",
      "def handle_login(user):",
      "    return router",
    ].join("\n"),
  });

  assert.ok(result.symbols.some((symbol) => symbol.kind === "class" && symbol.name === "AuthService"));
  assert.ok(result.symbols.some((symbol) => symbol.kind === "function" && symbol.name === "handle_login"));
  assert.ok(result.symbols.some((symbol) => symbol.kind === "import"));
});

test("code-intelligence: indexing reuses changed-file ids and refreshes symbol rows", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-code-intel-"));
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
  await writeFile(
    join(repo, "src", "auth.ts"),
    [
      "export function handleLogin() {",
      "  return { ok: true };",
      "}",
    ].join("\n"),
  );

  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "repo" });
  await store.indexProject(project.id);

  const firstSymbols = store.db.prepare(
    "SELECT name, kind, path FROM code_symbols WHERE project_id = ? AND path = ? ORDER BY start_line ASC",
  ).all(project.id, "src/auth.ts") as Array<{ name: string; kind: string; path: string }>;
  assert.equal(firstSymbols.filter((row) => row.kind === "function").length, 1);
  assert.equal(firstSymbols.find((row) => row.kind === "function")?.name, "handleLogin");

  await writeFile(
    join(repo, "src", "auth.ts"),
    [
      "export function handleLoginV2() {",
      "  return { ok: true, version: 2 };",
      "}",
    ].join("\n"),
  );
  await store.indexProject(project.id);

  const secondSymbols = store.db.prepare(
    "SELECT name, kind, path FROM code_symbols WHERE project_id = ? AND path = ? ORDER BY start_line ASC",
  ).all(project.id, "src/auth.ts") as Array<{ name: string; kind: string; path: string }>;
  assert.equal(secondSymbols.filter((row) => row.kind === "function").length, 1);
  assert.equal(secondSymbols.find((row) => row.kind === "function")?.name, "handleLoginV2");

  const graphRow = store.db.prepare("SELECT summary_json FROM project_context_graphs WHERE project_id = ?").get(project.id) as { summary_json: string } | undefined;
  assert.ok(graphRow);
  const graph = JSON.parse(graphRow!.summary_json) as { routeFiles: string[]; hotPaths: string[] };
  assert.ok(Array.isArray(graph.hotPaths));

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("code-intelligence: indexer continues when symbol extraction fails", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-code-intel-fail-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(
    join(repo, "src", "auth.ts"),
    [
      "export function handleLogin() {",
      "  return { ok: true };",
      "}",
    ].join("\n"),
  );

  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "repo" });
  const result = await indexProject({
    db: store.db,
    projectId: project.id,
    projectPath: repo,
    projectConfig: {
      ignore: [],
      include: ["src/**"],
      chunking: { preferTreeSitter: true, maxChunkTokens: 900 },
      codeIntelligence: { enabled: true },
      retrieval: { boostPaths: [], authHints: [] },
      models: { answer: null, embedding: null },
    },
    qdrant: null,
    embedBatch: async () => ({ embeddings: [[0, 0, 0]], dimensions: 3, modelName: "mock", providerId: "mock" }),
    embeddingModel: "mock",
    embeddingProvider: "mock",
    embeddingDimension: 3,
    codeIntelligenceExtractor: () => {
      throw new Error("boom");
    },
    onWarning: () => undefined,
  });

  assert.equal(result.filesIndexed, 1);
  assert.equal(result.chunksIndexed, 1);
  const symbolCount = store.db.prepare("SELECT COUNT(*) AS count FROM code_symbols WHERE project_id = ?").get(project.id) as { count: number };
  assert.equal(symbolCount.count, 0);

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("code-intelligence: retrieval uses symbol and graph signals", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-code-search-"));
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
      "export const router = {",
      "  login() {",
      "    return handleLogin();",
      "  }",
      "};",
    ].join("\n"),
  );

  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "repo" });
  await store.indexProject(project.id);

  const chunks = searchProjectChunks({
    db: store.db,
    projectId: project.id,
    query: "what calls handleLogin?",
    limit: 8,
    qdrantSettings: null,
  });

  assert.ok(chunks.length > 0);
  assert.ok(chunks.some((chunk) => Array.isArray(chunk.metadata.codeSymbols) && chunk.metadata.codeSymbols.length > 0));
  assert.ok(chunks.some((chunk) => chunk.path === "src/router.ts" && chunk.metadata.graphExpansion));

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});

test("code-intelligence: deleted file symbols removed on reindex", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-code-intel-del-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(
    join(repo, ".ai-workbench.json"),
    JSON.stringify({
      include: ["src/**"],
      codeIntelligence: { enabled: true },
    }),
  );
  await writeFile(
    join(repo, "src", "auth.ts"),
    ["export function handleLogin() {", "  return { ok: true };", "}"].join("\n"),
  );
  await writeFile(
    join(repo, "src", "router.ts"),
    ["export function route() {", "  return { ok: true };", "}"].join("\n"),
  );

  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "repo" });
  await store.indexProject(project.id);

  const symbolsBefore = store.db
    .prepare("SELECT path FROM code_symbols WHERE project_id = ?")
    .all(project.id) as Array<{ path: string }>;
  assert.ok(symbolsBefore.some((row) => row.path === "src/auth.ts"));
  assert.ok(symbolsBefore.some((row) => row.path === "src/router.ts"));

  await rm(join(repo, "src", "auth.ts"), { force: true });
  await store.indexProject(project.id);

  const symbolsAfter = store.db
    .prepare("SELECT path FROM code_symbols WHERE project_id = ?")
    .all(project.id) as Array<{ path: string }>;
  assert.ok(!symbolsAfter.some((row) => row.path === "src/auth.ts"), "deleted file symbols should be removed");
  assert.ok(symbolsAfter.some((row) => row.path === "src/router.ts"), "surviving file symbols remain");

  const chunks = searchProjectChunks({
    db: store.db,
    projectId: project.id,
    query: "handleLogin",
    limit: 8,
    qdrantSettings: null,
  });
  assert.ok(!chunks.some((chunk) => chunk.path === "src/auth.ts"), "deleted file should not appear in retrieval results");

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});
