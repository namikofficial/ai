// Local execution engine for the workbench dev agent.
//
// The execution engine is the only place that knows how to:
//   * run an allowlisted check
//   * write a file inside the project root or its isolated workspace
//   * create a git worktree or safe copy workspace
//   * collect a unified diff between the workspace and the original
//   * apply a workspace back to the original only when explicitly approved
//
// It never executes raw shell from the LLM output and never lets a check
// command touch paths the execution engine did not resolve.

import type { ExecutionEvent, ExecutionEventKind, EventLevel } from "../../shared/src/index.ts";
import { createId } from "../../shared/src/index.ts";
import {
  applyEdit,
  buildSimpleUnifiedDiff,
  fileExists,
  guardPath,
  isHighRiskPath,
  isSecretFile,
  readProjectFile,
  removeProjectFile,
  writeProjectFile,
} from "./files.ts";
import {
  renderCommand,
  resolveCheckCommand,
  runAllowedChecks,
  runAllowedCommand,
  isCommandSafe,
  listBuiltinCommands,
  readProjectChecksConfig,
  checksAllPassed,
} from "./shell.ts";
import {
  applyWorkspaceToOriginal,
  collectDiff,
  createTaskWorkspace,
  defaultRuntimeDir,
  describeWorkspaceForLog,
  getCurrentBranch,
  getCurrentCommit,
  isGitRepository,
  listGitBranches,
} from "./worktree.ts";

export * from "./files.ts";
export * from "./shell.ts";
export * from "./worktree.ts";

export interface ExecutionEventEmitter {
  emit(event: ExecutionEvent): void;
}

export function createEventEmitter(meta: { runId: string; sessionId: string; projectId: string }): ExecutionEventEmitter {
  return {
    emit(input: { kind: ExecutionEventKind; level?: EventLevel; message: string; data?: Record<string, unknown> }): void {
      const event: ExecutionEvent = {
        id: createId("exec"),
        runId: meta.runId,
        sessionId: meta.sessionId,
        projectId: meta.projectId,
        kind: input.kind,
        level: input.level ?? "info",
        ts: new Date().toISOString(),
        message: input.message,
        data: input.data ?? {},
      };
      // Default emitter writes to stdout; consumers can override.
      // eslint-disable-next-line no-console
      console.log(`[exec] ${event.ts} ${event.kind} ${event.message}`);
    },
  };
}

export function riskForPath(relativePath: string): "low" | "medium" | "high" {
  if (isSecretFile(relativePath)) return "high";
  if (isHighRiskPath(relativePath)) return "medium";
  return "low";
}

export const engine = {
  applyEdit,
  buildSimpleUnifiedDiff,
  applyWorkspaceToOriginal,
  collectDiff,
  createTaskWorkspace,
  defaultRuntimeDir,
  describeWorkspaceForLog,
  fileExists,
  guardPath,
  isCommandSafe,
  isGitRepository,
  listBuiltinCommands,
  listGitBranches,
  getCurrentBranch,
  getCurrentCommit,
  readProjectChecksConfig,
  readProjectFile,
  renderCommand,
  resolveCheckCommand,
  runAllowedChecks,
  runAllowedCommand,
  checksAllPassed,
  removeProjectFile,
  riskForPath,
  writeProjectFile,
  createEventEmitter,
};

export default engine;
