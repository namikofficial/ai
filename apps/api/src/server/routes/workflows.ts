import type { Router } from "express";
import type { EventEnvelope } from "../../../../../packages/shared/src/index.ts";
import { parseDevRequest } from "../../../../../packages/agent-protocol/src/dev.ts";
import { resolveProjectConfig } from "../../../../../packages/config/src/index.ts";
import { createStore } from "../../../../../packages/db/src/store.ts";
import { applyApprovedDevRun, approveDevRun, cancelDevRun, runDevWorkflow } from "../../../../../packages/dev-agent/src/index.ts";
import { createModelRuntime } from "../../../../../packages/model-runtime/src/index.ts";
import type { AskRequest, HandoffRequest, PlanRequest } from "../../../../../packages/shared/src/index.ts";
import { createEvent, parseAskRequest } from "../../../../../packages/shared/src/index.ts";
import { asyncRoute, isHtmlRequest, readJsonBody, readTextBody } from "../http.ts";
import { json, sendHtml, sendJson } from "../response.ts";
import { renderAskPage, renderChecksPage, renderHandoffPage, renderPlannerPage, renderResearchPage, renderReviewDetailPage, renderReviewsPage } from "../render-pages.ts";

type Store = ReturnType<typeof createStore>;

export function registerWorkflowRoutes(router: Router, deps: {
  store: Store;
  config: { runtimeDir: string; cloudEnabled: boolean };
  publish: (event: EventEnvelope) => void;
}) {
  router.get("/ask", (_req, res) => sendHtml(res, renderAskPage(deps.store)));

  router.post("/ask", asyncRoute(async (req, res) => {
    const body = (
      req.headers["content-type"]?.includes("application/json")
        ? await readJsonBody(req)
        : Object.fromEntries(new URLSearchParams(await readTextBody(req)))
    ) as Record<string, unknown>;
    const normalized: AskRequest = parseAskRequest(body);
    const result = await deps.store.ask(normalized);
    deps.store.listEvents(result.sessionId).forEach(deps.publish);
    if (isHtmlRequest(req)) {
      sendHtml(res, renderAskPage(deps.store, { result, question: normalized.question }));
      return;
    }
    sendJson(res, json("ok", result));
  }));

  router.get("/research", (req, res) => {
    if (!isHtmlRequest(req)) {
      sendJson(res, json("ok", { lessons: deps.store.listRecentLessons(20), rules: deps.store.listProjects().flatMap((project) => deps.store.listProjectRules(project.id, 10)) }));
      return;
    }
    sendHtml(res, renderResearchPage(deps.store));
  });

  router.post("/research", asyncRoute(async (req, res) => {
    const body = (
      req.headers["content-type"]?.includes("application/json")
        ? await readJsonBody(req)
        : Object.fromEntries(new URLSearchParams(await readTextBody(req)))
    ) as Record<string, unknown>;
    const projectId = String(body.project ?? body.projectId ?? "");
    const topic = String(body.topic ?? "");
    const mode = body.mode === "web" || body.mode === "hybrid" ? body.mode : "local";
    const chunks = deps.store.searchChunks(projectId, topic, { limit: mode === "local" ? 6 : 10 });
    const lessons = deps.store.listProjectLessons(projectId, 5);
    const sources = chunks.map((chunk) => ({ path: chunk.path, score: chunk.score, excerpt: chunk.content.split("\n").slice(0, 4).join("\n") }));
    const contradictions = lessons.filter((lesson) => /but|however|contradict|instead/i.test(lesson.body)).map((lesson) => lesson.title).slice(0, 5);
    const result = {
      summary: [`Topic: ${topic}`, `Mode: ${mode}`, "", `Found ${chunks.length} local sources and ${lessons.length} lessons.`, mode === "web" ? "Web research is not wired yet, so this result is local-first only." : "", "", ...sources.slice(0, 3).map((source) => `- ${source.path} (score ${source.score.toFixed(1)})`)].filter(Boolean).join("\n"),
      sources,
      contradictions,
      brief: [`Research brief for ${topic}.`, "Use the highest-scoring local sources first.", contradictions.length > 0 ? `Watch for contradictions in: ${contradictions.join(", ")}.` : "No obvious contradictions detected in current lessons.", `Top sources: ${sources.slice(0, 3).map((source) => source.path).join(", ") || "none"}.`].join("\n"),
    };
    if (isHtmlRequest(req)) {
      sendHtml(res, renderResearchPage(deps.store, { projectId, topic, mode, result }));
      return;
    }
    sendJson(res, json("ok", { projectId, topic, mode, ...result }));
  }));

  router.get("/planner", (req, res) => {
    if (!isHtmlRequest(req)) {
      sendJson(res, json("ok", { tasks: deps.store.listRecentTasks(40), projects: deps.store.listProjects(), recentSessions: deps.store.listSessions(20).filter((session) => session.mode === "plan"), activeSessionCount: deps.store.dashboardSnapshot().activeSessions }));
      return;
    }
    sendHtml(res, renderPlannerPage(deps.store));
  });

  router.post("/plan", asyncRoute(async (req, res) => {
    const body = (
      req.headers["content-type"]?.includes("application/json")
        ? await readJsonBody(req)
        : Object.fromEntries(new URLSearchParams(await readTextBody(req)))
    ) as Record<string, unknown>;
    const normalized: PlanRequest = {
      project: String(body.project ?? ""),
      goal: String(body.goal ?? ""),
      risk: body.risk === "low" || body.risk === "medium" || body.risk === "high" ? body.risk : "medium",
    };
    const result = await deps.store.createPlan(normalized);
    if (isHtmlRequest(req)) {
      sendHtml(res, renderPlannerPage(deps.store, { result: result.response }));
      return;
    }
    sendJson(res, json("ok", result.response));
  }));

  router.get("/handoff", (req, res) => {
    if (!isHtmlRequest(req)) {
      sendJson(res, json("ok", { projects: deps.store.listProjects(), sessions: deps.store.listSessions(20), handoffs: deps.store.listHandoffs(undefined, 20) }));
      return;
    }
    sendHtml(res, renderHandoffPage(deps.store));
  });

  router.post("/handoff", asyncRoute(async (req, res) => {
    const body = (
      req.headers["content-type"]?.includes("application/json")
        ? await readJsonBody(req)
        : Object.fromEntries(new URLSearchParams(await readTextBody(req)))
    ) as Record<string, unknown>;
    const normalized: HandoffRequest = {
      sessionId: String(body.sessionId ?? ""),
      project: String(body.project ?? ""),
      target: body.target === "opencode" || body.target === "codex" || body.target === "manual" || body.target === "clipboard" || body.target === "file" ? body.target : "manual",
      subtask: String(body.subtask ?? ""),
    };
    const result = await deps.store.createHandoff(normalized);
    if (isHtmlRequest(req)) {
      sendHtml(res, renderHandoffPage(deps.store, { result }));
      return;
    }
    sendJson(res, json("ok", result));
  }));

  router.get("/checks", (req, res) => {
    if (!isHtmlRequest(req)) {
      sendJson(res, json("ok", deps.store.listCheckRuns(20)));
      return;
    }
    sendHtml(res, renderChecksPage(deps.store));
  });

  router.post("/checks/run", asyncRoute(async (req, res) => {
    const body = (
      req.headers["content-type"]?.includes("application/json")
        ? await readJsonBody(req)
        : Object.fromEntries(new URLSearchParams(await readTextBody(req)))
    ) as Record<string, unknown>;
    const name = String(body.name ?? "");
    const projectId = body.projectId ? String(body.projectId) : null;
    const allowed = new Set(["typecheck", "tests", "build", "lint"]);
    const check = deps.store.createCheckRun({
      name,
      projectId,
      status: allowed.has(name) ? "completed" : "blocked",
      command: name,
      output: allowed.has(name) ? `Recorded allowlisted check ${name}.` : null,
      errorOutput: allowed.has(name) ? null : `Check ${name} is not allowlisted.`,
      exitCode: allowed.has(name) ? 0 : 1,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
    if (!allowed.has(name)) {
      deps.store.appendEvent(createEvent("tool.blocked", { tool: name, reason: "check not allowlisted" }, { projectId, agent: "checks" }));
    } else {
      deps.store.appendEvent(createEvent("check.completed", { name }, { projectId, agent: "checks" }));
    }
    if (isHtmlRequest(req)) {
      sendHtml(res, renderChecksPage(deps.store));
      return;
    }
    sendJson(res, json("ok", check));
  }));

  router.get("/reviews", (req, res) => {
    if (!isHtmlRequest(req)) {
      sendJson(res, json("ok", deps.store.listReviews(undefined, 20)));
      return;
    }
    sendHtml(res, renderReviewsPage(deps.store));
  });

  router.get("/reviews/:reviewId", (req, res) => {
    const reviewId = decodeURIComponent(String(req.params.reviewId ?? ""));
    if (!isHtmlRequest(req)) {
      sendJson(res, json("ok", deps.store.getReview(reviewId)));
      return;
    }
    sendHtml(res, renderReviewDetailPage(deps.store, reviewId));
  });

  router.post("/reviews", asyncRoute(async (req, res) => {
    const body = (
      req.headers["content-type"]?.includes("application/json")
        ? await readJsonBody(req)
        : Object.fromEntries(new URLSearchParams(await readTextBody(req)))
    ) as Record<string, unknown>;
    const result = deps.store.createReview({
      project: String(body.project ?? ""),
      sessionId: body.sessionId ? String(body.sessionId) : null,
      title: body.title ? String(body.title) : undefined,
      plannedFiles: String(body.plannedFiles ?? "").split(",").map((item) => item.trim()).filter(Boolean),
      editedFiles: String(body.editedFiles ?? "").split(",").map((item) => item.trim()).filter(Boolean),
      checks: String(body.checks ?? "").split(",").map((item) => item.trim()).filter(Boolean),
      notes: body.notes ? String(body.notes) : undefined,
    });
    const job = deps.store.enqueueJob({ type: "review.reflect", payload: { reviewId: result.id, source: "api" } });
    if (isHtmlRequest(req)) {
      sendHtml(res, renderReviewsPage(deps.store, { result }));
      return;
    }
    sendJson(res, json("ok", { result, jobId: job.id }));
  }));

  router.get("/handoffs/:handoffId", (req, res) => {
    const handoffId = decodeURIComponent(String(req.params.handoffId ?? ""));
    const handoff = deps.store.listHandoffs(undefined, 100).find((item) => item.id === handoffId) ?? null;
    sendJson(res, json("ok", handoff));
  });

  router.post("/dev/run", asyncRoute(async (req, res) => {
    const body = (
      req.headers["content-type"]?.includes("application/json")
        ? await readJsonBody(req)
        : Object.fromEntries(new URLSearchParams(await readTextBody(req)))
    ) as Record<string, unknown>;
    const devRequest = parseDevRequest({
      project: body.project ?? body.projectId ?? "",
      goal: body.goal ?? "",
      mode: body.mode,
      approvalPolicy: body.approvalPolicy,
      approveEdits: body.approveEdits,
      checks: Array.isArray(body.checks) ? body.checks : undefined,
      maxRepairs: typeof body.maxRepairs === "number" ? body.maxRepairs : undefined,
    });
    const projectId = String(body.projectId ?? devRequest.project);
    const project = deps.store.getProject(projectId);
    if (!project) {
      sendJson(res, json("error", undefined, { message: `unknown project: ${projectId}` }), 404);
      return;
    }
    const session = deps.store.createSession({
      projectId: project.id,
      title: devRequest.goal.slice(0, 80),
      userGoal: devRequest.goal,
      mode: "dev",
      source: "api",
      modelProfile: "dev-editor-local",
    });
    await deps.store.ensureRuntimeDirs(deps.config.runtimeDir);
    const result = await runDevWorkflow({
      request: devRequest,
      project: { id: project.id, name: project.name, path: project.path, config: resolveProjectConfig(project.path).raw },
      runtime: {
        devRuns: deps.store.dev,
        execution: deps.store.execution,
        retrieval: deps.store.retrieval,
        models: deps.store.models,
        conversation: deps.store.conversation,
        modelRuntime: createModelRuntime({
          providers: deps.store.models.listProviders().map((provider) => ({ id: provider.id, kind: provider.kind, displayName: provider.displayName, baseUrl: provider.baseUrl, apiKeyEnv: provider.apiKeyEnv, enabled: provider.enabled })),
          profiles: deps.store.models.listProfiles(),
          cloudEnabled: deps.config.cloudEnabled,
        }),
      },
      runtimeDir: deps.config.runtimeDir,
      sessionId: session.id,
      source: "api",
    });
    sendJson(res, json("ok", result.result));
  }));

  router.get("/dev/runs", (req, res) => {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
    const limit = Number(req.query.limit ?? "50") || 50;
    sendJson(res, json("ok", { runs: deps.store.dev.listRuns(projectId ? { projectId, limit } : { limit }) }));
  });

  router.get("/dev/runs/:runId", (req, res) => {
    const runId = decodeURIComponent(String(req.params.runId ?? ""));
    const run = deps.store.dev.getRunWithEdits(runId);
    if (!run) {
      sendJson(res, json("error", undefined, { message: "dev run not found" }), 404);
      return;
    }
    sendJson(res, json("ok", { run, workspace: deps.store.execution.getWorkspaceForRun(run.id), approvals: deps.store.execution.listApprovals(run.id), patches: deps.store.execution.listPatches(run.id) }));
  });

  router.get("/dev/runs/:runId/diff", (req, res) => {
    const runId = decodeURIComponent(String(req.params.runId ?? ""));
    const run = deps.store.dev.getRun(runId);
    if (!run) {
      sendJson(res, json("error", undefined, { message: "dev run not found" }), 404);
      return;
    }
    sendJson(
      res,
      json("ok", {
        runId: run.id,
        status: run.status,
        diff: run.diffText,
        diffText: run.diffText,
        diffSummary: run.diffSummary,
        summary: run.summary,
        filesEdited: run.filesEdited,
        filesCreated: run.filesCreated,
      })
    );
  });

  router.post("/dev/runs/:runId/approve", asyncRoute(async (req, res) => {
    const runId = decodeURIComponent(String(req.params.runId ?? ""));
    const body = req.headers["content-type"]?.includes("application/json") ? (await readJsonBody(req)) as Record<string, unknown> | null : {};
    const approval = await approveDevRun({
      runId,
      runtime: { devRuns: deps.store.dev, execution: deps.store.execution },
      decidedBy: typeof body?.decidedBy === "string" ? body.decidedBy : "api",
      notes: typeof body?.notes === "string" ? body.notes : undefined,
    });
    sendJson(res, approval.ok ? json("ok", approval.run) : json("error", undefined, { message: approval.error ?? "approval failed" }), approval.ok ? 200 : 400);
  }));

  router.post("/dev/runs/:runId/apply", asyncRoute(async (req, res) => {
    const runId = decodeURIComponent(String(req.params.runId ?? ""));
    const run = deps.store.dev.getRun(runId);
    if (!run) {
      sendJson(res, json("error", undefined, { message: "dev run not found" }), 404);
      return;
    }
    const project = deps.store.getProject(run.projectId);
    if (!project) {
      sendJson(res, json("error", undefined, { message: "project not found" }), 404);
      return;
    }
    const outcome = await applyApprovedDevRun({ runId, projectPath: project.path, runtime: { devRuns: deps.store.dev, execution: deps.store.execution } });
    sendJson(res, outcome.ok ? json("ok", { run: outcome.run, applied: outcome.applied }) : json("error", undefined, { message: outcome.error ?? "apply failed" }), outcome.ok ? 200 : 400);
  }));

  router.post("/dev/runs/:runId/cancel", asyncRoute(async (req, res) => {
    const runId = decodeURIComponent(String(req.params.runId ?? ""));
    const body = req.headers["content-type"]?.includes("application/json") ? (await readJsonBody(req)) as Record<string, unknown> | null : {};
    const outcome = await cancelDevRun({ runId, runtime: { devRuns: deps.store.dev, execution: deps.store.execution }, reason: typeof body?.reason === "string" ? body.reason : undefined });
    sendJson(res, outcome.ok ? json("ok", outcome.run) : json("error", undefined, { message: outcome.error ?? "cancel failed" }), outcome.ok ? 200 : 400);
  }));
}
