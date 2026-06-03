import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeStore, createStore } from "../packages/db/src/store.ts";

test("creates a durable review record", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-review-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "auth.ts"), "export const auth = true;\n");

  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "repo" });

  const review = store.createReview({
    project: project.id,
    title: "auth cleanup review",
    plannedFiles: ["src/auth.ts"],
    editedFiles: ["src/auth.ts", "src/session.ts"],
    checks: ["typecheck"],
    notes: "keep the change small",
  });

  assert.equal(review.projectId, project.id);
  assert.ok(review.scopeCreep.includes("src/session.ts"));
  assert.ok(store.listReviews(project.id, 10).length > 0);
  assert.ok(store.listProjectLessons(project.id, 10).some((lesson) => lesson.title === "auth cleanup review"));

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});
