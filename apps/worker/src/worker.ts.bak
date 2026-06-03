import { mkdir } from "node:fs/promises";
import { resolveConfig } from "../../../packages/config/src/index.ts";
import { initializeStore, createStore } from "../../../packages/db/src/store.ts";
import type { ConfigSnapshot } from "../../../packages/shared/src/index.ts";

interface WorkerOptions {
  config?: Partial<ConfigSnapshot>;
  pollIntervalMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePayload(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore malformed payloads and let the worker fail the job.
  }
  return {};
}

export async function processNextJob(store: ReturnType<typeof createStore>): Promise<boolean> {
  const job = store.claimNextJob();
  if (!job) {
    return false;
  }

  try {
    const payload = parsePayload(job.payloadJson);
    let output: unknown;

    if (job.type === "plan.review") {
      const projectId = typeof payload.projectId === "string" ? payload.projectId : null;
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : null;
      const goal = typeof payload.goal === "string" ? payload.goal : "unknown goal";
      const taskGraph = Array.isArray(payload.taskGraph) ? payload.taskGraph : [];
      const editedFiles = taskGraph.flatMap((task) => {
        if (typeof task !== "object" || task === null) return [];
        const files = (task as { expectedFiles?: unknown }).expectedFiles;
        return Array.isArray(files) ? files.filter((file): file is string => typeof file === "string") : [];
      });
      output = {
        review: store.createReview({
          project: projectId ?? "",
          sessionId,
          title: `Plan review: ${goal}`,
          plannedFiles: [],
          editedFiles,
          checks: ["typecheck", "tests"],
          notes: `Reviewed a generated plan with ${taskGraph.length} tasks for ${goal}.`,
        }),
        lesson: store.createLesson({
          projectId,
          sessionId,
          title: `Plan review: ${goal}`,
          body: `Reviewed a generated plan with ${taskGraph.length} tasks for ${goal}.`,
          tags: ["worker", "review", "plan"],
          importance: 2,
        }),
      };
    } else if (job.type === "handoff.archive") {
      const projectId = typeof payload.projectId === "string" ? payload.projectId : null;
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : null;
      const target = typeof payload.target === "string" ? payload.target : "manual";
      const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
      output = {
        review: store.createReview({
          project: projectId ?? "",
          sessionId,
          title: `Handoff archive: ${target}`,
          plannedFiles: [],
          editedFiles: [],
          checks: ["typecheck", "tests"],
          notes: prompt.slice(0, 500),
        }),
        lesson: store.createLesson({
          projectId,
          sessionId,
          title: `Handoff archive: ${target}`,
          body: prompt.slice(0, 500),
          tags: ["worker", "handoff"],
          importance: 2,
        }),
      };
    } else if (job.type === "session.reflect") {
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : null;
      const session = sessionId ? store.getSession(sessionId) : null;
      if (!session) {
        throw new Error(`Unknown session: ${sessionId ?? "missing"}`);
      }
      output = store.createLesson({
        projectId: session.projectId,
        sessionId: session.id,
        title: `Reflection: ${session.title}`,
        body: session.finalSummary ?? session.userGoal,
        tags: ["worker", "reflection"],
        importance: 3,
      });
    } else if (job.type === "review.reflect") {
      const reviewId = typeof payload.reviewId === "string" ? payload.reviewId : null;
      const review = reviewId ? store.getReview(reviewId) : null;
      if (!review) {
        throw new Error(`Unknown review: ${reviewId ?? "missing"}`);
      }
      output = store.createLesson({
        projectId: review.projectId,
        sessionId: review.sessionId,
        title: `Review reflection: ${review.title}`,
        body: `${review.summary}\n\nReflect on follow-up actions and keep the scope tight.`,
        tags: ["worker", "review", "reflection"],
        importance: 3,
      });
    } else {
      output = { skipped: true, reason: `No worker for job type ${job.type}` };
    }

    store.completeJob(job.id, output);
    return true;
  } catch (error) {
    store.failJob(job.id, error instanceof Error ? error.message : String(error));
    return true;
  }
}

export async function startWorkbenchWorker(options: WorkerOptions = {}): Promise<void> {
  const config = resolveConfig(options.config ?? {});
  await mkdir(config.runtimeDir, { recursive: true });
  const store = createStore(initializeStore(config.databasePath));
  await store.ensureRuntimeDirs(config.runtimeDir);

  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  let stopped = false;

  process.on("SIGINT", () => {
    stopped = true;
  });
  process.on("SIGTERM", () => {
    stopped = true;
  });

  while (!stopped) {
    const processed = await processNextJob(store);
    if (!processed) {
      await sleep(pollIntervalMs);
    }
  }
}
