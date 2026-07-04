// Workspace manager for the execution engine.
//
// The dev agent never mutates the original repo directly. Every run
// operates inside an isolated workspace:
//   * git worktree (preferred) when the project is a git repository.
//   * safe copy (fallback) when the project is not under git or the
//     worktree command fails for a recoverable reason.
//
// The workspace lives under <runtimeDir>/dev-runs/<sessionId>/workspace. The
// original project path is stored so the patch can later be applied back
// at the user's explicit request.

import { execFile, type ExecFileOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IGNORED_DIRECTORIES, isIgnoredDirectory, normalizeSlashes } from "./files.ts";

function execFileAsync(
  file: string,
  args: string[],
  options: ExecFileOptions
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export type WorkspaceStrategy = "auto" | "git_worktree" | "safe_copy";

export interface CreateWorkspaceInput {
  projectPath: string;
  runtimeDir: string;
  runId: string;
  sessionId: string;
  strategy?: WorkspaceStrategy;
}

export interface WorkspaceRecord {
  id: string;
  path: string;
  strategy: "git_worktree" | "safe_copy";
  branch: string | null;
  baseCommit: string | null;
  isGitWorktree: boolean;
  originalRoot: string;
}

export interface CreateWorkspaceResult {
  workspace: WorkspaceRecord;
  cleanup(): Promise<void>;
}

export async function isGitRepository(projectPath: string): Promise<boolean> {
  if (!existsSync(projectPath)) return false;
  try {
    const gitDir = path.join(projectPath, ".git");
    if (existsSync(gitDir)) {
      return true;
    }
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: projectPath });
    return true;
  } catch {
    return false;
  }
}

export async function listGitBranches(projectPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["branch", "--format=%(refname:short)"], {
      cwd: projectPath,
    });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("*"));
  } catch {
    return [];
  }
}

export async function getCurrentBranch(projectPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: projectPath,
    });
    const branch = stdout.trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

export async function getCurrentCommit(projectPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: projectPath });
    const commit = stdout.trim();
    return commit.length > 0 ? commit : null;
  } catch {
    return null;
  }
}

function shortId(id: string, label: string): string {
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 20);
  return sanitized.length > 0 ? `${label}_${sanitized}` : label;
}

function workspaceRootFor(runtimeDir: string): string {
  return path.join(runtimeDir, "dev-runs");
}

export async function createTaskWorkspace(input: CreateWorkspaceInput): Promise<CreateWorkspaceResult> {
  const root = path.resolve(input.projectPath);
  if (!existsSync(root)) {
    throw new Error(`project path does not exist: ${root}`);
  }
  const workspacesRoot = workspaceRootFor(input.runtimeDir);
  await mkdir(workspacesRoot, { recursive: true });
  const runShortId = shortId(input.runId, "run");
  const runDir = path.join(workspacesRoot, runShortId);
  const workspaceDir = path.join(runDir, "workspace");
  const branchName = `ai/dev/${runShortId}`;

  const strategy = input.strategy ?? "auto";
  const useWorktree = strategy === "git_worktree" || (strategy === "auto" && (await isGitRepository(root)));

  if (useWorktree) {
    const baseCommit = await getCurrentCommit(root);
    const currentBranch = await getCurrentBranch(root);
    try {
      await execFileAsync("git", ["worktree", "add", "-b", branchName, workspaceDir], { cwd: root });
      return {
        workspace: {
          id: `ws_${runShortId}`,
          path: workspaceDir,
          strategy: "git_worktree",
          branch: branchName,
          baseCommit,
          isGitWorktree: true,
          originalRoot: root,
        },
        cleanup: async () => {
          await execFileAsync("git", ["worktree", "remove", "--force", workspaceDir], {
            cwd: root,
          }).catch(() => undefined);
          await execFileAsync("git", ["branch", "-D", branchName], { cwd: root }).catch(() => undefined);
          await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
        },
      };
    } catch (error) {
      // Fall through to safe copy.
      // eslint-disable-next-line no-console
      console.warn(
        `[execution-engine] git worktree failed, falling back to safe copy: ${(error as Error).message} (branch=${currentBranch ?? "n/a"})`
      );
    }
  }

  // Safe copy (or explicit safe_copy strategy).
  await rm(runDir, { recursive: true, force: true });
  await mkdir(workspaceDir, { recursive: true });
  await copyDirectory(root, workspaceDir);
  return {
    workspace: {
      id: `ws_${runShortId}`,
      path: workspaceDir,
      strategy: "safe_copy",
      branch: null,
      baseCommit: null,
      isGitWorktree: false,
      originalRoot: root,
    },
    cleanup: async () => {
      await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

async function copyDirectory(source: string, target: string): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries as {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }[]) {
    const relative = entry.name;
    if (isIgnoredDirectory(normalizeSlashes(relative))) {
      continue;
    }
    const from = path.join(source, relative);
    const to = path.join(target, relative);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.includes(entry.name)) {
        continue;
      }
      await mkdir(to, { recursive: true });
      await copyDirectory(from, to);
    } else if (entry.isFile()) {
      await cp(from, to, { recursive: false });
    } else if (entry.isSymbolicLink()) {
      try {
        const target = await readFile(from)
          .then(() => undefined)
          .catch(() => undefined);
        if (target !== undefined) {
          await cp(from, to, { recursive: false });
        }
      } catch {
        // ignore broken symlink
      }
    }
  }
}

export interface CollectDiffInput {
  workspace: WorkspaceRecord;
  originalRoot: string;
  paths: string[];
  maxBytesPerFile?: number;
}

export interface CollectDiffResult {
  diff: string;
  filesChanged: string[];
  filesAdded: string[];
  filesRemoved: string[];
  truncated: boolean;
}

export async function collectDiff(input: CollectDiffInput): Promise<CollectDiffResult> {
  const maxBytes = input.maxBytesPerFile ?? 256 * 1024;

  // Try git diff first for quality.
  const gitDiffResult = await tryGitDiff(input);
  if (gitDiffResult != null) return gitDiffResult;

  // Fallback: manual per-file comparison.
  const diffs: string[] = [];
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  let truncated = false;
  for (const relative of input.paths) {
    const relativePath = normalizeSlashes(relative);
    const workspacePath = path.join(input.workspace.path, relativePath);
    const originalPath = path.join(input.originalRoot, relativePath);
    const workspaceExists = existsSync(workspacePath);
    const originalExists = existsSync(originalPath);
    if (workspaceExists && !originalExists) {
      added.push(relativePath);
      const content = await safeReadText(workspacePath, maxBytes);
      if (content.truncated) truncated = true;
      diffs.push(
        `--- /dev/null\n+++ b/${relativePath}\n@@ -0,0 +1,${content.value.split("\n").length} @@\n+${content.value.split("\n").join("\n+")}\n`
      );
      continue;
    }
    if (!workspaceExists && originalExists) {
      removed.push(relativePath);
      diffs.push(`--- a/${relativePath}\n+++ /dev/null\n`);
      continue;
    }
    if (!workspaceExists && !originalExists) {
      continue;
    }
    const beforeContent = await safeReadText(originalPath, maxBytes);
    const afterContent = await safeReadText(workspacePath, maxBytes);
    if (beforeContent.truncated || afterContent.truncated) truncated = true;
    if (beforeContent.value === afterContent.value) {
      continue;
    }
    changed.push(relativePath);
    const beforeLines = beforeContent.value.split("\n");
    const afterLines = afterContent.value.split("\n");
    const hunks: string[] = [];
    const max = Math.max(beforeLines.length, afterLines.length);
    for (let index = 0; index < max; index += 1) {
      const beforeLine = beforeLines[index];
      const afterLine = afterLines[index];
      if (beforeLine === afterLine) continue;
      if (beforeLine !== undefined) hunks.push(`-${beforeLine}`);
      if (afterLine !== undefined) hunks.push(`+${afterLine}`);
    }
    diffs.push(
      `--- a/${relativePath}\n+++ b/${relativePath}\n@@ -1,${beforeLines.length} +1,${afterLines.length} @@\n${hunks.join("\n")}\n`
    );
  }
  return {
    diff: diffs.join("\n"),
    filesChanged: changed,
    filesAdded: added,
    filesRemoved: removed,
    truncated,
  };
}

async function tryGitDiff(input: CollectDiffInput): Promise<CollectDiffResult | null> {
  const { workspace, originalRoot, paths } = input;
  const nonEmpty = paths.filter(Boolean);
  if (nonEmpty.length === 0) return null;

  let diffOutput: string | null = null;

  try {
    if (workspace.isGitWorktree) {
      // git diff HEAD -- <paths> inside the worktree gives us changes vs the base commit.
      const { stdout } = await execFileAsync(
        "git",
        ["diff", "--no-color", "HEAD", "--", ...nonEmpty],
        { cwd: workspace.path, timeout: 30_000 }
      );
      diffOutput = stdout;
    } else {
      // safe_copy: diff original against workspace using git diff --no-index.
      // git diff --no-index exits 1 when differences are found, which is expected.
      try {
        const { stdout } = await execFileAsync(
          "git",
          ["diff", "--no-color", "--no-index", originalRoot, workspace.path, "--", ...nonEmpty],
          { cwd: originalRoot, timeout: 30_000 }
        );
        diffOutput = stdout;
      } catch (error) {
        // Exit code 1 = differences found; parse from error's stdout/stderr.
        const execError = error as { code?: number; stdout?: unknown; stderr?: unknown };
        if (execError.code === 1) {
          diffOutput = String(execError.stdout ?? execError.stderr ?? "");
        } else {
          return null;
        }
      }
    }
  } catch {
    return null;
  }

  if (diffOutput == null || diffOutput.trim().length === 0) return null;
  return parseGitDiffOutput(diffOutput, nonEmpty);
}

function parseGitDiffOutput(raw: string, paths: string[]): CollectDiffResult {
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const pathSet = new Set(paths);
  const diffLines = raw.split("\n");
  let currentFile: string | null = null;
  let inAdded = false;
  let inRemoved = false;
  const diffParts: string[] = [];
  let i = 0;

  while (i < diffLines.length) {
    const line = diffLines[i]!;
    // git diff header: diff --git a/path b/path
    const diffHeader = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (diffHeader) {
      if (currentFile !== null && pathSet.has(currentFile)) {
        // Close previous file
      }
      currentFile = diffHeader[2]!;
      inAdded = false;
      inRemoved = false;
      i++;
      continue;
    }
    // File mode line: new file mode
    if (line.startsWith("new file mode") || line.startsWith("new file")) {
      if (currentFile) added.push(currentFile);
      i++;
      continue;
    }
    // Deleted file mode
    if (line.startsWith("deleted file mode")) {
      if (currentFile) removed.push(currentFile);
      i++;
      continue;
    }
    // Hunk header: @@ -N,N +N,N @@
    if (line.startsWith("@@")) {
      if (currentFile && pathSet.has(currentFile) && !changed.includes(currentFile)) {
        changed.push(currentFile);
      }
      diffParts.push(line);
      inAdded = false;
      inRemoved = false;
      i++;
      continue;
    }
    // Context or diff content
    if (currentFile && pathSet.has(currentFile)) {
      diffParts.push(line);
      if (line.startsWith("+") && !line.startsWith("+++")) inAdded = true;
      if (line.startsWith("-") && !line.startsWith("---")) inRemoved = true;
    }
    i++;
  }

  // Also handle files that were added (detected via "new file mode" header)
  // Run a second pass to detect simple new files
  for (const p of paths) {
    if (!changed.includes(p) && !added.includes(p) && !removed.includes(p)) {
      // Check if this path appears as "new file" in raw output
      if (raw.includes(`new file mode`) && raw.includes(`a/${p}`) && raw.includes(`b/${p}`)) {
        if (!added.includes(p)) added.push(p);
      }
    }
  }

  return {
    diff: diffParts.join("\n"),
    filesChanged: changed,
    filesAdded: added,
    filesRemoved: removed,
    truncated: false,
  };
}

async function safeReadText(filePath: string, maxBytes: number): Promise<{ value: string; truncated: boolean }> {
  try {
    const info = await stat(filePath);
    if (info.size > maxBytes) {
      const buffer = await readFile(filePath, { encoding: "utf8" });
      return { value: buffer.slice(0, maxBytes), truncated: true };
    }
    return { value: await readFile(filePath, { encoding: "utf8" }), truncated: false };
  } catch (error) {
    return { value: "", truncated: false };
  }
}

export interface ApplyPatchInput {
  workspace: WorkspaceRecord;
  originalRoot: string;
  paths: string[];
  allowedRoots: ReadonlyArray<string>;
}

export async function applyWorkspaceToOriginal(
  input: ApplyPatchInput
): Promise<{ applied: string[]; skipped: string[] }> {
  const originalRoot = path.resolve(input.originalRoot);
  const allowed = new Set(input.allowedRoots.map((value) => path.resolve(value)));
  if (!allowed.has(originalRoot)) {
    throw new Error(`original root ${originalRoot} is not in the allowed list`);
  }
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const relative of input.paths) {
    const relativePath = normalizeSlashes(relative);
    const workspacePath = path.join(input.workspace.path, relativePath);
    const target = path.resolve(path.join(originalRoot, relativePath));
    if (!target.startsWith(originalRoot + path.sep) && target !== originalRoot) {
      skipped.push(relativePath);
      continue;
    }
    if (isIgnoredDirectory(relativePath)) {
      skipped.push(relativePath);
      continue;
    }
    if (!existsSync(workspacePath)) {
      if (existsSync(target)) {
        await rm(target, { force: true });
        applied.push(relativePath);
      } else {
        skipped.push(relativePath);
      }
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await cp(workspacePath, target, { recursive: false });
    applied.push(relativePath);
  }
  return { applied, skipped };
}

export function defaultRuntimeDir(): string {
  return process.env.AI_RUNTIME_DIR ?? path.join(process.cwd(), "runtime");
}

export function describeWorkspaceForLog(workspace: WorkspaceRecord): string {
  return `${workspace.strategy}@${workspace.path}${workspace.branch ? ` (${workspace.branch})` : ""}`;
}

export async function tmpdirShort(): Promise<string> {
  return os.tmpdir();
}
