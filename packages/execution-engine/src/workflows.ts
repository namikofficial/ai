import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import type { CommandDefinition, ProjectManifest } from "../../contracts/src/index.ts";
import { guardPathCanonical, isSecretFile } from "./files.ts";
import { type CommandSpec, type RunAllowedCommandResult, runAllowedCommand } from "./shell.ts";
import { getCurrentBranch, getCurrentCommit } from "./worktree.ts";

export interface PreparedManifestWorkflow {
  workflowId: string;
  projectId: string;
  command: CommandDefinition;
  cwd: string;
  spec: CommandSpec;
}

export interface ManifestWorkflowRejection {
  code:
    | "workflow_not_found"
    | "approval_required"
    | "interactive_terminal_required"
    | "environment_reference_rejected"
    | "environment_delivery_unavailable"
    | "capability_unavailable"
    | "read_only_policy_violation"
    | "unsafe_retry_policy"
    | "working_directory_rejected";
  summary: string;
}

export async function prepareManifestWorkflow(
  manifest: ProjectManifest,
  workflowId: string,
  options: { allowMutating?: boolean; allowInteractive?: boolean } = {}
): Promise<{ ok: true; workflow: PreparedManifestWorkflow } | { ok: false; rejection: ManifestWorkflowRejection }> {
  const entry = Object.entries(manifest.commands).find(
    ([key, command]) => key === workflowId || command.id === workflowId
  );
  if (!entry) {
    return { ok: false, rejection: { code: "workflow_not_found", summary: `unknown workflow: ${workflowId}` } };
  }
  const [, command] = entry;
  if (command.mutation !== "read_only" && !options.allowMutating) {
    return {
      ok: false,
      rejection: {
        code: "approval_required",
        summary: `workflow ${command.id} is ${command.mutation} and requires an approved supervised execution`,
      },
    };
  }
  const desktopLaunch = command.executionMode === "terminal" || command.executionMode === "tmux";
  if (desktopLaunch && !options.allowInteractive) {
    return {
      ok: false,
      rejection: {
        code: "interactive_terminal_required",
        summary: `workflow ${command.id} requires a ${command.executionMode} desktop launch`,
      },
    };
  }
  const unapprovedEnvironmentRef = command.environmentRefs.find(
    (reference) => !manifest.secretRefs.includes(reference)
  );
  if (unapprovedEnvironmentRef) {
    return {
      ok: false,
      rejection: {
        code: "environment_reference_rejected",
        summary: `workflow ${command.id} requests an environment reference not approved by the manifest: ${unapprovedEnvironmentRef}`,
      },
    };
  }
  if (desktopLaunch && command.environmentRefs.length > 0) {
    return {
      ok: false,
      rejection: {
        code: "environment_delivery_unavailable",
        summary: `workflow ${command.id} cannot deliver secret references through a desktop launch`,
      },
    };
  }
  if (command.requiresCapabilities.length > 0) {
    return {
      ok: false,
      rejection: {
        code: "capability_unavailable",
        summary: `workflow ${command.id} requires capabilities: ${command.requiresCapabilities.join(", ")}`,
      },
    };
  }
  if (command.mutation === "read_only" && command.executable === "git") {
    const operation = command.arguments[0] ?? "";
    const mutatingGitOperations = new Set([
      "add",
      "am",
      "apply",
      "branch",
      "checkout",
      "cherry-pick",
      "clean",
      "commit",
      "config",
      "merge",
      "mv",
      "pull",
      "push",
      "rebase",
      "reset",
      "restore",
      "revert",
      "rm",
      "stash",
      "switch",
      "tag",
    ]);
    if (mutatingGitOperations.has(operation)) {
      return {
        ok: false,
        rejection: {
          code: "read_only_policy_violation",
          summary: `workflow ${command.id} declares read-only but git ${operation} can mutate state`,
        },
      };
    }
  }
  if (command.retryLimit > 0 && command.mutation !== "read_only") {
    return {
      ok: false,
      rejection: {
        code: "unsafe_retry_policy",
        summary: `workflow ${command.id} cannot automatically retry a ${command.mutation} command`,
      },
    };
  }

  const requestedCwd = command.workingDirectory
    ? path.resolve(manifest.path, command.workingDirectory)
    : path.resolve(manifest.path);
  let cwd: string | null = null;
  for (const approvedRoot of manifest.approvedRoots) {
    try {
      const guard = await guardPathCanonical({ root: approvedRoot, candidate: requestedCwd });
      if (!guard.ok) continue;
      const info = await stat(guard.resolved);
      if (info.isDirectory()) {
        cwd = guard.resolved;
        break;
      }
    } catch {
      // Try the next approved root. The final response remains intentionally non-sensitive.
    }
  }
  if (!cwd) {
    return {
      ok: false,
      rejection: {
        code: "working_directory_rejected",
        summary: `workflow ${command.id} working directory is outside approved project roots or unavailable`,
      },
    };
  }
  return {
    ok: true,
    workflow: {
      workflowId: command.id,
      projectId: manifest.id,
      command,
      cwd,
      spec: {
        id: command.id,
        description: command.description,
        binary: command.executable,
        args: [...command.arguments],
        cwdFrom: "project",
      },
    },
  };
}

export interface WorkflowApprovalContext {
  projectId: string;
  workflowId: string;
  command: CommandDefinition;
  cwd: string;
  branch: string | null;
  baseCommit: string | null;
}

export async function collectWorkflowApprovalContext(
  workflow: PreparedManifestWorkflow
): Promise<WorkflowApprovalContext> {
  return {
    projectId: workflow.projectId,
    workflowId: workflow.workflowId,
    command: workflow.command,
    cwd: workflow.cwd,
    branch: await getCurrentBranch(workflow.cwd),
    baseCommit: await getCurrentCommit(workflow.cwd),
  };
}

export function workflowApprovalContextHash(context: WorkflowApprovalContext): string {
  const stable = {
    projectId: context.projectId,
    workflowId: context.workflowId,
    command: {
      id: context.command.id,
      executable: context.command.executable,
      arguments: context.command.arguments,
      workingDirectory: context.command.workingDirectory,
      environmentRefs: context.command.environmentRefs,
      interactive: context.command.interactive,
      executionMode: context.command.executionMode,
      mutation: context.command.mutation,
      timeoutSeconds: context.command.timeoutSeconds,
      retryLimit: context.command.retryLimit,
      retryDelaySeconds: context.command.retryDelaySeconds,
      expectedArtifacts: context.command.expectedArtifacts,
      successCriteria: context.command.successCriteria,
      recoveryWorkflowIds: context.command.recoveryWorkflowIds,
      requiresCapabilities: context.command.requiresCapabilities,
    },
    cwd: context.cwd,
    branch: context.branch,
    baseCommit: context.baseCommit,
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export async function runPreparedManifestWorkflow(
  workflow: PreparedManifestWorkflow,
  options: {
    signal?: AbortSignal;
    onSpawn?: (pid: number) => void;
    env?: Record<string, string>;
    redactValues?: string[];
  } = {}
): Promise<RunAllowedCommandResult> {
  return runAllowedCommand({
    cwd: workflow.cwd,
    command: workflow.spec,
    timeoutMs: (workflow.command.timeoutSeconds ?? 300) * 1_000,
    signal: options.signal,
    onSpawn: options.onSpawn,
    env: options.env,
    redactValues: options.redactValues,
  });
}

export interface ExpectedArtifactValidation {
  valid: boolean;
  artifacts: string[];
  satisfied: string[];
  missing: string[];
  invalid: Array<{ id: string; reason: string }>;
}

export async function validateExpectedArtifacts(
  workflow: PreparedManifestWorkflow
): Promise<ExpectedArtifactValidation> {
  const canonicalRoot = await realpath(workflow.cwd);
  const artifacts: string[] = [];
  const satisfied: string[] = [];
  const missing: string[] = [];
  const invalid: Array<{ id: string; reason: string }> = [];
  for (const artifact of workflow.command.expectedArtifacts) {
    const resolved = path.resolve(workflow.cwd, artifact.path);
    const relativePath = path.relative(workflow.cwd, resolved);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      invalid.push({ id: artifact.id, reason: "artifact path escapes workflow working directory" });
      continue;
    }
    if (isSecretFile(relativePath.replaceAll("\\", "/"))) {
      invalid.push({ id: artifact.id, reason: "artifact path matches a secret file pattern" });
      continue;
    }
    const info = await stat(resolved).catch(() => null);
    if (!info) {
      if (artifact.required) missing.push(artifact.id);
      continue;
    }
    const canonical = await realpath(resolved).catch(() => null);
    if (!canonical) {
      if (artifact.required) missing.push(artifact.id);
      continue;
    }
    const canonicalRelative = path.relative(canonicalRoot, canonical);
    if (canonicalRelative.startsWith("..") || path.isAbsolute(canonicalRelative)) {
      invalid.push({ id: artifact.id, reason: "artifact resolves outside workflow working directory" });
      continue;
    }
    if (artifact.kind === "file" && !info.isFile()) {
      invalid.push({ id: artifact.id, reason: "artifact is not a file" });
      continue;
    }
    if (artifact.kind === "directory" && !info.isDirectory()) {
      invalid.push({ id: artifact.id, reason: "artifact is not a directory" });
      continue;
    }
    artifacts.push(canonical);
    satisfied.push(artifact.id);
  }
  return { valid: missing.length === 0 && invalid.length === 0, artifacts, satisfied, missing, invalid };
}

export interface ManifestWorkflowRunResult {
  result: RunAllowedCommandResult;
  attempts: RunAllowedCommandResult[];
}

function retryDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, delayMs);
    const onAbort = (): void => finish();
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runPreparedManifestWorkflowWithRetry(
  workflow: PreparedManifestWorkflow,
  options: Parameters<typeof runPreparedManifestWorkflow>[1] & {
    run?: typeof runPreparedManifestWorkflow;
    onAttempt?: (result: RunAllowedCommandResult, attempt: number) => void | Promise<void>;
    shouldRetry?: (result: RunAllowedCommandResult, attempt: number) => boolean | Promise<boolean>;
  } = {}
): Promise<ManifestWorkflowRunResult> {
  const attempts: RunAllowedCommandResult[] = [];
  const run = options.run ?? runPreparedManifestWorkflow;
  const maxAttempts = workflow.command.retryLimit + 1;
  let result: RunAllowedCommandResult | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    result = await run(workflow, options);
    attempts.push(result);
    await options.onAttempt?.(result, attempt);
    if (result.status === "completed" || result.status === "blocked" || result.status === "cancelled") break;
    const retryAllowed = options.shouldRetry ? await options.shouldRetry(result, attempt) : true;
    if (!retryAllowed) break;
    if (attempt < maxAttempts) {
      await retryDelay(workflow.command.retryDelaySeconds * 1_000, options.signal);
      if (options.signal?.aborted) break;
    }
  }
  if (!result) throw new Error("workflow retry runner produced no result");
  return { result, attempts };
}
