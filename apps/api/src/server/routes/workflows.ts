import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import * as path from "node:path";
import type { Router } from "express";
import { parseDevRequest } from "../../../../../packages/agent-protocol/src/dev.ts";
import { resolveProjectConfig } from "../../../../../packages/config/src/index.ts";
import {
  CONTROL_PLANE_SCHEMA_VERSION,
  type WorkflowExecution,
  type WorkflowLaunch,
} from "../../../../../packages/contracts/src/index.ts";
import type { createStore } from "../../../../../packages/db/src/store.ts";
import {
  applyApprovedDevRun,
  approveDevRun,
  cancelDevRun,
  runDevWorkflow,
} from "../../../../../packages/dev-agent/src/index.ts";
import {
  createTaskWorkspace,
  readProjectChecksConfig,
  runAllowedChecks,
} from "../../../../../packages/execution-engine/src/index.ts";
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
    state: "running" | "waiting" | "ready";
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
      currentStepId: input.state === "waiting" ? "approval" : "command",
      stepStates:
        input.state === "running"
          ? { command: "running" }
          : input.state === "ready"
            ? { command: "ready" }
            : { approval: "waiting", command: "waiting" },
      startedAt: input.state === "running" ? timestamp : null,
      finishedAt: null,
      approvalId: null,
      exitCode: null,
      artifacts: [],
      errorCode: null,
      errorSummary: null,
    };
  }

  function createWorkflowLaunch(input: {
    execution: WorkflowExecution;
    command: { executable: string; arguments: string[]; workingDirectory: string };
    mode: "terminal" | "tmux";
    tmuxSession: string | null;
    state: "waiting" | "ready";
  }) {
    const timestamp = new Date().toISOString();
    const environment = Object.fromEntries(
      Object.entries({
        AI_WORKBENCH_PROJECT_ID: input.execution.projectId,
        AI_WORKBENCH_SESSION_ID: input.execution.sessionId,
        AI_WORKBENCH_TASK_ID: input.execution.taskId,
        AI_WORKBENCH_EXECUTION_ID: input.execution.id,
      }).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
    );
    const launch: WorkflowLaunch = {
      schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
      id: createId("workflow_launch"),
      createdAt: timestamp,
      updatedAt: timestamp,
      origin: { source: "workbench", instanceId: "workbench-api", legacyRef: null },
      capabilities: [input.mode],
      executionId: input.execution.id,
      projectId: input.execution.projectId,
      sessionId: input.execution.sessionId,
      taskId: input.execution.taskId,
      mode: input.mode,
      state: input.state,
      command: input.command,
      environment,
      tmuxSession: input.mode === "tmux" ? input.tmuxSession : null,
      authorizationExpiresAt: null,
      launcherInstanceId: null,
      launcherPid: null,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
    };
    return deps.store.workflows.saveLaunch({ launch, tokenHash: null });
  }

  function markLaunchReady(executionId: string) {
    const record = deps.store.workflows.getLaunchForExecution(executionId);
    if (record?.launch.state !== "waiting") return null;
    const updatedAt = new Date().toISOString();
    return deps.store.workflows.transitionLaunch({
      expectedState: "waiting",
      record: { ...record, launch: { ...record.launch, state: "ready", updatedAt } },
    });
  }

  function launchTokenHash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  function launchTokenMatches(expectedHash: string | null, token: string): boolean {
    if (!expectedHash || !token) return false;
    const actual = new TextEncoder().encode(launchTokenHash(token));
    const expected = new TextEncoder().encode(expectedHash);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  function publicLaunch(record: ReturnType<Store["workflows"]["getLaunch"]>) {
    return record?.launch ?? null;
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
      stepStates: { ...(record.execution.approvalId ? { approval: "cancelled" } : {}), command: "cancelled" },
      finishedAt: timestamp,
      errorCode,
      errorSummary,
    };
    const saved = deps.store.workflows.save({ ...record, execution });
    const launch = deps.store.workflows.getLaunchForExecution(execution.id);
    if (launch && (launch.launch.state === "waiting" || launch.launch.state === "ready")) {
      deps.store.workflows.transitionLaunch({
        expectedState: launch.launch.state,
        record: {
          tokenHash: null,
          launch: {
            ...launch.launch,
            state: "cancelled",
            updatedAt: timestamp,
            authorizationExpiresAt: null,
            finishedAt: timestamp,
          },
        },
      });
    }
    return saved;
  }

  function makeInteractiveWorkflowReady(
    record: NonNullable<ReturnType<Store["workflows"]["get"]>>,
    commandName: string,
    causationId: string | null = null
  ) {
    const timestamp = new Date().toISOString();
    const execution: WorkflowExecution = {
      ...record.execution,
      updatedAt: timestamp,
      state: "ready",
      currentStepId: "command",
      stepStates: { ...(record.execution.approvalId ? { approval: "completed" } : {}), command: "ready" },
      startedAt: null,
      finishedAt: null,
      errorCode: null,
      errorSummary: null,
    };
    const saved = deps.store.workflows.save({ ...record, execution });
    const launch = markLaunchReady(execution.id) ?? deps.store.workflows.getLaunchForExecution(execution.id);
    if (launch?.launch.state !== "ready") throw new Error("interactive workflow launch is unavailable");
    const event = createEvent(
      "workflow.launch_ready",
      { workflowId: execution.workflowId, executionId: execution.id, launchId: launch.launch.id },
      {
        projectId: execution.projectId,
        sessionId: execution.sessionId,
        taskId: execution.taskId,
        agent: "workflow-executor",
        sourceService: "workbench-api",
        summary: `${commandName} is ready to launch in ${launch.launch.mode}`,
        correlationId: execution.id,
        causationId,
      }
    );
    deps.store.appendEvent(event);
    deps.publish(event);
    return { ...saved, launch: launch.launch };
  }

  async function executePreparedWorkflow(
    prepared: Awaited<ReturnType<typeof prepareManifestWorkflow>> & { ok: true },
    existing: WorkflowExecution,
    causationId: string | null = null
  ) {
    let runnable = prepared.workflow;
    let artifacts = [...existing.artifacts];
    try {
      if (prepared.workflow.command.executionMode === "isolated") {
        const project = deps.store.getProject(existing.projectId);
        if (!project) throw new Error(`project ${existing.projectId} not found for isolated workflow`);
        const relativeCwd = path.relative(project.path, prepared.workflow.cwd);
        if (relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd)) {
          throw new Error("isolated workflow working directory must be inside the canonical project root");
        }
        const created = await createTaskWorkspace({
          projectPath: project.path,
          runtimeDir: deps.config.runtimeDir,
          runId: existing.id,
          sessionId: existing.sessionId ?? existing.id,
        });
        runnable = { ...prepared.workflow, cwd: path.resolve(created.workspace.path, relativeCwd) };
        artifacts = [created.workspace.path];
      }
    } catch (error) {
      const timestamp = new Date().toISOString();
      const execution: WorkflowExecution = {
        ...existing,
        state: "failed",
        updatedAt: timestamp,
        currentStepId: null,
        stepStates: { ...(existing.approvalId ? { approval: "completed" } : {}), command: "failed" },
        finishedAt: timestamp,
        errorCode: "workspace_setup_failed",
        errorSummary: error instanceof Error ? error.message : String(error),
      };
      const saved = deps.store.workflows.save({
        execution,
        command: commandRecord(prepared.workflow),
        stdout: "",
        stderr: execution.errorSummary ?? "",
        durationMs: 0,
      });
      const event = createEvent(
        "workflow.failed",
        { workflowId: execution.workflowId, executionId: execution.id, code: execution.errorCode },
        {
          projectId: execution.projectId,
          sessionId: execution.sessionId,
          taskId: execution.taskId,
          agent: "workflow-executor",
          sourceService: "workbench-api",
          level: "error",
          summary: execution.errorSummary ?? "Isolated workspace setup failed",
          correlationId: execution.id,
          causationId,
        }
      );
      deps.store.appendEvent(event);
      deps.publish(event);
      return saved;
    }
    const startedAt = new Date().toISOString();
    const running: WorkflowExecution = {
      ...existing,
      updatedAt: startedAt,
      state: "running",
      currentStepId: "command",
      stepStates: { ...(existing.approvalId ? { approval: "completed" } : {}), command: "running" },
      startedAt,
      finishedAt: null,
      artifacts,
      errorCode: null,
      errorSummary: null,
    };
    deps.store.workflows.save({
      execution: running,
      command: commandRecord(runnable),
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
      result = await runPreparedManifestWorkflow(runnable, { signal: controller.signal });
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
      command: commandRecord(runnable),
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
    sendJson(
      res,
      json("ok", {
        ...execution,
        approval: deps.store.workflows.getApprovalForExecution(executionId),
        launch: publicLaunch(deps.store.workflows.getLaunchForExecution(executionId)),
      })
    );
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
      const prepared = await prepareManifestWorkflow(manifest, record.execution.workflowId, {
        allowMutating: true,
        allowInteractive: true,
      });
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
      if (["terminal", "tmux"].includes(prepared.workflow.command.executionMode)) {
        const saved = makeInteractiveWorkflowReady(record, prepared.workflow.command.name, granted.id);
        sendJson(res, json("ok", { ...saved, approval: decided }), 202);
        return;
      }
      const saved = await executePreparedWorkflow(prepared, record.execution, granted.id);
      sendJson(res, json("ok", { ...saved, approval: decided }), saved.execution.state === "completed" ? 200 : 422);
    })
  );

  router.post(
    "/actions/executions/:executionId/launch/authorize",
    asyncRoute(async (req, res) => {
      const executionId = decodeURIComponent(String(req.params.executionId ?? ""));
      const execution = deps.store.workflows.get(executionId);
      const launchRecord = deps.store.workflows.getLaunchForExecution(executionId);
      if (!execution || !launchRecord) {
        sendJson(res, json("error", undefined, { message: "interactive workflow execution not found" }), 404);
        return;
      }
      if (execution.execution.state !== "ready" || launchRecord.launch.state !== "ready") {
        sendJson(res, json("error", undefined, { message: "interactive workflow is not ready to launch" }), 409);
        return;
      }
      const token = `${randomUUID()}${randomUUID()}`;
      const timestamp = new Date().toISOString();
      const authorizationExpiresAt = new Date(Date.now() + 2 * 60_000).toISOString();
      const authorized = deps.store.workflows.transitionLaunch({
        expectedState: "ready",
        record: {
          launch: { ...launchRecord.launch, updatedAt: timestamp, authorizationExpiresAt },
          tokenHash: launchTokenHash(token),
        },
      });
      sendJson(res, json("ok", { launch: authorized.launch, token }));
    })
  );

  router.post(
    "/actions/executions/:executionId/launch/start",
    asyncRoute(async (req, res) => {
      const executionId = decodeURIComponent(String(req.params.executionId ?? ""));
      const executionRecord = deps.store.workflows.get(executionId);
      const launchRecord = deps.store.workflows.getLaunchForExecution(executionId);
      if (!executionRecord || !launchRecord) {
        sendJson(res, json("error", undefined, { message: "interactive workflow execution not found" }), 404);
        return;
      }
      const body = (await readJsonBody(req)) as { token?: unknown; launcherInstanceId?: unknown; pid?: unknown };
      const token = typeof body.token === "string" ? body.token : "";
      const launcherInstanceId =
        typeof body.launcherInstanceId === "string" && body.launcherInstanceId.trim()
          ? body.launcherInstanceId.trim()
          : null;
      const pid = typeof body.pid === "number" && Number.isInteger(body.pid) && body.pid > 0 ? body.pid : null;
      if (!launcherInstanceId || !pid) {
        sendJson(res, json("error", undefined, { message: "launcherInstanceId and positive pid are required" }), 400);
        return;
      }
      if (
        executionRecord.execution.state !== "ready" ||
        launchRecord.launch.state !== "ready" ||
        !launchRecord.launch.authorizationExpiresAt ||
        Date.parse(launchRecord.launch.authorizationExpiresAt) <= Date.now() ||
        !launchTokenMatches(launchRecord.tokenHash, token)
      ) {
        sendJson(
          res,
          json("error", undefined, { message: "launch authorization is invalid, expired, or replayed" }),
          409
        );
        return;
      }
      const timestamp = new Date().toISOString();
      const launch = deps.store.workflows.transitionLaunch({
        expectedState: "ready",
        expectedTokenHash: launchRecord.tokenHash,
        record: {
          ...launchRecord,
          launch: {
            ...launchRecord.launch,
            updatedAt: timestamp,
            state: "running",
            launcherInstanceId,
            launcherPid: pid,
            startedAt: timestamp,
          },
        },
      });
      const execution: WorkflowExecution = {
        ...executionRecord.execution,
        updatedAt: timestamp,
        state: "running",
        currentStepId: "command",
        stepStates: {
          ...(executionRecord.execution.approvalId ? { approval: "completed" } : {}),
          command: "running",
        },
        startedAt: timestamp,
      };
      const saved = deps.store.workflows.save({ ...executionRecord, execution });
      const event = createEvent(
        "workflow.started",
        { workflowId: execution.workflowId, executionId, launchId: launch.launch.id, mode: launch.launch.mode },
        {
          projectId: execution.projectId,
          sessionId: execution.sessionId,
          taskId: execution.taskId,
          agent: "desktop-workflow-launcher",
          sourceService: "workbench-api",
          summary: `Workflow ${execution.workflowId} launched in ${launch.launch.mode}`,
          correlationId: executionId,
        }
      );
      deps.store.appendEvent(event);
      deps.publish(event);
      sendJson(res, json("ok", { ...saved, launch: launch.launch }));
    })
  );

  router.post(
    "/actions/executions/:executionId/launch/complete",
    asyncRoute(async (req, res) => {
      const executionId = decodeURIComponent(String(req.params.executionId ?? ""));
      const executionRecord = deps.store.workflows.get(executionId);
      const launchRecord = deps.store.workflows.getLaunchForExecution(executionId);
      if (!executionRecord || !launchRecord) {
        sendJson(res, json("error", undefined, { message: "interactive workflow execution not found" }), 404);
        return;
      }
      const body = (await readJsonBody(req)) as { token?: unknown; exitCode?: unknown; cancelled?: unknown };
      const token = typeof body.token === "string" ? body.token : "";
      const exitCode = typeof body.exitCode === "number" && Number.isInteger(body.exitCode) ? body.exitCode : null;
      if (launchRecord.launch.state !== "running" || !launchTokenMatches(launchRecord.tokenHash, token)) {
        sendJson(
          res,
          json("error", undefined, { message: "launch completion authorization is invalid or replayed" }),
          409
        );
        return;
      }
      const state = body.cancelled === true ? "cancelled" : exitCode === 0 ? "completed" : "failed";
      const timestamp = new Date().toISOString();
      const launch = deps.store.workflows.transitionLaunch({
        expectedState: "running",
        expectedTokenHash: launchRecord.tokenHash,
        record: {
          tokenHash: null,
          launch: {
            ...launchRecord.launch,
            updatedAt: timestamp,
            state,
            authorizationExpiresAt: null,
            finishedAt: timestamp,
            exitCode,
          },
        },
      });
      const execution: WorkflowExecution = {
        ...executionRecord.execution,
        updatedAt: timestamp,
        state,
        currentStepId: null,
        stepStates: {
          ...(executionRecord.execution.approvalId ? { approval: "completed" } : {}),
          command: state,
        },
        finishedAt: timestamp,
        exitCode,
        errorCode:
          state === "failed" ? "interactive_command_failed" : state === "cancelled" ? "command_cancelled" : null,
        errorSummary:
          state === "failed"
            ? `Interactive command exited with ${exitCode ?? "unknown status"}`
            : state === "cancelled"
              ? "Interactive command was cancelled"
              : null,
      };
      const saved = deps.store.workflows.save({ ...executionRecord, execution });
      const event = createEvent(
        state === "completed" ? "workflow.completed" : state === "cancelled" ? "workflow.cancelled" : "workflow.failed",
        { workflowId: execution.workflowId, executionId, launchId: launch.launch.id, exitCode },
        {
          projectId: execution.projectId,
          sessionId: execution.sessionId,
          taskId: execution.taskId,
          agent: "desktop-workflow-launcher",
          sourceService: "workbench-api",
          level: state === "completed" ? "info" : state === "cancelled" ? "warn" : "error",
          summary: `Interactive workflow ${execution.workflowId} ${state}`,
          correlationId: executionId,
        }
      );
      deps.store.appendEvent(event);
      deps.publish(event);
      sendJson(res, json("ok", { ...saved, launch: launch.launch }));
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
      const launch = deps.store.workflows.getLaunchForExecution(executionId);
      const pid = launch?.launch.state === "running" ? launch.launch.launcherPid : null;
      if (pid) {
        try {
          process.kill(-pid, "SIGTERM");
          const forceKill = setTimeout(() => {
            try {
              process.kill(-pid, "SIGKILL");
            } catch {
              // The desktop process group completed before escalation.
            }
          }, 2_000);
          forceKill.unref?.();
          sendJson(res, json("ok", { executionId, state: "cancelling" }), 202);
          return;
        } catch {
          sendJson(res, json("error", undefined, { message: "desktop workflow process is no longer available" }), 409);
          return;
        }
      }
    }
    if (record.execution.state === "ready") {
      const saved = cancelWaitingWorkflow(record, "launch_cancelled", "Interactive workflow launch was cancelled");
      const event = createEvent(
        "workflow.cancelled",
        { workflowId: saved.execution.workflowId, executionId, beforeLaunch: true },
        {
          projectId: saved.execution.projectId,
          sessionId: saved.execution.sessionId,
          taskId: saved.execution.taskId,
          agent: "workflow-executor",
          sourceService: "workbench-api",
          level: "warn",
          summary: `Workflow ${saved.execution.workflowId} cancelled before launch`,
          correlationId: executionId,
        }
      );
      deps.store.appendEvent(event);
      deps.publish(event);
      sendJson(
        res,
        json("ok", { ...saved, launch: publicLaunch(deps.store.workflows.getLaunchForExecution(executionId)) })
      );
      return;
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
      const body = (await readJsonBody(req)) as {
        projectId?: unknown;
        sessionId?: unknown;
        taskId?: unknown;
        executionMode?: unknown;
      };
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
      const requestedMode =
        body.executionMode === "terminal" || body.executionMode === "tmux" ? body.executionMode : null;
      if (body.executionMode !== undefined && !requestedMode) {
        sendJson(res, json("error", undefined, { message: "executionMode must be terminal or tmux" }), 400);
        return;
      }
      const prepared = await prepareManifestWorkflow(manifest, workflowId, {
        allowMutating: true,
        allowInteractive: true,
      });
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

      const desktopLaunch = ["terminal", "tmux"].includes(prepared.workflow.command.executionMode);
      const launchMode = requestedMode ?? (prepared.workflow.command.executionMode === "tmux" ? "tmux" : "terminal");
      if (desktopLaunch && launchMode === "tmux" && !manifest.desktop.tmuxSession) {
        sendJson(
          res,
          json("error", undefined, { message: "workflow requested tmux but the manifest has no tmux session" }),
          409
        );
        return;
      }
      if (!desktopLaunch && requestedMode) {
        sendJson(
          res,
          json("error", undefined, { message: "executionMode override is valid only for terminal/tmux workflows" }),
          409
        );
        return;
      }
      const initial = createWorkflowExecution({
        workflowId: prepared.workflow.workflowId,
        projectId,
        sessionId,
        taskId,
        state: prepared.workflow.command.mutation !== "read_only" ? "waiting" : desktopLaunch ? "ready" : "running",
      });
      if (desktopLaunch) {
        deps.store.workflows.save({
          execution: initial,
          command: commandRecord(prepared.workflow),
          stdout: "",
          stderr: "",
          durationMs: 0,
        });
        createWorkflowLaunch({
          execution: initial,
          command: commandRecord(prepared.workflow),
          mode: launchMode,
          tmuxSession: manifest.desktop.tmuxSession,
          state: initial.state === "waiting" ? "waiting" : "ready",
        });
      }
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
          json("ok", {
            ...saved,
            approval,
            launch: publicLaunch(deps.store.workflows.getLaunchForExecution(waiting.id)),
            deepLink: `/approvals/${encodeURIComponent(approval.id)}`,
          }),
          202
        );
        return;
      }
      if (desktopLaunch) {
        const record = deps.store.workflows.get(initial.id);
        if (!record) throw new Error("interactive workflow execution was not persisted");
        sendJson(res, json("ok", makeInteractiveWorkflowReady(record, prepared.workflow.command.name)), 202);
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
