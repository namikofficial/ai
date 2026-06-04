import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcessLike } from "node:child_process";
import { initializeStore, createStore } from "../packages/db/src/store.ts";
import { resolveConfig } from "../packages/config/src/index.ts";

const cliCommand = "node";
const cliArgs = ["--experimental-strip-types", "cli/ai/src/main.ts"];

interface CliRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function decodeChunk(chunk: string | Uint8Array): string {
  if (typeof chunk === "string") return chunk;
  let binary = "";
  for (let i = 0; i < chunk.length; i++) {
    binary += String.fromCharCode(chunk[i] ?? 0);
  }
  return binary;
}

function attachDataListener(
  stream: ChildProcessLike["stdout"],
  handler: (chunk: string | Uint8Array) => void,
): void {
  if (!stream) return;
  const on = (stream as { on: (event: "data", listener: (chunk: string | Uint8Array) => void) => void }).on.bind(stream);
  on("data", handler);
}

function runCli(env: Record<string, string | undefined>, args: string[]): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cliCommand, [...cliArgs, ...args], {
      env: { ...process.env, ...env } as Record<string, string | undefined>,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      attachDataListener(child.stdout, (chunk) => {
        stdoutChunks.push(decodeChunk(chunk));
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      attachDataListener(child.stderr, (chunk) => {
        stderrChunks.push(decodeChunk(chunk));
      });
    }
    child.once("exit", () => {
      resolve({
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        exitCode: child.exitCode ?? 0,
      });
    });
  });
}

test("ai retrieval explain runs the full pipeline and prints ranked/selected/dropped", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-cli-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "auth.ts"), "export function login(user: string) { return user; }\n");
  await writeFile(join(repo, "src", "session.ts"), "export function getSession() { return null; }\n");

  const dbPath = join(workspace, "ai.db");
  const runtimeDir = join(workspace, "runtime");

  // Seed project + index using the direct store API (avoids HTTP server).
  const config = resolveConfig({ databasePath: dbPath, runtimeDir });
  const store = createStore(initializeStore(config.databasePath));
  const project = store.createProject({ path: repo, name: "repo" });
  await store.indexProject(project.id);
  store.db.close();

  const explain = await runCli(
    {
      AI_DATABASE_PATH: dbPath,
      AI_RUNTIME_DIR: runtimeDir,
    },
    ["retrieval", "explain", "how does login work", "--project", project.id, "--depth", "standard"],
  );
  assert.equal(explain.exitCode, 0, `retrieval explain failed: ${explain.stderr}`);
  const output = JSON.parse(explain.stdout) as {
    query: string;
    intent: { terms: string[] };
    ranked: Array<{ path: string; finalScore: number }>;
    selected: Array<{ path: string }>;
    dropped: Array<{ path: string }>;
    confidence: number;
  };
  assert.equal(output.query, "how does login work");
  assert.ok(Array.isArray(output.ranked));
  assert.ok(Array.isArray(output.selected));
  assert.ok(Array.isArray(output.dropped));
  assert.ok(output.confidence >= 0 && output.confidence <= 1);
  assert.ok(output.ranked.length >= 1, "expected at least one ranked chunk");
});

test("ai project symbols and symbol inspect code intelligence rows", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-cli-symbols-"));
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

  const dbPath = join(workspace, "ai.db");
  const runtimeDir = join(workspace, "runtime");
  const store = createStore(initializeStore(dbPath));
  const project = store.createProject({ path: repo, name: "repo" });
  await store.indexProject(project.id);
  const symbols = store.codeIntelligence.listSymbols(project.id, "handleLogin", 10);
  assert.ok(symbols.length > 0);
  const symbolId = symbols[0]!.id;
  store.db.close();

  const list = await runCli(
    {
      AI_DATABASE_PATH: dbPath,
      AI_RUNTIME_DIR: runtimeDir,
    },
    ["project", "symbols", project.id, "--query", "handleLogin"],
  );
  assert.equal(list.exitCode, 0, `project symbols failed: ${list.stderr}`);
  const listOutput = JSON.parse(list.stdout) as { project: { id: string }; symbols: Array<{ id: string }> };
  assert.equal(listOutput.project.id, project.id);
  assert.ok(listOutput.symbols.some((symbol) => symbol.id === symbolId));

  const single = await runCli(
    {
      AI_DATABASE_PATH: dbPath,
      AI_RUNTIME_DIR: runtimeDir,
    },
    ["project", "symbol", symbolId],
  );
  assert.equal(single.exitCode, 0, `project symbol failed: ${single.stderr}`);
  const singleOutput = JSON.parse(single.stdout) as {
    symbol: { id: string; name: string };
    chunks: Array<{ symbolId: string }>;
    edges: unknown[];
  };
  assert.equal(singleOutput.symbol.id, symbolId);
  assert.equal(singleOutput.symbol.name, "handleLogin");
  assert.ok(singleOutput.chunks.length > 0);

  await rm(workspace, { recursive: true, force: true });
});

test("ai models list and health run via direct store", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-cli-models-"));
  const dbPath = join(workspace, "ai.db");
  const runtimeDir = join(workspace, "runtime");

  const list = await runCli(
    {
      AI_DATABASE_PATH: dbPath,
      AI_RUNTIME_DIR: runtimeDir,
    },
    ["models", "list"],
  );
  assert.equal(list.exitCode, 0, `models list failed: ${list.stderr}`);
  const listed = JSON.parse(list.stdout) as { providers: unknown[]; profiles: unknown[] };
  assert.ok(Array.isArray(listed.providers));
  assert.ok(Array.isArray(listed.profiles));

  const health = await runCli(
    {
      AI_DATABASE_PATH: dbPath,
      AI_RUNTIME_DIR: runtimeDir,
    },
    ["models", "health"],
  );
  assert.equal(health.exitCode, 0, `models health failed: ${health.stderr}`);
  const healthOutput = JSON.parse(health.stdout) as { health: unknown[]; recentCalls: unknown[] };
  assert.ok(Array.isArray(healthOutput.health));
  assert.ok(Array.isArray(healthOutput.recentCalls));
});

test("ai trace timeline prints normalized session timeline json", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-cli-timeline-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(
    join(repo, "src", "auth.ts"),
    [
      "export function handleLogin() {",
      "  return { route: '/api/auth/login', storage: 'local sqlite' };",
      "}",
      "",
      "export const authNote = 'auth is handled in the auth router';",
    ].join("\n"),
  );

  const dbPath = join(workspace, "ai.db");
  const runtimeDir = join(workspace, "runtime");
  const store = createStore(initializeStore(dbPath));
  const project = store.createProject({ path: repo, name: "repo" });
  await store.indexProject(project.id);
  const ask = await store.ask({
    project: project.id,
    question: "where is auth handled?",
    mode: "local",
    depth: "standard",
  });
  store.db.close();

  const trace = await runCli(
    {
      AI_DATABASE_PATH: dbPath,
      AI_RUNTIME_DIR: runtimeDir,
    },
    ["trace", "timeline", ask.sessionId],
  );
  assert.equal(trace.exitCode, 0, `trace timeline failed: ${trace.stderr}`);
  const output = JSON.parse(trace.stdout) as {
    session: { id: string };
    timeline: Array<{ id: string; kind: string; ts: string }>;
    counts: { messages: number; modelCalls: number; retrievalQueries: number };
  };
  assert.equal(output.session.id, ask.sessionId);
  assert.ok(Array.isArray(output.timeline));
  assert.ok(output.timeline.length > 0);
  assert.ok(output.counts.messages >= 2);
  assert.ok(output.counts.modelCalls >= 1);
});
