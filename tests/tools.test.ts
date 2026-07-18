import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDefaultToolRegistry } from "../packages/tools/src/index.ts";

async function makeRepo(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "ai-tools-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(
    join(dir, "src", "auth.ts"),
    "export function login() { return 'ok'; }\nexport const SESSION = 'local';\n"
  );
  await writeFile(
    join(dir, "src", "user.ts"),
    "import { login } from './auth';\nexport function getUser() { return login(); }\n"
  );
  await writeFile(join(dir, "README.md"), "# sample\n");
  await writeFile(join(dir, ".env"), "API_KEY=secret\n");
  return {
    root: dir,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("tools: registry lists every default tool with a name, risk, and category", () => {
  const registry = createDefaultToolRegistry();
  const tools = registry.list();
  const names = new Set(tools.map((tool) => tool.name));
  assert.ok(names.has("file_read"));
  assert.ok(names.has("file_write"));
  assert.ok(names.has("file_edit"));
  assert.ok(names.has("project_list"));
  assert.ok(names.has("project_grep"));
  assert.ok(names.has("symbol_lookup"));
  assert.ok(names.has("file_summary"));
  for (const tool of tools) {
    assert.ok(tool.description.length > 20, `${tool.name} should have a description`);
    assert.ok(tool.inputSchema.type === "object", `${tool.name} should have an object schema`);
  }
});

test("tools: file_read returns the file content with metadata", async () => {
  const repo = await makeRepo();
  try {
    const registry = createDefaultToolRegistry();
    const result = await registry.call(
      "file_read",
      { path: "src/auth.ts" },
      {
        projectPath: repo.root,
        projectId: "p",
        sessionId: "s",
        allowHighRisk: false,
      }
    );
    assert.equal(result.ok, true);
    const output = result.output as { content: string; lines: number; bytes: number };
    assert.ok(output.content.includes("login"));
    assert.ok(output.lines >= 2);
    assert.ok(output.bytes > 0);
    assert.equal(result.touchedPath, "src/auth.ts");
  } finally {
    await repo.cleanup();
  }
});

test("tools: file_read refuses to escape the project root", async () => {
  const repo = await makeRepo();
  try {
    const registry = createDefaultToolRegistry();
    const result = await registry.call(
      "file_read",
      { path: "../../../etc/passwd" },
      {
        projectPath: repo.root,
        projectId: "p",
        sessionId: "s",
        allowHighRisk: true,
      }
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /escape|root|relative/);
  } finally {
    await repo.cleanup();
  }
});

test("tools: file_read refuses secret files and reports redaction", async () => {
  const repo = await makeRepo();
  try {
    const registry = createDefaultToolRegistry();
    const result = await registry.call(
      "file_read",
      { path: ".env" },
      {
        projectPath: repo.root,
        projectId: "p",
        sessionId: "s",
        allowHighRisk: false,
      }
    );
    assert.equal(result.ok, false);
    assert.equal(result.redacted, true);
    assert.match(result.error ?? "", /secret/);
  } finally {
    await repo.cleanup();
  }
});

test("tools: file tools refuse symlinks without exposing or overwriting outside content", async () => {
  const repo = await makeRepo();
  const outside = await mkdtemp(join(tmpdir(), "ai-tools-outside-"));
  try {
    const externalFile = join(outside, "external.txt");
    await writeFile(externalFile, "outside secret\n");
    await symlink(externalFile, join(repo.root, "src", "linked.txt"));
    const registry = createDefaultToolRegistry();
    const context = {
      projectPath: repo.root,
      projectId: "p",
      sessionId: "s",
      allowHighRisk: false,
    };

    const read = await registry.call("file_read", { path: "src/linked.txt" }, context);
    assert.equal(read.ok, false);
    assert.equal(read.output, null);
    assert.match(read.error ?? "", /symbolic link/);
    assert.doesNotMatch(read.error ?? "", /outside secret/);

    const write = await registry.call(
      "file_write",
      { path: "src/linked.txt", contents: "overwritten\n", overwrite: true },
      context
    );
    assert.equal(write.ok, false);
    assert.match(write.error ?? "", /symbolic link/);
    assert.equal(await readFile(externalFile, "utf8"), "outside secret\n");
  } finally {
    await rm(outside, { recursive: true, force: true });
    await repo.cleanup();
  }
});

test("tools: file_write creates a new file and reports isHighRisk for manifests", async () => {
  const repo = await makeRepo();
  try {
    const registry = createDefaultToolRegistry();
    const result = await registry.call(
      "file_write",
      { path: "src/new.ts", contents: "export const x = 1;\n" },
      { projectPath: repo.root, projectId: "p", sessionId: "s", allowHighRisk: false }
    );
    assert.equal(result.ok, true);
    const output = result.output as { bytes: number; created: boolean };
    assert.equal(output.created, true);
    assert.equal(output.bytes, "export const x = 1;\n".length);

    // Writing to package.json must be flagged as high-risk.
    const result2 = await registry.call(
      "file_write",
      { path: "package.json", contents: "{}" },
      { projectPath: repo.root, projectId: "p", sessionId: "s", allowHighRisk: false }
    );
    assert.equal(result2.ok, true);
    const output2 = result2.output as { isHighRisk: boolean };
    assert.equal(output2.isHighRisk, true);
  } finally {
    await repo.cleanup();
  }
});

test("tools: file_edit applies a find/replace and reports the before/after", async () => {
  const repo = await makeRepo();
  try {
    const registry = createDefaultToolRegistry();
    const result = await registry.call(
      "file_edit",
      { path: "src/auth.ts", oldText: "return 'ok';", newText: "return 'updated';" },
      { projectPath: repo.root, projectId: "p", sessionId: "s", allowHighRisk: false }
    );
    assert.equal(result.ok, true);
    const output = result.output as { before: string; after: string };
    assert.ok(output.before.includes("return 'ok';"));
    assert.ok(output.after.includes("return 'updated';"));
  } finally {
    await repo.cleanup();
  }
});

test("tools: file_edit fails when oldText is not found", async () => {
  const repo = await makeRepo();
  try {
    const registry = createDefaultToolRegistry();
    const result = await registry.call(
      "file_edit",
      { path: "src/auth.ts", oldText: "not in file", newText: "replacement" },
      { projectPath: repo.root, projectId: "p", sessionId: "s", allowHighRisk: false }
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /oldText|not found/);
  } finally {
    await repo.cleanup();
  }
});

test("tools: project_list returns project files and skips ignored directories", async () => {
  const repo = await makeRepo();
  try {
    await mkdir(join(repo.root, "node_modules", "x"), { recursive: true });
    await writeFile(join(repo.root, "node_modules", "x", "x.js"), "noise");
    const registry = createDefaultToolRegistry();
    const result = await registry.call(
      "project_list",
      { maxDepth: 3 },
      {
        projectPath: repo.root,
        projectId: "p",
        sessionId: "s",
        allowHighRisk: false,
      }
    );
    assert.equal(result.ok, true);
    const output = result.output as { files: string[]; count: number };
    assert.ok(output.files.includes("src/auth.ts"));
    assert.ok(!output.files.some((path) => path.includes("node_modules")));
  } finally {
    await repo.cleanup();
  }
});

test("tools: project_grep returns matches with file:line:context", async () => {
  const repo = await makeRepo();
  try {
    const registry = createDefaultToolRegistry();
    const result = await registry.call(
      "project_grep",
      { pattern: "login" },
      {
        projectPath: repo.root,
        projectId: "p",
        sessionId: "s",
        allowHighRisk: false,
      }
    );
    assert.equal(result.ok, true);
    const output = result.output as { count: number; matches: Array<{ path: string; line: number }> };
    assert.ok(output.count >= 2);
    assert.ok(output.matches.some((match) => match.path === "src/auth.ts"));
    assert.ok(output.matches.some((match) => match.path === "src/user.ts"));
  } finally {
    await repo.cleanup();
  }
});

test("tools: project_grep returns an error on invalid regex", async () => {
  const repo = await makeRepo();
  try {
    const registry = createDefaultToolRegistry();
    const result = await registry.call(
      "project_grep",
      { pattern: "[invalid(" },
      {
        projectPath: repo.root,
        projectId: "p",
        sessionId: "s",
        allowHighRisk: false,
      }
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /invalid regex/);
  } finally {
    await repo.cleanup();
  }
});

test("tools: registry rejects unknown tool names", async () => {
  const repo = await makeRepo();
  try {
    const registry = createDefaultToolRegistry();
    const result = await registry.call(
      "does_not_exist",
      {},
      {
        projectPath: repo.root,
        projectId: "p",
        sessionId: "s",
        allowHighRisk: true,
      }
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /unknown tool/);
  } finally {
    await repo.cleanup();
  }
});

test("tools: registry validates required args", async () => {
  const repo = await makeRepo();
  try {
    const registry = createDefaultToolRegistry();
    const result = await registry.call(
      "file_read",
      {},
      {
        projectPath: repo.root,
        projectId: "p",
        sessionId: "s",
        allowHighRisk: true,
      }
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /path|required/);
  } finally {
    await repo.cleanup();
  }
});

test("tools: file_summary reports language and symbol count when code-intel is present", async () => {
  const repo = await makeRepo();
  try {
    const registry = createDefaultToolRegistry();
    const result = await registry.call(
      "file_summary",
      { path: "src/auth.ts" },
      {
        projectPath: repo.root,
        projectId: "p",
        sessionId: "s",
        allowHighRisk: false,
      }
    );
    assert.equal(result.ok, true);
    const output = result.output as { language: string; lines: number; symbolCount: number };
    assert.equal(output.language, "typescript");
    assert.ok(output.lines >= 2);
    // No code-intel DB in this test, so symbolCount is 0 but the call still succeeds.
    assert.equal(output.symbolCount, 0);
  } finally {
    await repo.cleanup();
  }
});
