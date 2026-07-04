// Local dev agent pipeline.
//
// The dev agent wires the workbench's retrieval, model runtime, and
// execution engine into a single safe coding loop:
//
//   goal -> context -> plan -> safe workspace -> edit -> check
//        -> repair -> diff -> approval -> apply
//
// Every step writes to SQLite (dev_runs, dev_edits, execution_* tables)
// and emits typed events. The original project is never mutated during
// planning or repair: edits only land in the workspace copy, and the
// final patch is applied only when the user explicitly approves the run.

import { existsSync } from "node:fs";
import { type ExecutionEvent, parseDevRequest } from "../../agent-protocol/src/dev.ts";
import type { ConversationRepo } from "../../db/src/repositories/conversation.ts";
import type { DevRunsRepo, DevRunUpdateInput } from "../../db/src/repositories/dev-runs.ts";
import type { ExecutionRepo, ExecutionWorkspaceRecord } from "../../db/src/repositories/execution.ts";
import type { ModelsRepo } from "../../db/src/repositories/models.ts";
import type { RetrievalRepo } from "../../db/src/repositories/retrieval.ts";
import {
  applyEdit as applyEditToFs,
  applyWorkspaceToOriginal,
  collectDiff as collectWorkspaceDiff,
  createTaskWorkspace,
  describeWorkspaceForLog,
  guardPath,
  isHighRiskPath,
  isSecretFile,
  type ProjectChecksConfig,
  readProjectChecksConfig,
  readProjectFile,
  riskForPath,
  runAllowedChecks,
} from "../../execution-engine/src/index.ts";
import type { ModelRuntime } from "../../model-runtime/src/index.ts";
import type {
  DevEdit,
  DevPlan,
  DevRequest,
  DevResult,
  DevRun,
  DevRunStatus,
  RetrievalQueryRecord,
  RetrievalResultRecord,
  RetrievalSelectedContextRecord,
  RiskLevel,
} from "../../shared/src/index.ts";
import { createId } from "../../shared/src/index.ts";
import { extractJsonFragment } from "../../shared/src/model-output.ts";

export interface RunDevWorkflowInput {
  request: DevRequest;
  project: { id: string; name: string; path: string; config?: Record<string, unknown> | null };
  runtime: {
    devRuns: DevRunsRepo;
    execution: ExecutionRepo;
    retrieval: RetrievalRepo;
    models: ModelsRepo;
    conversation: ConversationRepo;
    modelRuntime: ModelRuntime;
  };
  runtimeDir: string;
  sessionId: string;
  source?: string;
  emit?: (event: ExecutionEvent) => void;
}

export interface RunDevWorkflowResult {
  run: DevRun;
  result: DevResult;
}

const DEFAULT_CHECKS = ["typecheck"] as const;

function resolveChecks(input: RunDevWorkflowInput, projectConfig: ProjectChecksConfig): string[] {
  const requested =
    input.request.checks && input.request.checks.length > 0 ? input.request.checks : projectConfig.dev.defaultChecks;
  if (requested.length === 0) return [...DEFAULT_CHECKS];
  return Array.from(new Set(requested));
}

function highestRisk(levels: RiskLevel[]): RiskLevel {
  if (levels.includes("high")) return "high";
  if (levels.includes("medium")) return "medium";
  return "low";
}

function nextCommandFor(runId: string, status: DevRunStatus, applied: boolean): string {
  if (applied) return `ai dev show ${runId}`;
  if (status === "awaiting_approval") return `ai dev diff ${runId}  # then: ai dev approve ${runId}`;
  if (status === "completed" || status === "failed" || status === "cancelled") return `ai dev show ${runId}`;
  return `ai dev show ${runId}`;
}

function buildMissingContextPlan(reason: string): DevPlan {
  return {
    summary: "Insufficient context to safely plan edits.",
    edits: [],
    checks: [],
    risk: "low",
    missingContextReason: reason,
  };
}

function buildDevPrompt(input: {
  goal: string;
  projectName: string;
  retrieved: Array<{ path: string; content: string }>;
  hints: string[];
  riskHints: string[];
  rules: string[];
}): string {
  const context = input.retrieved.map((entry) => `FILE: ${entry.path}\n\`\`\`\n${entry.content}\n\`\`\``).join("\n\n");
  return [
    `You are the workbench dev editor. Plan the smallest possible set of edits for this goal.`,
    `Project: ${input.projectName}`,
    `Goal: ${input.goal}`,
    `Likely files: ${input.hints.join(", ") || "(none yet)"}`,
    `Risk reminders: ${input.riskHints.join("; ")}`,
    `Safety rules: ${input.rules.join("; ")}`,
    `Context (truncated):\n${context || "(no context)"}`,
    ``,
    `Output ONLY a JSON object with this exact shape:`,
    `{`,
    `  "summary": "string",`,
    `  "edits": [{ "path": "relative/path.ts", "reason": "string", "oldText": "exact text or omit", "newText": "replacement", "changeType": "replace|create|append" }],`,
    `  "checks": ["typecheck", "test"],`,
    `  "risk": "low|medium|high"`,
    `}`,
    `If you cannot make a safe plan, output \`{ "summary": "insufficient context", "edits": [], "checks": [], "risk": "low" }\`.`,
  ].join("\n");
}

function buildRepairPrompt(input: {
  goal: string;
  failedCheck: { name: string; stderr: string; stdout: string; exitCode: number | null };
  rules: string[];
}): string {
  return [
    `A check failed. Produce a minimal JSON repair patch.`,
    `Goal: ${input.goal}`,
    `Failed check: ${input.failedCheck.name} (exit=${input.failedCheck.exitCode ?? "n/a"})`,
    `Stderr (truncated):\n${input.failedCheck.stderr.slice(0, 2000)}`,
    `Stdout (truncated):\n${input.failedCheck.stdout.slice(0, 1000)}`,
    `Safety rules: ${input.rules.join("; ")}`,
    `Output ONLY the new edits as JSON using the same shape as the editor output.`,
  ].join("\n");
}

function parseModelPlan(text: string): DevPlan | null {
  const fragment = extractJsonFragment(text);
  if (!fragment) return null;
  try {
    const parsed = JSON.parse(fragment) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed;
    const summary = typeof obj.summary === "string" ? obj.summary : "";
    const edits = Array.isArray(obj.edits) ? (obj.edits as DevEdit[]) : [];
    const checks = Array.isArray(obj.checks) ? (obj.checks as string[]).filter((c) => typeof c === "string") : [];
    const risk = obj.risk === "high" || obj.risk === "medium" || obj.risk === "low" ? obj.risk : "low";
    const plan: DevPlan = { summary, edits, checks, risk };
    if (typeof obj.notes === "string") plan.notes = obj.notes;
    if (typeof obj.missingContextReason === "string") plan.missingContextReason = obj.missingContextReason;
    return plan;
  } catch {
    return null;
  }
}

async function readProjectSources(
  input: RunDevWorkflowInput,
  paths: string[]
): Promise<Array<{ path: string; content: string }>> {
  const sources: Array<{ path: string; content: string }> = [];
  for (const candidate of paths.slice(0, 6)) {
    try {
      const content = await readProjectFile(input.project.path, candidate);
      sources.push({ path: candidate, content: content.slice(0, 4_000) });
    } catch {
      // ignore unreadable file
    }
  }
  return sources;
}

function pickFileHints(queries: RetrievalQueryRecord[], projectPath: string, repo: RetrievalRepo): string[] {
  const hints = new Set<string>();
  for (const query of queries) {
    const results = repo.listResults(query.id, 8) as Array<{ path: string }>;
    for (const result of results) {
      if (typeof result.path === "string") {
        const relative = result.path.startsWith(projectPath + "/")
          ? result.path.slice(projectPath.length + 1)
          : result.path;
        hints.add(relative);
      }
    }
  }
  return Array.from(hints).slice(0, 8);
}

function retrievalContextForQueries(
  queries: RetrievalQueryRecord[],
  repo: RetrievalRepo
): Array<{ path: string; startLine: number; endLine: number; excerpt: string; score: number }> {
  const chunks: Array<{
    path: string;
    startLine: number;
    endLine: number;
    excerpt: string;
    score: number;
  }> = [];
  for (const query of queries) {
    const selected: RetrievalSelectedContextRecord[] = repo.listSelectedContext(query.id);
    for (const entry of selected) {
      if (entry.path == null || entry.startLine == null || entry.endLine == null) continue;
      chunks.push({
        path: entry.path,
        startLine: entry.startLine,
        endLine: entry.endLine,
        excerpt: entry.excerpt.slice(0, 240),
        score: 1,
      });
    }
    const results: RetrievalResultRecord[] = repo.listResults(query.id, 5);
    for (const entry of results) {
      if (
        !chunks.find(
          (existing) =>
            existing.path === entry.path && existing.startLine === entry.startLine && existing.endLine === entry.endLine
        )
      ) {
        chunks.push({
          path: entry.path,
          startLine: entry.startLine,
          endLine: entry.endLine,
          excerpt: "",
          score: entry.finalScore,
        });
      }
    }
  }
  return chunks;
}

function shouldRequireApproval(input: {
  policy: "auto" | "manual" | "high_risk_only";
  risk: RiskLevel;
  approveEdits: boolean;
}): { required: boolean; reason: string } {
  if (input.policy === "auto" && input.approveEdits) {
    return { required: false, reason: "auto policy and approve-edits set" };
  }
  if (input.policy === "high_risk_only" && input.risk === "low" && input.approveEdits) {
    return { required: false, reason: "low-risk with approve-edits" };
  }
  if (input.policy === "auto") {
    return { required: false, reason: "auto policy" };
  }
  if (input.risk === "high") {
    return { required: true, reason: "high risk" };
  }
  return { required: true, reason: `${input.policy} policy` };
}

async function applyEditsToWorkspace(input: {
  workspace: ExecutionWorkspaceRecord;
  edits: DevEdit[];
}): Promise<{ applied: DevEdit[]; failed: Array<{ edit: DevEdit; reason: string }> }> {
  const applied: DevEdit[] = [];
  const failed: Array<{ edit: DevEdit; reason: string }> = [];
  for (const edit of input.edits) {
    const guard = guardPath({ root: input.workspace.path, candidate: edit.path });
    if (!guard.ok) {
      failed.push({ edit, reason: guard.reason });
      continue;
    }
    if (isSecretFile(guard.relative)) {
      failed.push({ edit, reason: "refuses to touch secret files" });
    }
  }
  for (const edit of input.edits) {
    if (failed.find((entry) => entry.edit === edit)) continue;
    const result = await applyEditToFs({ root: input.workspace.path, edit });
    if (!result.ok) {
      failed.push({ edit, reason: result.reason });
      continue;
    }
    applied.push(edit);
  }
  return { applied, failed };
}

async function runCheckStage(input: {
  runId: string;
  projectId: string;
  workspace: ExecutionWorkspaceRecord;
  execution: ExecutionRepo;
  projectChecks: ProjectChecksConfig;
  checks: string[];
}): Promise<DevRun["checks"]> {
  const results = await runAllowedChecks({
    cwd: input.workspace.path,
    commandNames: input.checks,
    projectConfig: input.projectChecks,
    timeoutMs: 10 * 60_000,
  });
  return results.map((result) => {
    const command = input.execution.recordCommand({
      runId: input.runId,
      projectId: input.projectId,
      workspaceId: input.workspace.id,
      name: result.name,
      command: result.command,
      cwd: result.cwd,
    });
    input.execution.completeCommand({
      id: command.id,
      status: result.status,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      parsedErrors: result.parsedErrors,
      affectedFiles: result.affectedFiles,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      blockedReason: result.blockedReason,
    });
    return {
      name: result.name,
      status: result.status,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      parsedErrors: result.parsedErrors,
      affectedFiles: result.affectedFiles,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
    };
  });
}

async function collectDiffForRun(input: {
  workspace: ExecutionWorkspaceRecord;
  originalRoot: string;
  paths: string[];
}): Promise<{
  diff: string;
  filesChanged: string[];
  filesAdded: string[];
  filesRemoved: string[];
  truncated: boolean;
}> {
  return collectWorkspaceDiff({
    workspace: {
      id: input.workspace.id,
      path: input.workspace.path,
      strategy: input.workspace.strategy,
      branch: input.workspace.branch,
      baseCommit: input.workspace.baseCommit,
      isGitWorktree: input.workspace.isGitWorktree,
      originalRoot: input.workspace.originalRoot,
    },
    originalRoot: input.originalRoot,
    paths: input.paths,
  });
}

function summarizeDiff(input: {
  diff: string;
  filesChanged: string[];
  filesAdded: string[];
  filesRemoved: string[];
  truncated: boolean;
}): string {
  const parts: string[] = [];
  if (input.filesChanged.length > 0) parts.push(`modified: ${input.filesChanged.join(", ")}`);
  if (input.filesAdded.length > 0) parts.push(`added: ${input.filesAdded.join(", ")}`);
  if (input.filesRemoved.length > 0) parts.push(`removed: ${input.filesRemoved.join(", ")}`);
  if (input.truncated) parts.push("truncated: yes");
  return parts.join("; ");
}

function extractPerFileDiff(diff: string, path: string): string {
  if (!diff) return "";
  const sections = diff.split(/^--- /m).filter(Boolean);
  for (const section of sections) {
    if (section.includes(`b/${path}`)) {
      return `--- ${section.split("+++")[0] ?? ""}+++ b/${path}${section.split(`b/${path}`)[1] ?? ""}`;
    }
  }
  return "";
}

function buildResult(
  run: DevRun,
  diff: {
    diff: string;
    filesChanged: string[];
    filesAdded: string[];
    filesRemoved: string[];
    truncated: boolean;
  },
  applied: boolean
): DevResult {
  return {
    runId: run.id,
    sessionId: run.sessionId,
    projectId: run.projectId,
    status: run.status,
    risk: run.risk,
    goal: run.goal,
    summary: run.summary,
    filesEdited: diff.filesChanged,
    filesCreated: diff.filesAdded,
    checks: run.checks,
    diffSummary: summarizeDiff(diff),
    diff: diff.diff,
    applied,
    missingContextReason: run.plan?.missingContextReason ?? null,
    errorMessage: run.errorMessage,
    workspacePath: run.workspace?.path ?? null,
    repairAttempts: run.repairAttempts,
    nextCommand: nextCommandFor(run.id, run.status, applied),
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
  };
}

function makeEmitter(
  meta: { runId: string; sessionId: string; projectId: string },
  emit?: (event: ExecutionEvent) => void
): (input: {
  kind: ExecutionEvent["kind"];
  level?: ExecutionEvent["level"];
  message: string;
  data?: Record<string, unknown>;
}) => void {
  if (emit) {
    return (input) => {
      emit({
        id: createId("exec"),
        runId: meta.runId,
        sessionId: meta.sessionId,
        projectId: meta.projectId,
        kind: input.kind,
        level: input.level ?? "info",
        ts: new Date().toISOString(),
        message: input.message,
        data: input.data ?? {},
      });
    };
  }
  return (input) => {
    // eslint-disable-next-line no-console
    console.log(`[exec] ${meta.runId} ${input.kind} ${input.message}`);
  };
}

export async function runDevWorkflow(input: RunDevWorkflowInput): Promise<RunDevWorkflowResult> {
  const parsedRequest = parseDevRequest(input.request);
  const projectConfig = readProjectChecksConfig(input.project.config ?? null);
  const requestedChecks = resolveChecks(input, projectConfig);
  const maxRepairs = Math.max(0, Math.min(input.request.maxRepairs ?? projectConfig.dev.maxRepairLoops, 5));

  const run = input.runtime.devRuns.createRun({
    sessionId: input.sessionId,
    projectId: input.project.id,
    goal: parsedRequest.goal,
    mode: parsedRequest.mode ?? "local",
    approvalPolicy: parsedRequest.approvalPolicy ?? "manual",
    approveEdits: parsedRequest.approveEdits ?? false,
    maxRepairs,
  });

  const emit = makeEmitter({ runId: run.id, sessionId: input.sessionId, projectId: input.project.id }, input.emit);
  emit({ kind: "run.queued", message: "queued dev run" });
  emit({ kind: "run.started", message: "starting dev pipeline" });

  const startedAt = new Date().toISOString();
  input.runtime.conversation.appendMessage({
    sessionId: input.sessionId,
    projectId: input.project.id,
    role: "user",
    content: parsedRequest.goal,
    meta: { source: input.source ?? "cli", kind: "dev" },
  });

  try {
    if (!existsSync(input.project.path)) {
      throw new Error(`project path does not exist: ${input.project.path}`);
    }

    const existingQueries = input.runtime.retrieval.listQueriesForSession(input.sessionId, 4);
    let chosenQuery = existingQueries[existingQueries.length - 1] ?? null;
    if (!chosenQuery) {
      const created = input.runtime.retrieval.createQuery({
        sessionId: input.sessionId,
        projectId: input.project.id,
        originalQuery: parsedRequest.goal,
        intent: "plan",
        mode: "local",
        depth: "standard",
        rewrittenQuery: null,
        analysis: {
          language: null,
          terms: parsedRequest.goal.split(/\s+/).slice(0, 6),
          pathHints: [],
          symbolHints: [],
          isLikelyDefinition: false,
          isLikelyDebug: true,
          notes: ["dev run seed query"],
        },
      });
      chosenQuery = created;
    }
    const queries = existingQueries.length > 0 ? existingQueries : [chosenQuery];
    const contextChunks = retrievalContextForQueries(queries, input.runtime.retrieval);
    const hints = pickFileHints(queries, input.project.path, input.runtime.retrieval);
    const sources = await readProjectSources(input, hints.length > 0 ? hints : ["README.md", "package.json"]);

    // Stage 1: plan
    input.runtime.devRuns.updateRun(run.id, { status: "planning" });
    emit({ kind: "plan.ready", message: "retrieval complete" });

    const rules = [
      "no shell commands in output",
      "no paths outside the project root",
      "prefer minimal edits",
      "include a reason per edit",
      "never touch .env, secrets, migrations, auth, or db files without flagging high risk",
    ];

    const plannerResult = await input.runtime.modelRuntime.invoke("planner-balanced-local", {
      role: "planner",
      modelName: "planner-balanced-local",
      messages: [
        { role: "system", content: "You are the workbench dev planner. Output JSON only." },
        {
          role: "user",
          content: buildDevPrompt({
            goal: parsedRequest.goal,
            projectName: input.project.name,
            retrieved: sources,
            hints,
            riskHints: projectConfig.dev.requireApprovalFor,
            rules,
          }),
        },
      ],
      temperature: 0,
      maxOutputTokens: 1024,
      metadata: {
        kind: "dev-plan",
        runId: run.id,
        sessionId: input.sessionId,
        projectId: input.project.id,
      },
    });

    let plan = parseModelPlan(plannerResult.text);
    if (!plan) {
      plan = buildMissingContextPlan("model output was not a valid plan");
    } else if (plan.edits.length === 0) {
      plan = { ...plan, missingContextReason: plan.notes ?? "model returned no edits" };
    }

    if (plan.edits.length === 0) {
      input.runtime.devRuns.updateRun(run.id, {
        status: "failed",
        plan,
        summary: plan.summary,
        errorMessage: plan.missingContextReason ?? "no edits",
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - new Date(startedAt).getTime(),
      });
      const updated = input.runtime.devRuns.getRun(run.id);
      if (!updated) throw new Error("dev run vanished");
      emit({
        kind: "run.failed",
        message: "missing context",
        data: { reason: updated.errorMessage },
      });
      return {
        run: updated,
        result: buildResult(
          updated,
          { diff: "", filesChanged: [], filesAdded: [], filesRemoved: [], truncated: false },
          false
        ),
      };
    }

    // Stage 2: workspace
    input.runtime.devRuns.updateRun(run.id, { status: "editing", plan });
    const created = await createTaskWorkspace({
      projectPath: input.project.path,
      runtimeDir: input.runtimeDir,
      sessionId: input.sessionId,
    });
    const workspace = input.runtime.execution.createWorkspace({
      runId: run.id,
      projectId: input.project.id,
      strategy: created.workspace.strategy,
      path: created.workspace.path,
      branch: created.workspace.branch,
      isGitWorktree: created.workspace.isGitWorktree,
      baseCommit: created.workspace.baseCommit,
      originalRoot: created.workspace.originalRoot,
    });
    emit({ kind: "workspace.ready", message: describeWorkspaceForLog(created.workspace) });

    // Stage 3: edits
    const edits = plan.edits;
    const editRisks = edits.map((edit) => riskForPath(edit.path));
    const riskLevel = highestRisk([plan.risk, ...editRisks]);
    const approvalCheck = shouldRequireApproval({
      policy: parsedRequest.approvalPolicy ?? "manual",
      risk: riskLevel,
      approveEdits: parsedRequest.approveEdits ?? false,
    });

    const editOutcomes = await applyEditsToWorkspace({ workspace, edits });
    for (const success of editOutcomes.applied) {
      const editId = input.runtime.devRuns.addEdit({
        runId: run.id,
        projectId: input.project.id,
        edit: success,
        risk: riskForPath(success.path),
        status: "applied",
      });
      emit({ kind: "edit.applied", message: success.path, data: { editId } });
    }
    for (const failure of editOutcomes.failed) {
      const editId = input.runtime.devRuns.addEdit({
        runId: run.id,
        projectId: input.project.id,
        edit: failure.edit,
        risk: riskForPath(failure.edit.path),
        status: "rejected",
        blockedReason: failure.reason,
        errorMessage: failure.reason,
      });
      emit({
        kind: "edit.rejected",
        message: `${failure.edit.path}: ${failure.reason}`,
        data: { editId },
      });
    }

    if (editOutcomes.applied.length === 0) {
      input.runtime.devRuns.updateRun(run.id, {
        status: "failed",
        workspace: {
          id: workspace.id,
          strategy: workspace.strategy,
          path: workspace.path,
          branch: workspace.branch,
        },
        errorMessage: "all edits were rejected by the safety guard",
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - new Date(startedAt).getTime(),
      });
      const updated = input.runtime.devRuns.getRun(run.id);
      if (!updated) throw new Error("dev run vanished");
      emit({ kind: "run.failed", message: "all edits rejected" });
      return {
        run: updated,
        result: buildResult(
          updated,
          { diff: "", filesChanged: [], filesAdded: [], filesRemoved: [], truncated: false },
          false
        ),
      };
    }

    // Stage 4: checks
    input.runtime.devRuns.updateRun(run.id, { status: "checking" });
    let checks = await runCheckStage({
      runId: run.id,
      projectId: input.project.id,
      workspace,
      execution: input.runtime.execution,
      projectChecks: projectConfig,
      checks: requestedChecks,
    });
    let repairAttempts = 0;
    let failedCheck = checks.find((check) => check.status !== "completed" || check.exitCode !== 0);
    while (failedCheck && repairAttempts < maxRepairs) {
      input.runtime.devRuns.updateRun(run.id, {
        status: "repairing",
        repairAttempts: repairAttempts + 1,
      });
      emit({
        kind: "repair.attempted",
        message: failedCheck.name,
        data: { stderr: failedCheck.stderr.slice(0, 500) },
      });
      try {
        const repairResult = await input.runtime.modelRuntime.invoke("dev-repair-local", {
          role: "coder_handoff",
          modelName: "dev-repair-local",
          messages: [
            {
              role: "system",
              content: "You are the workbench dev repair agent. Output JSON only.",
            },
            {
              role: "user",
              content: buildRepairPrompt({
                goal: parsedRequest.goal,
                failedCheck,
                rules,
              }),
            },
          ],
          temperature: 0,
          maxOutputTokens: 1024,
          metadata: {
            kind: "dev-repair",
            runId: run.id,
            sessionId: input.sessionId,
            projectId: input.project.id,
          },
        });
        const repairPlan = parseModelPlan(repairResult.text);
        if (!repairPlan || repairPlan.edits.length === 0) {
          emit({ kind: "repair.attempted", level: "warn", message: "repair returned no edits" });
          break;
        }
        const repairOutcome = await applyEditsToWorkspace({ workspace, edits: repairPlan.edits });
        for (const success of repairOutcome.applied) {
          input.runtime.devRuns.addEdit({
            runId: run.id,
            projectId: input.project.id,
            edit: success,
            risk: riskForPath(success.path),
            status: "applied",
          });
          emit({ kind: "edit.applied", message: success.path });
        }
        for (const failure of repairOutcome.failed) {
          input.runtime.devRuns.addEdit({
            runId: run.id,
            projectId: input.project.id,
            edit: failure.edit,
            risk: riskForPath(failure.edit.path),
            status: "rejected",
            blockedReason: failure.reason,
          });
        }
        repairAttempts += 1;
        checks = await runCheckStage({
          runId: run.id,
          projectId: input.project.id,
          workspace,
          execution: input.runtime.execution,
          projectChecks: projectConfig,
          checks: requestedChecks,
        });
        failedCheck = checks.find((check) => check.status !== "completed" || check.exitCode !== 0);
        if (!failedCheck) break;
      } catch (error) {
        emit({
          kind: "repair.attempted",
          level: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }

    // Stage 5: diff
    const allEditPaths = Array.from(
      new Set([
        ...editOutcomes.applied.map((edit) => edit.path),
        ...editOutcomes.applied.filter((edit) => edit.changeType === "create").map((edit) => edit.path),
      ])
    );
    const diff = await collectDiffForRun({
      workspace,
      originalRoot: input.project.path,
      paths: allEditPaths,
    });
    input.runtime.devRuns.updateRun(run.id, {
      checks,
      repairAttempts,
      plan,
      workspace: {
        id: workspace.id,
        strategy: workspace.strategy,
        path: workspace.path,
        branch: workspace.branch,
      },
      risk: riskLevel,
    });

    if (failedCheck) {
      const updated = input.runtime.devRuns.updateRun(run.id, {
        status: "failed",
        summary: `Checks failed after ${repairAttempts} repair attempt(s)`,
        diffSummary: summarizeDiff(diff),
        diffText: diff.diff,
        filesEdited: diff.filesChanged,
        filesCreated: diff.filesAdded,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - new Date(startedAt).getTime(),
        errorMessage:
          failedCheck.stderr.slice(0, 1000) || `${failedCheck.name} exited with ${failedCheck.exitCode ?? "n/a"}`,
      });
      emit({ kind: "run.failed", level: "warn", message: failedCheck.name });
      return { run: updated, result: buildResult(updated, diff, false) };
    }

    // Stage 6: approval gate
    if (approvalCheck.required) {
      const approval = input.runtime.execution.requestApproval({
        runId: run.id,
        projectId: input.project.id,
        policy: parsedRequest.approvalPolicy ?? "manual",
        risk: riskLevel,
        requiresExplicit: riskLevel === "high",
        reason: approvalCheck.reason,
      });
      const updated = input.runtime.devRuns.updateRun(run.id, {
        status: "awaiting_approval",
        summary: `Awaiting approval (${approvalCheck.reason})`,
        diffSummary: summarizeDiff(diff),
        diffText: diff.diff,
        filesEdited: diff.filesChanged,
        filesCreated: diff.filesAdded,
      });
      emit({
        kind: "approval.required",
        message: approval.reason ?? "approval required",
        data: { approvalId: approval.id },
      });
      return { run: updated, result: buildResult(updated, diff, false) };
    }

    if (parsedRequest.approveEdits) {
      const applyOutcome = await applyWorkspaceToOriginal({
        workspace: {
          id: workspace.id,
          path: workspace.path,
          strategy: workspace.strategy,
          branch: workspace.branch,
          baseCommit: workspace.baseCommit,
          isGitWorktree: workspace.isGitWorktree,
          originalRoot: input.project.path,
        },
        originalRoot: input.project.path,
        paths: Array.from(new Set([...diff.filesChanged, ...diff.filesAdded])),
        allowedRoots: [input.project.path],
      });
      for (const changed of diff.filesChanged) {
        input.runtime.execution.recordPatch({
          runId: run.id,
          projectId: input.project.id,
          path: changed,
          diffText: extractPerFileDiff(diff.diff, changed),
        });
      }
      for (const added of diff.filesAdded) {
        input.runtime.execution.recordPatch({
          runId: run.id,
          projectId: input.project.id,
          path: added,
          diffText: extractPerFileDiff(diff.diff, added),
        });
      }
      const updated = input.runtime.devRuns.updateRun(run.id, {
        status: "applied",
        summary: `Applied ${applyOutcome.applied.length} file(s)`,
        diffSummary: summarizeDiff(diff),
        diffText: diff.diff,
        filesEdited: diff.filesChanged,
        filesCreated: diff.filesAdded,
        appliedAt: new Date().toISOString(),
        appliedFiles: applyOutcome.applied,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - new Date(startedAt).getTime(),
      });
      emit({ kind: "patch.applied", message: `applied ${applyOutcome.applied.length} file(s)` });
      emit({ kind: "run.completed", message: "done" });
      input.runtime.conversation.appendMessage({
        sessionId: input.sessionId,
        projectId: input.project.id,
        role: "assistant",
        content: JSON.stringify({
          kind: "dev-result",
          runId: updated.id,
          appliedFiles: applyOutcome.applied,
        }),
        meta: { kind: "dev", runId: updated.id },
      });
      return { run: updated, result: buildResult(updated, diff, true) };
    }

    const updated = input.runtime.devRuns.updateRun(run.id, {
      status: "awaiting_approval",
      summary: "Awaiting approval before applying to original repo",
      diffSummary: summarizeDiff(diff),
      diffText: diff.diff,
      filesEdited: diff.filesChanged,
      filesCreated: diff.filesAdded,
    });
    emit({ kind: "approval.required", message: "ready for approval" });
    return { run: updated, result: buildResult(updated, diff, false) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ kind: "run.failed", level: "error", message });
    const updated = input.runtime.devRuns.updateRun(run.id, {
      status: "failed",
      errorMessage: message,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - new Date(startedAt).getTime(),
    });
    return {
      run: updated,
      result: buildResult(
        updated,
        { diff: "", filesChanged: [], filesAdded: [], filesRemoved: [], truncated: false },
        false
      ),
    };
  }
}

export async function approveDevRun(input: {
  runId: string;
  runtime: { devRuns: DevRunsRepo; execution: ExecutionRepo };
  decidedBy?: string;
  notes?: string;
}): Promise<{ ok: boolean; run: DevRun | null; error: string | null }> {
  const run = input.runtime.devRuns.getRun(input.runId);
  if (!run) return { ok: false, run: null, error: "run not found" };
  if (run.status !== "awaiting_approval") {
    return { ok: false, run, error: `cannot approve a run in status ${run.status}` };
  }
  const approvals = input.runtime.execution.listApprovals(run.id);
  const pending = approvals.find((approval) => approval.status === "pending");
  if (pending) {
    input.runtime.execution.decideApproval({
      id: pending.id,
      status: "approved",
      decidedBy: input.decidedBy ?? "cli",
      notes: input.notes ?? null,
    });
  }
  const updated = input.runtime.devRuns.updateRun(run.id, {
    status: "approved",
    summary: "Approved; ready to apply",
  });
  return { ok: true, run: updated, error: null };
}

export async function applyApprovedDevRun(input: {
  runId: string;
  projectPath: string;
  runtime: { devRuns: DevRunsRepo; execution: ExecutionRepo };
}): Promise<{ ok: boolean; run: DevRun | null; error: string | null; applied: string[] }> {
  const run = input.runtime.devRuns.getRun(input.runId);
  if (!run) return { ok: false, run: null, error: "run not found", applied: [] };
  if (run.status !== "approved" && run.status !== "awaiting_approval") {
    return { ok: false, run, error: `cannot apply a run in status ${run.status}`, applied: [] };
  }
  const workspace = input.runtime.execution.getWorkspaceForRun(run.id);
  if (!workspace) {
    return { ok: false, run, error: "no workspace for run", applied: [] };
  }
  const edits = input.runtime.devRuns.listEdits(run.id).filter((row) => row.status === "applied");
  const editPaths = Array.from(new Set(edits.map((edit) => edit.path)));
  const outcome = await applyWorkspaceToOriginal({
    workspace: {
      id: workspace.id,
      path: workspace.path,
      strategy: workspace.strategy,
      branch: workspace.branch,
      baseCommit: workspace.baseCommit,
      isGitWorktree: workspace.isGitWorktree,
      originalRoot: input.projectPath,
    },
    originalRoot: input.projectPath,
    paths: editPaths,
    allowedRoots: [input.projectPath],
  });
  for (const file of outcome.applied) {
    input.runtime.execution.recordPatch({
      runId: run.id,
      projectId: run.projectId,
      path: file,
      diffText: "",
    });
  }
  const updated = input.runtime.devRuns.updateRun(run.id, {
    status: "applied",
    summary: `Applied ${outcome.applied.length} file(s)`,
    appliedAt: new Date().toISOString(),
    appliedFiles: outcome.applied,
    finishedAt: new Date().toISOString(),
    durationMs: run.createdAt ? Date.now() - new Date(run.createdAt).getTime() : null,
  });
  return { ok: true, run: updated, error: null, applied: outcome.applied };
}

export async function cancelDevRun(input: {
  runId: string;
  runtime: { devRuns: DevRunsRepo; execution: ExecutionRepo };
  reason?: string;
}): Promise<{ ok: boolean; run: DevRun | null; error: string | null }> {
  const run = input.runtime.devRuns.getRun(input.runId);
  if (!run) return { ok: false, run: null, error: "run not found" };
  if (run.status === "applied" || run.status === "cancelled" || run.status === "completed") {
    return { ok: false, run, error: `cannot cancel run in status ${run.status}` };
  }
  const updated = input.runtime.devRuns.updateRun(run.id, {
    status: "cancelled",
    errorMessage: input.reason ?? "cancelled by user",
    finishedAt: new Date().toISOString(),
    durationMs: run.createdAt ? Date.now() - new Date(run.createdAt).getTime() : null,
  });
  return { ok: true, run: updated, error: null };
}

export const _internal = {
  applyEditsToWorkspace,
  runCheckStage,
  collectDiffForRun,
  isSecretFile,
  isHighRiskPath,
  shouldRequireApproval,
  parseModelPlan,
};
