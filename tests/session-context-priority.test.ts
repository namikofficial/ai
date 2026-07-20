import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStore, initializeStore } from "../packages/db/src/store.ts";
import { compileSessionContextPreview } from "../packages/session-context/src/index.ts";

test("session context: relevant retrieval is not starved by a large changed file", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-context-priority-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(
    join(repo, "src", "recovery.ts"),
    "export function recoverInterruptedIndexing() { return 'fail without replay'; }\n"
  );
  await writeFile(join(repo, "CHANGED.md"), "# Before\n");
  execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "context-test@example.invalid"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Context Test"], { cwd: repo });
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repo });
  await writeFile(join(repo, "CHANGED.md"), `# Large change\n${"unrelated filler text\n".repeat(1_000)}`);

  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "context-priority" });
  await store.indexProject(project.id);
  const session = store.createSession({
    projectId: project.id,
    title: "Recovery context",
    userGoal: "Understand interrupted indexing recovery",
    mode: "local",
    source: "test",
  });

  const preview = await compileSessionContextPreview(store, {
    sessionId: session.id,
    query: "Where is recoverInterruptedIndexing implemented?",
    tokenBudget: 1_000,
  });
  assert.ok(preview);
  assert.ok(
    preview?.included.some(
      (item) =>
        item.kind === "retrieval" &&
        item.source === "src/recovery.ts" &&
        item.content.includes("recoverInterruptedIndexing")
    )
  );
  assert.ok(preview?.excluded.some((item) => item.id === "changed-file:CHANGED.md"));
  assert.ok((preview?.estimatedTokens ?? 0) <= 1_000);

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});
