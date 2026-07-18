import type { Router } from "express";
import { parseDevRequest } from "../../../../../packages/agent-protocol/src/dev.ts";
import { resolveProjectConfig } from "../../../../../packages/config/src/index.ts";
import { CONTROL_PLANE_SCHEMA_VERSION, type WorkflowExecution } from "../../../../../packages/contracts/src/index.ts";
import type { createStore } from "../../../../../packages/db/src/store.ts";
import {
  applyApprovedDevRun,
  approveDevRun,
  cancelDevRun,
  runDevWorkflow,
} from "../../../../../packages/dev-agent/src/index.ts";
import { readProjectChecksConfig, runAllowedChecks } from "../../../../../packages/execution-engine/src/index.ts";
import {
  collectWorkflowApprovalContext,
  prepareManifestWorkflow,
  runPreparedManifestWorkflow,
  workflowApprovalContextHash,
} from "../../../../../packages/execution-engine/src/workflows.ts";
import { createModelRuntime } from "../../../../../packages/model-runtime/src/index.ts";
import { recommendedActionsFromManifest } from "../../../../../packages/project-status/src/index.ts";
import type {
  AskRequest,
  EventEnvelope,
  HandoffRequest,
  PlanRequest,
} from "../../../../../packages/shared/src/index.ts";
import { createEvent, createId, parseAskRequest } from "../../../../../packages/shared/src/index.ts";
import { asyncRoute, isHtmlRequest, readJsonBody, readTextBody } from "../http.ts";
import {
  renderAskPage,
  renderChecksPage,
  renderHandoffPage,
  renderPlannerPage,
  renderResearchPage,
  renderReviewDetailPage,
  renderReviewsPage,
} from "../render-pages.ts";
import { json, sendHtml, sendJson } from "../response.ts";

type Store = ReturnType<typeof createStore>;

export function registerWorkflowRoutes(
  router: Router,
  deps: {
    store: Store;
    config: { runtimeDir: string; cloudEnabled: boolean };
    publish: (event: EventEnvelope) => void;
  }
) {
  const activeWorkflowControllers = new Map<string, AbortController>();

  function commandRecord(workflow: { spec: { binary: string; args: string[] }; cwd: string }): {
    executable: string;
    arguments: string[];
    workingDirectory: string;
  } {
    return {
      executable: workflow.spec.binary,
      arguments: workflow.spec.args,
      workingDirectory: workflow.cwd,
    };
  }

  function createWorkflowExecution(input: {
    workflowId: string;
    projectId: string;
    sessionId: string | null;
    taskId: string | null;
    state: "running" | "waiting";
  }): WorkflowExecution {
    const timestamp = new Date().toISOString();
    return {
      schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
      id: createId("workflow_execution"),
      createdAt: timestamp,
      updatedAt: timestamp,
      origin: { source: "workbench", instanceId: "workbench-api", legacyRef: null },
      capabilities: [],
      workflowId: input.workflowId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      runId: null,
      state: input.state,
      currentStepId: input.state === "running" ? "command" : "approval",
      stepStates: input.state === "running" ? { command: "running" } : { approval: "waiting", command: "waiting" },
      startedAt: input.state === "running" ? timestamp : null,
      finishedAt: null,
      approvalId: null,
      exitCode: null,
      artifacts: [],
      errorCode: null,
      errorSummary: null,
    };
  }

  function cancelWaitingWorkflow(
    record: NonNullable<ReturnType<Store["workflows"]["get"]>>,
    errorCode: string,
    errorSummary: string
  ) {
    const timestamp = new Date().toISOString();
    const execution: WorkflowExecution = {
      ...record.execution,
      updatedAt: timestamp,
      state: "cancelled",
      currentStepId: null,
      stepStates: { approval: "cancelled", command: "cancelled" },
      finishedAt: timestamp,
      errorCode,
      errorSummary,
    };
    return deps.store.workflows.save({ ...record, execution });
  }

  async function executePreparedWorkflow(
    prepared: Awaited<ReturnType<typeof prepareManifestWorkflow>> & { ok: true },
    existing: WorkflowExecution,
    causationId: string | null = null
  ) {
    const startedAt = new Date().toISOString();
    const running: WorkflowExecution = {
      ...existing,
      updatedAt: startedAt,
      state: "running",
      currentStepId: "command",
      stepStates: { ...(existing.approvalId ? { approval: "completed" } : {}), command: "running" },
      startedAt,
      finishedAt: null,
      errorCode: null,
      errorSummary: null,
    };
    deps.store.workflows.save({
      execution: running,
      command: commandRecord(prepared.workflow),
      stdout: "",
      stderr: "",
      durationMs: 0,
    });
    const startedEvent = createEvent(
      "workflow.started",
      { workflowId: prepared.workflow.workflowId, executionId: running.id },
      {
        projectId: running.projectId,
        sessionId: running.sessionId,
        taskId: running.taskId,
        agent: "workflow-executor",
        sourceService: "workbench-api",
        summary: `${prepared.workflow.command.name} started`,
        correlationId: running.id,
        causationId,
      }
    );
    deps.store.appendEvent(startedEvent);
    deps.publish(startedEvent);

    const controller = new AbortController();
    activeWorkflowControllers.set(running.id, controller);
    let result: Awaited<ReturnType<typeof runPreparedManifestWorkflow>>;
    try {
      result = await runPreparedManifestWorkflow(prepared.workflow, { signal: controller.signal });
    } finally {
      activeWorkflowControllers.delete(running.id);
    }
    const state =
      result.status === "completed"
        ? "completed"
        : result.status === "blocked"
          ? "blocked"
          : result.status === "cancelled"
            ? "cancelled"
            : "failed";
    const execution: WorkflowExecution = {
      ...running,
      updatedAt: result.finishedAt,
      state,
      currentStepId: null,
      stepStates: { ...(running.approvalId ? { approval: "completed" } : {}), command: state },
      finishedAt: result.finishedAt,
      exitCode: result.exitCode,
      errorCode:
        state === "completed"
          ? null
          : result.status === "blocked"
            ? "command_blocked"
            : result.status === "cancelled"
              ? "command_cancelled"
              : "command_failed",
      errorSummary: state === "completed" ? null : (result.blockedReason ?? (result.stderr.slice(0, 1_000) || null)),
    };
    const saved = deps.store.workflows.save({
      execution,
      command: commandRecord(prepared.workflow),
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
    });

    if (prepared.workflow.command.category === "check") {
      deps.store.createCheckRun({
        name: prepared.workflow.command.id,
        projectId: running.projectId,
        status: result.status === "cancelled" ? "failed" : result.status,
        command: result.command,
        output: result.stdout || null,
        errorOutput: result.stderr || result.blockedReason,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        parsedErrors: result.parsedErrors,
        affectedFiles: result.affectedFiles,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
      });
    }
    const event = createEvent(
      state === "completed"
        ? "workflow.completed"
        : state === "blocked"
          ? "workflow.blocked"
          : state === "cancelled"
            ? "workflow.cancelled"
            : "workflow.failed",
      { workflowId: prepared.workflow.workflowId, executionId: running.id, exitCode: result.exitCode },
      {
        projectId: running.projectId,
        sessionId: running.sessionId,
        taskId: running.taskId,
        agent: "workflow-executor",
        sourceService: "workbench-api",
        level: state === "completed" ? "info" : state === "cancelled" ? "warn" : "error",
        summary: `${prepared.workflow.command.name} ${state}`,
        correlationId: running.id,
        causationId: startedEvent.id,
      }
    );
    deps.store.appendEvent(event);
    deps.publish(event);
    return saved;
  }

  router.get("/actions", (req, res) => {
    const explicitProjectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
    const projectId = explicitProjectId ?? deps.store.projectRegistry.getSelection()?.projectId ?? null;
    if (!projectId) {
      sendJson(res, json("error", undefined, { message: "no active project; select a project first" }), 409);
      return;
    }
    const manifest = deps.store.projectRegistry.getManifest(projectId);
    if (!manifest) {
      sendJson(res, json("error", undefined, { message: `project ${projectId} has no approved manifest` }), 404);
      return;
    }
    sendJson(res, json("ok", recommendedActionsFromManifest(manifest)));
  });

  router.get("/actions/executions/:executionId", (req, res) => {
    const executionId = decodeURIComponent(String(req.params.executionId ?? ""));
    const execution = deps.store.workflows.get(executionId);
    if (!execution) {
      sendJson(res, json("error", undefined, { message: `workflow execution ${executionId} not found` }), 404);
      return;
    }
    sendJson(res, json("ok", { ...execution, approval: deps.store.workflows.getApprovalForExecution(executionId) }));
  });

  router.post(
    "/actions/executions/:executionId/approve",
    asyncRoute(async (req, res) => {
      const executionId = decodeURIComponent(String(req.params.executionId ?? ""));
      const record = deps.store.workflows.get(executionId);
      const approval = deps.store.workflows.getApprovalForExecution(executionId);
      if (!record || !approval) {
        sendJson(res, json("error", undefined, { message: "workflow execution or approval not found" }), 404);
        return;
      }
      if (record.execution.state !== "waiting" || approval.status !== "pending") {
        sendJson(res, json("error", undefined, { message: "workflow approval is not pending" }), 409);
        return;
      }
      const body = (await readJsonBody(req)) as { decidedBy?: unknown; notes?: unknown };
      const decidedBy = typeof body.decidedBy === "string" && body.decidedBy.trim() ? body.decidedBy.trim() : "api";
      if (Date.parse(approval.expiresAt) <= Date.now()) {
        deps.store.workflows.decideApproval({ id: approval.id, status: "expired", decidedBy, notes: "expired" });
        cancelWaitingWorkflow(record, "approval_expired", "Workflow approval expired");
        sendJson(res, json("error", undefined, { message: "workflow approval expired" }), 409);
        return;
      }
      const project = deps.store.getProject(record.execution.projectId);
      const manifest = deps.store.projectRegistry.getManifest(record.execution.projectId);
      if (!project || !manifest || manifest.path !== project.path) {
        sendJson(res, json("error", undefined, { message: "canonical project or approved manifest changed" }), 409);
        return;
      }
      const prepared = await prepareManifestWorkflow(manifest, record.execution.workflowId, { allowMutating: true });
      if (!prepared.ok) {
        sendJson(res, json("error", undefined, { message: prepared.rejection.summary }), 409);
        return;
      }
      const context = await collectWorkflowApprovalContext(prepared.workflow);
      if (workflowApprovalContextHash(context) !== approval.contextHash) {
        deps.store.workflows.decideApproval({
          id: approval.id,
          status: "expired",
          decidedBy,
          notes: "reviewed workflow context changed",
        });
        cancelWaitingWorkflow(record, "approval_stale", "Workflow approval context changed");
        sendJson(
          res,
          json("error", undefined, { message: "workflow approval is stale because its context changed" }),
          409
        );
        return;
      }
      const decided = deps.store.workflows.decideApproval({
        id: approval.id,
        status: "approved",
        decidedBy,
        notes: typeof body.notes === "string" ? body.notes : null,
      });
      const granted = createEvent(
        "approval.granted",
        { approvalId: decided.id, executionId, kind: "workflow" },
        {
          projectId: record.execution.projectId,
          sessionId: record.execution.sessionId,
          taskId: record.execution.taskId,
          agent: "workflow-approvals",
          sourceService: "workbench-api",
          summary: `Workflow ${record.execution.workflowId} approved`,
          correlationId: executionId,
        }
      );
      deps.store.appendEvent(granted);
      deps.publish(granted);
      const saved = await executePreparedWorkflow(prepared, record.execution, granted.id);
      sendJson(res, json("ok", { ...saved, approval: decided }), saved.execution.state === "completed" ? 200 : 422);
    })
  );

  router.post(
    "/actions/executions/:executionId/reject",
    asyncRoute(async (req, res) => {
      const executionId = decodeURIComponent(String(req.params.executionId ?? ""));
      const record = deps.store.workflows.get(executionId);
      const approval = deps.store.workflows.getApprovalForExecution(executionId);
      if (!record || !approval) {
        sendJson(res, json("error", undefined, { message: "workflow execution or approval not found" }), 404);
        return;
      }
      if (record.execution.state !== "waiting" || approval.status !== "pending") {
        sendJson(res, json("error", undefined, { message: "workflow approval is not pending" }), 409);
        return;
      }
      const body = (await readJsonBody(req)) as { decidedBy?: unknown; notes?: unknown };
      const decided = deps.store.workflows.decideApproval({
        id: approval.id,
        status: "rejected",
        decidedBy: typeof body.decidedBy === "string" && body.decidedBy.trim() ? body.decidedBy.trim() : "api",
        notes: typeof body.notes === "string" ? body.notes : null,
      });
      const saved = cancelWaitingWorkflow(record, "approval_rejected", "Workflow approval was rejected");
      const execution = saved.execution;
      const event = createEvent(
        "approval.rejected",
        { approvalId: decided.id, executionId, kind: "workflow" },
        {
          projectId: execution.projectId,
          sessionId: execution.sessionId,
          taskId: execution.taskId,
          agent: "workflow-approvals",
          sourceService: "workbench-api",
          level: "warn",
          summary: `Workflow ${execution.workflowId} rejected`,
          correlationId: executionId,
        }
      );
      deps.store.appendEvent(event);
      deps.publish(event);
      sendJson(res, json("ok", { ...saved, approval: decided }));
    })
  );

  router.post("/actions/executions/:executionId/cancel", (req, res) => {
    const executionId = decodeURIComponent(String(req.params.executionId ?? ""));
    const record = deps.store.workflows.get(executionId);
    if (!record) {
      sendJson(res, json("error", undefined, { message: "workflow execution not found" }), 404);
      return;
    }
    if (record.execution.state === "running") {
      const controller = activeWorkflowControllers.get(executionId);
      if (controller) {
        controller.abort();
        sendJson(res, json("ok", { executionId, state: "cancelling" }), 202);
        return;
      }
    }
    sendJson(
      res,
      json("error", undefined, { message: `workflow cannot be cancelled from ${record.execution.state}` }),
      409
    );
  });

  router.post(
    "/actions/:workflowId/run",
    asyncRoute(async (req, res) => {
      const workflowId = decodeURIComponent(String(req.params.workflowId ?? ""));
      const body = (await readJsonBody(req)) as { projectId?: unknown; sessionId?: unknown; taskId?: unknown };
      const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : null;
      const taskId = typeof body.taskId === "string" && body.taskId.trim() ? body.taskId.trim() : null;
      const projectId =
        typeof body.projectId === "string" && body.projectId.trim()
          ? body.projectId.trim()
          : deps.store.projectRegistry.getSelection()?.projectId;
      if (!projectId) {
        sendJson(res, json("error", undefined, { message: "no active project; select a project first" }), 409);
        return;
      }
      const session = sessionId ? deps.store.getSession(sessionId) : null;
      if (sessionId && !session) {
        sendJson(res, json("error", undefined, { message: `session ${sessionId} not found` }), 404);
        return;
      }
      if (session?.projectId !== undefined && session.projectId !== projectId) {
        sendJson(res, json("error", undefined, { message: "session belongs to a different project" }), 409);
        return;
      }
      const task = taskId ? deps.store.getTask(taskId) : null;
      if (taskId && !task) {
        sendJson(res, json("error", undefined, { message: `task ${taskId} not found` }), 404);
        return;
      }
      if (task && (!session || task.sessionId !== session.id)) {
        sendJson(res, json("error", undefined, { message: "task does not belong to the requested session" }), 409);
        return;
      }
      const project = deps.store.getProject(projectId);
      const manifest = deps.store.projectRegistry.getManifest(projectId);
      if (!project || !manifest) {
        sendJson(res, json("error", undefined, { message: `project ${projectId} has no approved manifest` }), 404);
        return;
      }
      if (manifest.path !== project.path) {
        sendJson(
          res,
          json("error", undefined, { message: "approved manifest path does not match canonical project" }),
          409
        );
        return;
      }
      const prepared = await prepareManifestWorkflow(manifest, workflowId, { allowMutating: true });
      if (!prepared.ok) {
        const blocked = createEvent(
          "workflow.blocked",
          { workflowId, code: prepared.rejection.code },
          {
            projectId,
            agent: "workflow-executor",
            sourceService: "workbench-api",
            level: "warn",
            summary: prepared.rejection.summary,
            correlationId: createId("workflow_blocked"),
          }
        );
        deps.store.appendEvent(blocked);
        deps.publish(blocked);
        sendJson(res, json("error", undefined, { message: prepared.rejection.summary }), 409);
        return;
      }

      const initial = createWorkflowExecution({
        workflowId: prepared.workflow.workflowId,
        projectId,
        sessionId,
        taskId,
        state: prepared.workflow.command.mutation === "read_only" ? "running" : "waiting",
      });
      if (prepared.workflow.command.mutation !== "read_only") {
        deps.store.workflows.save({
          execution: initial,
          command: commandRecord(prepared.workflow),
          stdout: "",
          stderr: "",
          durationMs: 0,
        });
        const context = await collectWorkflowApprovalContext(prepared.workflow);
        const approval = deps.store.workflows.requestApproval({
          executionId: initial.id,
          workflowId: initial.workflowId,
          projectId,
          mutation: prepared.workflow.command.mutation,
          contextHash: workflowApprovalContextHash(context),
          branch: context.branch,
          baseCommit: context.baseCommit,
          reason: `${prepared.workflow.command.name} requests ${prepared.workflow.command.mutation} access`,
        });
        const waiting: WorkflowExecution = { ...initial, approvalId: approval.id };
        const saved = deps.store.workflows.save({
          execution: waiting,
          command: commandRecord(prepared.workflow),
          stdout: "",
          stderr: "",
          durationMs: 0,
        });
        const event = createEvent(
          "approval.required",
          { approvalId: approval.id, executionId: waiting.id, workflowId: waiting.workflowId, kind: "workflow" },
          {
            projectId,
            sessionId: waiting.sessionId,
            taskId: waiting.taskId,
            agent: "workflow-approvals",
            sourceService: "workbench-api",
            level: "warn",
            summary: approval.reason,
            correlationId: waiting.id,
          }
        );
        deps.store.appendEvent(event);
        deps.publish(event);
        sendJson(
          res,
          json("ok", { ...saved, approval, deepLink: `/approvals/${encodeURIComponent(approval.id)}` }),
          202
        );
        return;
      }
      const saved = await executePreparedWorkflow(prepared, initial);
      sendJson(res, json("ok", saved), saved.execution.state === "completed" ? 200 : 422);
    })
  );

  router.get("/ask", (_req, res) => sendHtml(res, renderAskPage(deps.store)));

  router.post(
    "/ask",
    asyncRoute(async (req, res) => {
      const body = (
        req.headers["content-type"]?.includes("application/json")
          ? await readJsonBody(req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(req)))
      ) as Record<string, unknown>;
      const normalized: AskRequest = parseAskRequest(body);
      const askSession = normalized.sessionId ? deps.store.getSession(normalized.sessionId) : null;
      if (normalized.sessionId && !askSession) {
        sendJson(res, json("error", undefined, { message: "session not found" }), 404);
        return;
      }
      if (askSession && askSession.projectId !== normalized.project) {
        sendJson(res, json("error", undefined, { message: "session belongs to a different project" }), 409);
        return;
      }
      const result = await deps.store.ask(normalized);
      deps.store.listEvents(result.sessionId).forEach(deps.publish);
      if (isHtmlRequest(req)) {
        sendHtml(res, renderAskPage(deps.store, { result, question: normalized.question }));
        return;
      }
      sendJson(res, json("ok", result));
    })
  );

  router.get("/research", (req, res) => {
    if (!isHtmlRequest(req)) {
      sendJson(
        res,
        json("ok", {
          lessons: deps.store.listRecentLessons(20),
          rules: deps.store.listProjects().flatMap((project) => deps.store.listProjectRules(project.id, 10)),
        })
      );
      return;
    }
    sendHtml(res, renderResearchPage(deps.store));
  });

  router.post(
    "/research",
    asyncRoute(async (req, res) => {
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
      const sources = chunks.map((chunk) => ({
        path: chunk.path,
        score: chunk.score,
        excerpt: chunk.content.split("\n").slice(0, 4).join("\n"),
      }));
      const contradictions = lessons
        .filter((lesson) => /but|however|contradict|instead/i.test(lesson.body))
        .map((lesson) => lesson.title)
        .slice(0, 5);
      const result = {
        summary: [
          `Topic: ${topic}`,
          `Mode: ${mode}`,
          "",
          `Found ${chunks.length} local sources and ${lessons.length} lessons.`,
          mode === "web" ? "Web research is not wired yet, so this result is local-first only." : "",
          "",
          ...sources.slice(0, 3).map((source) => `- ${source.path} (score ${source.score.toFixed(1)})`),
        ]
          .filter(Boolean)
          .join("\n"),
        sources,
        contradictions,
        brief: [
          `Research brief for ${topic}.`,
          "Use the highest-scoring local sources first.",
          contradictions.length > 0
            ? `Watch for contradictions in: ${contradictions.join(", ")}.`
            : "No obvious contradictions detected in current lessons.",
          `Top sources: ${
            sources
              .slice(0, 3)
              .map((source) => source.path)
              .join(", ") || "none"
          }.`,
        ].join("\n"),
      };
      if (isHtmlRequest(req)) {
        sendHtml(res, renderResearchPage(deps.store, { projectId, topic, mode, result }));
        return;
      }
      sendJson(res, json("ok", { projectId, topic, mode, ...result }));
    })
  );

  router.get("/planner", (req, res) => {
    if (!isHtmlRequest(req)) {
      sendJson(
        res,
        json("ok", {
          tasks: deps.store.listRecentTasks(40),
          projects: deps.store.listProjects(),
          recentSessions: deps.store.listSessions(20).filter((session) => session.mode === "plan"),
          activeSessionCount: deps.store.dashboardSnapshot().activeSessions,
        })
      );
      return;
    }
    sendHtml(res, renderPlannerPage(deps.store));
  });

  router.post(
    "/plan",
    asyncRoute(async (req, res) => {
      const body = (
        req.headers["content-type"]?.includes("application/json")
          ? await readJsonBody(req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(req)))
      ) as Record<string, unknown>;
      const normalized: PlanRequest = {
        project: String(body.project ?? ""),
        goal: String(body.goal ?? ""),
        sessionId: typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : null,
        risk: body.risk === "low" || body.risk === "medium" || body.risk === "high" ? body.risk : "medium",
      };
      const planSession = normalized.sessionId ? deps.store.getSession(normalized.sessionId) : null;
      if (normalized.sessionId && !planSession) {
        sendJson(res, json("error", undefined, { message: "session not found" }), 404);
        return;
      }
      if (planSession && planSession.projectId !== normalized.project) {
        sendJson(res, json("error", undefined, { message: "session belongs to a different project" }), 409);
        return;
      }
      const result = await deps.store.createPlan(normalized);
      if (isHtmlRequest(req)) {
        sendHtml(res, renderPlannerPage(deps.store, { result: result.response }));
        return;
      }
      sendJson(res, json("ok", result.response));
    })
  );

  router.get("/handoff", (req, res) => {
    if (!isHtmlRequest(req)) {
      sendJson(
        res,
        json("ok", {
          projects: deps.store.listProjects(),
          sessions: deps.store.listSessions(20),
          handoffs: deps.store.listHandoffs(undefined, 20),
        })
      );
      return;
    }
    sendHtml(res, renderHandoffPage(deps.store));
  });

  router.post(
    "/handoff",
    asyncRoute(async (req, res) => {
      const body = (
        req.headers["content-type"]?.includes("application/json")
          ? await readJsonBody(req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(req)))
      ) as Record<string, unknown>;
      const normalized: HandoffRequest = {
        sessionId: String(body.sessionId ?? ""),
        project: String(body.project ?? ""),
        target:
          body.target === "opencode" ||
          body.target === "codex" ||
          body.target === "manual" ||
          body.target === "clipboard" ||
          body.target === "file"
            ? body.target
            : "manual",
        subtask: String(body.subtask ?? ""),
      };
      const result = await deps.store.createHandoff(normalized);
      if (isHtmlRequest(req)) {
        sendHtml(res, renderHandoffPage(deps.store, { result }));
        return;
      }
      sendJson(res, json("ok", result));
    })
  );

  router.get("/checks", (req, res) => {
    if (!isHtmlRequest(req)) {
      sendJson(res, json("ok", deps.store.listCheckRuns(20)));
      return;
    }
    sendHtml(res, renderChecksPage(deps.store));
  });

  // POST /checks/run — backward-compatible alias for /checks/record.
  // POST /checks/record — records a check result without executing it.
  // Real check execution lives inside dev-run workflows.
  for (const path of ["/checks/run", "/checks/record"]) {
    router.post(
      path,
      asyncRoute(async (req, res) => {
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
          deps.store.appendEvent(
            createEvent("tool.blocked", { tool: name, reason: "check not allowlisted" }, { projectId, agent: "checks" })
          );
        } else {
          deps.store.appendEvent(createEvent("check.completed", { name }, { projectId, agent: "checks" }));
        }
        if (isHtmlRequest(req)) {
          sendHtml(res, renderChecksPage(deps.store));
          return;
        }
        sendJson(res, json("ok", check));
      })
    );
  }

  // POST /checks/execute — runs a check in the project's actual directory via
  // execution-engine.runAllowedChecks(). Requires projectId.
  router.post(
    "/checks/execute",
    asyncRoute(async (req, res) => {
      const body = (
        req.headers["content-type"]?.includes("application/json")
          ? await readJsonBody(req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(req)))
      ) as Record<string, unknown>;
      const name = String(body.name ?? "");
      const projectId = body.projectId ? String(body.projectId) : null;

      if (!projectId) {
        sendJson(res, json("error", undefined, { message: "projectId is required for /checks/execute" }), 400);
        return;
      }

      const project = deps.store.listProjects().find((p) => p.id === projectId);
      if (!project) {
        sendJson(res, json("error", undefined, { message: `project ${projectId} not found` }), 404);
        return;
      }

      const projectConfig = readProjectChecksConfig(resolveProjectConfig(project.path).raw);

      const results = await runAllowedChecks({
        cwd: project.path,
        commandNames: [name],
        projectConfig,
        timeoutMs: 10 * 60_000,
      });

      const result = results[0];
      const check = deps.store.createCheckRun({
        name,
        projectId,
        status: result?.status === "cancelled" ? "failed" : (result?.status ?? "blocked"),
        command: result?.command ?? name,
        output: result?.stdout ?? null,
        errorOutput: result?.stderr ?? null,
        exitCode: result?.exitCode ?? null,
        durationMs: result?.durationMs ?? null,
        parsedErrors: result?.parsedErrors ?? [],
        affectedFiles: result?.affectedFiles ?? [],
        startedAt: result?.startedAt ?? new Date().toISOString(),
        finishedAt: result?.finishedAt ?? new Date().toISOString(),
      });

      const checkEvent = createEvent(
        result?.status === "blocked"
          ? "tool.blocked"
          : result?.status === "completed"
            ? "check.completed"
            : "check.failed",
        { name, status: result?.status ?? "blocked", checkId: check.id },
        {
          projectId,
          agent: "checks",
          sourceService: "workbench-api",
          level: result?.status === "completed" ? "info" : "error",
          summary: result?.status === "completed" ? `${name} passed` : `${name} ${result?.status ?? "blocked"}`,
          correlationId: check.id,
        }
      );
      deps.store.appendEvent(checkEvent);
      deps.publish(checkEvent);

      if (isHtmlRequest(req)) {
        sendHtml(res, renderChecksPage(deps.store));
        return;
      }
      sendJson(res, json("ok", check));
    })
  );

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

  router.post(
    "/reviews",
    asyncRoute(async (req, res) => {
      const body = (
        req.headers["content-type"]?.includes("application/json")
          ? await readJsonBody(req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(req)))
      ) as Record<string, unknown>;
      const result = deps.store.createReview({
        project: String(body.project ?? ""),
        sessionId: body.sessionId ? String(body.sessionId) : null,
        title: body.title ? String(body.title) : undefined,
        plannedFiles: String(body.plannedFiles ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
        editedFiles: String(body.editedFiles ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
        checks: String(body.checks ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
        notes: body.notes ? String(body.notes) : undefined,
      });
      const job = deps.store.enqueueJob({ type: "review.reflect", payload: { reviewId: result.id, source: "api" } });
      if (isHtmlRequest(req)) {
        sendHtml(res, renderReviewsPage(deps.store, { result }));
        return;
      }
      sendJson(res, json("ok", { result, jobId: job.id }));
    })
  );

  router.get("/handoffs/:handoffId", (req, res) => {
    const handoffId = decodeURIComponent(String(req.params.handoffId ?? ""));
    const handoff = deps.store.listHandoffs(undefined, 100).find((item) => item.id === handoffId) ?? null;
    if (!handoff) {
      sendJson(res, json("error", undefined, { message: "handoff not found" }), 404);
      return;
    }
    sendJson(res, json("ok", handoff));
  });

  router.post(
    "/dev/run",
    asyncRoute(async (req, res) => {
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
      const requestedSessionId =
        typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : null;
      const existingSession = requestedSessionId ? deps.store.getSession(requestedSessionId) : null;
      if (requestedSessionId && !existingSession) {
        sendJson(res, json("error", undefined, { message: "session not found" }), 404);
        return;
      }
      if (existingSession && existingSession.projectId !== project.id) {
        sendJson(res, json("error", undefined, { message: "session belongs to a different project" }), 409);
        return;
      }
      const session = existingSession
        ? deps.store.updateSession(existingSession.id, {
            status: "running",
            finishedAt: null,
            durationMs: null,
            errorMessage: null,
            modelProfile: "dev-editor-local",
          })
        : deps.store.createSession({
            projectId: project.id,
            title: devRequest.goal.slice(0, 80),
            userGoal: devRequest.goal,
            mode: "dev",
            source: "api",
            modelProfile: "dev-editor-local",
          });
      await deps.store.ensureRuntimeDirs(deps.config.runtimeDir);
      let previousExecutionEventId: string | null = null;
      const result = await runDevWorkflow({
        request: devRequest,
        project: {
          id: project.id,
          name: project.name,
          path: project.path,
          config: resolveProjectConfig(project.path).raw,
        },
        runtime: {
          devRuns: deps.store.dev,
          execution: deps.store.execution,
          retrieval: deps.store.retrieval,
          models: deps.store.models,
          conversation: deps.store.conversation,
          modelRuntime: createModelRuntime({
            providers: deps.store.models.listProviders().map((provider) => ({
              id: provider.id,
              kind: provider.kind,
              displayName: provider.displayName,
              baseUrl: provider.baseUrl,
              apiKeyEnv: provider.apiKeyEnv,
              enabled: provider.enabled,
            })),
            profiles: deps.store.models.listProfiles(),
            cloudEnabled: deps.config.cloudEnabled,
          }),
        },
        runtimeDir: deps.config.runtimeDir,
        sessionId: session.id,
        source: "api",
        emit: (executionEvent) => {
          const event = createEvent(executionEvent.kind, executionEvent.data, {
            id: executionEvent.id,
            sessionId: executionEvent.sessionId,
            projectId: executionEvent.projectId,
            runId: executionEvent.runId,
            agent: "dev-runner",
            sourceService: "workbench-api",
            level: executionEvent.level,
            summary: executionEvent.message,
            correlationId: executionEvent.runId,
            causationId: previousExecutionEventId,
            ts: executionEvent.ts,
          });
          deps.store.appendEvent(event);
          deps.publish(event);
          previousExecutionEventId = event.id;
        },
      });
      sendJson(res, json("ok", result.result));
    })
  );

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
    sendJson(
      res,
      json("ok", {
        run,
        workspace: deps.store.execution.getWorkspaceForRun(run.id),
        approvals: deps.store.execution.listApprovals(run.id),
        patches: deps.store.execution.listPatches(run.id),
      })
    );
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

  router.get("/approvals/:approvalId", (req, res) => {
    const approvalId = decodeURIComponent(String(req.params.approvalId ?? ""));
    const approval = deps.store.execution.getApproval(approvalId);
    if (approval) {
      const run = deps.store.dev.getRun(approval.runId);
      sendJson(res, json("ok", { kind: "development", approval, run, execution: null }));
      return;
    }
    const workflowApproval = deps.store.workflows.getApproval(approvalId);
    if (workflowApproval) {
      sendJson(
        res,
        json("ok", {
          kind: "workflow",
          approval: workflowApproval,
          run: null,
          execution: deps.store.workflows.get(workflowApproval.executionId),
        })
      );
      return;
    }
    sendJson(res, json("error", undefined, { message: "approval not found" }), 404);
  });

  router.post(
    "/dev/runs/:runId/approve",
    asyncRoute(async (req, res) => {
      const runId = decodeURIComponent(String(req.params.runId ?? ""));
      const body = req.headers["content-type"]?.includes("application/json")
        ? ((await readJsonBody(req)) as Record<string, unknown> | null)
        : {};
      const approval = await approveDevRun({
        runId,
        runtime: { devRuns: deps.store.dev, execution: deps.store.execution },
        decidedBy: typeof body?.decidedBy === "string" ? body.decidedBy : "api",
        notes: typeof body?.notes === "string" ? body.notes : undefined,
      });
      if (approval.ok && approval.run) {
        const approvalRecord = deps.store.execution.listApprovals(approval.run.id).at(-1) ?? null;
        const event = createEvent(
          "approval.granted",
          {
            approvalId: approvalRecord?.id ?? null,
            decidedBy: typeof body?.decidedBy === "string" ? body.decidedBy : "api",
          },
          {
            sessionId: approval.run.sessionId,
            projectId: approval.run.projectId,
            runId: approval.run.id,
            agent: "approvals",
            sourceService: "workbench-api",
            summary: "Development run approved",
            correlationId: approval.run.id,
          }
        );
        deps.store.appendEvent(event);
        deps.publish(event);
      }
      sendJson(
        res,
        approval.ok
          ? json("ok", approval.run)
          : json("error", undefined, { message: approval.error ?? "approval failed" }),
        approval.ok ? 200 : 400
      );
    })
  );

  router.post(
    "/dev/runs/:runId/apply",
    asyncRoute(async (req, res) => {
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
      const outcome = await applyApprovedDevRun({
        runId,
        projectPath: project.path,
        runtime: { devRuns: deps.store.dev, execution: deps.store.execution },
      });
      if (outcome.ok && outcome.run) {
        const event = createEvent(
          "run.completed",
          { appliedFiles: outcome.applied },
          {
            sessionId: outcome.run.sessionId,
            projectId: outcome.run.projectId,
            runId: outcome.run.id,
            agent: "dev-runner",
            sourceService: "workbench-api",
            summary: outcome.run.summary,
            correlationId: outcome.run.id,
          }
        );
        deps.store.appendEvent(event);
        deps.publish(event);
      }
      sendJson(
        res,
        outcome.ok
          ? json("ok", { run: outcome.run, applied: outcome.applied })
          : json("error", undefined, { message: outcome.error ?? "apply failed" }),
        outcome.ok ? 200 : 400
      );
    })
  );

  router.post(
    "/dev/runs/:runId/cancel",
    asyncRoute(async (req, res) => {
      const runId = decodeURIComponent(String(req.params.runId ?? ""));
      const body = req.headers["content-type"]?.includes("application/json")
        ? ((await readJsonBody(req)) as Record<string, unknown> | null)
        : {};
      const outcome = await cancelDevRun({
        runId,
        runtime: { devRuns: deps.store.dev, execution: deps.store.execution },
        reason: typeof body?.reason === "string" ? body.reason : undefined,
      });
      if (outcome.ok && outcome.run) {
        const event = createEvent(
          "run.cancelled",
          { reason: typeof body?.reason === "string" ? body.reason : null },
          {
            sessionId: outcome.run.sessionId,
            projectId: outcome.run.projectId,
            runId: outcome.run.id,
            agent: "dev-runner",
            sourceService: "workbench-api",
            summary: outcome.run.summary,
            correlationId: outcome.run.id,
          }
        );
        deps.store.appendEvent(event);
        deps.publish(event);
      }
      sendJson(
        res,
        outcome.ok ? json("ok", outcome.run) : json("error", undefined, { message: outcome.error ?? "cancel failed" }),
        outcome.ok ? 200 : 400
      );
    })
  );
}
