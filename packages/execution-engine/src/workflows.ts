import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import * as path from "node:path";
import type { CommandDefinition, ProjectManifest } from "../../contracts/src/index.ts";
import { guardPathCanonical } from "./files.ts";
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
    | "environment_resolution_required"
    | "capability_unavailable"
    | "read_only_policy_violation"
    | "working_directory_rejected";
  summary: string;
}

export async function prepareManifestWorkflow(
  manifest: ProjectManifest,
  workflowId: string,
  options: { allowMutating?: boolean } = {}
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
  if (command.interactive) {
    return {
      ok: false,
      rejection: {
        code: "interactive_terminal_required",
        summary: `workflow ${command.id} requires an interactive terminal`,
      },
    };
  }
  if (command.environmentRefs.length > 0) {
    return {
      ok: false,
      rejection: {
        code: "environment_resolution_required",
        summary: `workflow ${command.id} requires approved environment references`,
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
      mutation: context.command.mutation,
      timeoutSeconds: context.command.timeoutSeconds,
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
  options: { signal?: AbortSignal } = {}
): Promise<RunAllowedCommandResult> {
  return runAllowedCommand({
    cwd: workflow.cwd,
    command: workflow.spec,
    timeoutMs: (workflow.command.timeoutSeconds ?? 300) * 1_000,
    signal: options.signal,
  });
}
