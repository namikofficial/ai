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

  const plan = await store.createPlan({
    project: project.id,
    goal: "reduce auth complexity",
    risk: "medium",
  });

  assert.equal(store.listJobs(10).length, 2);
  assert.equal(await processNextJob(store), true);
  assert.equal(await processNextJob(store), true);
  assert.equal(await processNextJob(store), true);

  const jobs = store.listJobs(10);
  assert.equal(jobs.every((job) => job.status === "completed"), true);
  assert.ok(store.listReviews(project.id, 10).length > 0);
  assert.ok(store.listProjectLessons(project.id, 20).some((lesson) => lesson.title.startsWith("Plan review")));
  assert.ok(store.listProjectLessons(project.id, 20).some((lesson) => lesson.title.startsWith("Reflection:")));

  const planReviewed = store.listEvents().find((e) => e.type === "plan.reviewed");
  assert.ok(planReviewed, "plan.review job should emit a plan.reviewed event when sessionId is present");
  const planReviewedPayload = planReviewed!.payload as { taskCount: number; counts: { memoryCandidates: number; skillCandidates: number } };
  assert.equal(planReviewedPayload.taskCount, plan.response.taskGraph.length);
  assert.ok(planReviewedPayload.counts, "plan.reviewed should include reflection counts");
  const planSession = store.listProjectSessions(project.id, 50).find((s) => s.userGoal.includes("reduce auth complexity"));
  assert.ok(planSession);
  const planCandidates = store.memory.listCandidates("pending", project.id, 100).filter((c) => c.sessionId === planSession!.id);
  const planSkills = store.skills.listCandidates("pending", 100).filter((c) => c.exampleSessionId === planSession!.id);
  assert.ok(planCandidates.length + planSkills.length > 0, "plan.review should surface at least one memory or skill candidate via the reflection engine");

  const review = store.createReview({
    project: project.id,
    title: "worker review",
    plannedFiles: ["src/auth.ts"],
    editedFiles: ["src/auth.ts", "src/session.ts"],
    checks: ["typecheck"],
  });

  assert.equal(store.listJobs(10).some((job) => job.type === "review.reflect"), true);
  assert.equal(await processNextJob(store), true);
  assert.equal(store.listJobs(10).some((job) => job.status === "queued" && job.type === "review.reflect"), false);
  assert.ok(store.listProjectLessons(project.id, 20).some((lesson) => lesson.title === `Review reflection: ${review.title}`));

  const handoffSession = store.createSession({
    projectId: project.id,
    title: "handoff",
    userGoal: "transfer knowledge to another agent",
    mode: "local",
    source: "test",
  });
  await store.createHandoff({
    sessionId: handoffSession.id,
    project: project.id,
    target: "opencode",
    subtask: "take over the auth refactor",
  });
  const handoffJob = store.listJobs(50).find((job) => job.type === "handoff.archive");
  assert.ok(handoffJob, "createHandoff should enqueue a handoff.archive job");
  assert.equal(await processNextJob(store), true);
  const archived = store.listEvents().find((e) => e.type === "handoff.archived");
  assert.ok(archived, "handoff.archive job should emit a handoff.archived event when sessionId is present");
  const archivedPayload = archived!.payload as { target: string; counts: { memoryCandidates: number; skillCandidates: number } };
  assert.equal(archivedPayload.target, "opencode");
  assert.ok(archivedPayload.counts);
  const handoffCandidates = store.memory.listCandidates("pending", project.id, 100).filter((c) => c.sessionId === handoffSession.id);
  const handoffSkills = store.skills.listCandidates("pending", 100).filter((c) => c.exampleSessionId === handoffSession.id);
  assert.ok(
    handoffCandidates.length + handoffSkills.length > 0,
    "handoff.archive should surface at least one memory or skill candidate via the reflection engine",
  );

  store.db.close();
  await rm(workspace, { recursive: true, force: true });
});
