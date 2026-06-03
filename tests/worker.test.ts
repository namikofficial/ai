import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeStore, createStore } from "../packages/db/src/store.ts";
import { processNextJob } from "../apps/worker/src/worker.ts";

test("worker processes queued plan jobs", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-worker-"));
  const repo = join(workspace, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "auth.ts"), "export const auth = true;\n");

  const store = createStore(initializeStore(join(workspace, "ai.db")));
  const project = store.createProject({ path: repo, name: "repo" });

  const plan = store.createPlan({
    project: project.id,
    goal: "reduce auth complexity",
    risk: "medium",
  });

  assert.equal(store.listJobs(10).length, 2);
  assert.equal(await processNextJob(store), true);
  assert.equal(await processNextJob(store), true);

  const jobs = store.listJobs(10);
  assert.equal(jobs.every((job) => job.status === "completed"), true);
  assert.ok(store.listReviews(project.id, 10).length > 0);
  assert.ok(store.listProjectLessons(project.id, 20).some((lesson) => lesson.title.startsWith("Plan review")));
  assert.ok(store.listProjectLessons(project.id, 20).some((lesson) => lesson.title.startsWith("Reflection:")));

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});
