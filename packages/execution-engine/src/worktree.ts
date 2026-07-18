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

import { type ExecFileOptions, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IGNORED_DIRECTORIES, isIgnoredDirectory, isSecretFile, normalizeSlashes } from "./files.ts";

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
  originalBranch: string | null;
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
  const gitRepository = await isGitRepository(root);
  const baseCommit = gitRepository ? await getCurrentCommit(root) : null;
  const currentBranch = gitRepository ? await getCurrentBranch(root) : null;
  const useWorktree = strategy === "git_worktree" || (strategy === "auto" && gitRepository);

  if (useWorktree) {
    try {
      await execFileAsync("git", ["worktree", "add", "-b", branchName, workspaceDir], { cwd: root });
      return {
        workspace: {
          id: `ws_${runShortId}`,
          path: workspaceDir,
          strategy: "git_worktree",
          branch: branchName,
          baseCommit,
          originalBranch: currentBranch,
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
      baseCommit,
      originalBranch: currentBranch,
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
    }
  }
}

export interface CollectDiffInput {
  workspace: WorkspaceRecord;
  originalRoot: string;
  paths: string[];
  maxBytesPerFile?: number;
  preferManual?: boolean;
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
  const gitDiffResult = input.preferManual ? null : await tryGitDiff(input);
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

export interface RetainedWorkspaceInput {
  executionId: string;
  runtimeDir: string;
  projectRoot: string;
  workspacePath: string;
  workingDirectory: string;
}

export interface RetainedWorkspaceInspection {
  workspace: WorkspaceRecord;
  runDirectory: string;
}

export async function inspectRetainedWorkspace(input: RetainedWorkspaceInput): Promise<RetainedWorkspaceInspection> {
  const expectedRunDirectory = path.resolve(workspaceRootFor(input.runtimeDir), shortId(input.executionId, "run"));
  const expectedWorkspace = path.join(expectedRunDirectory, "workspace");
  if (path.resolve(input.workspacePath) !== expectedWorkspace) {
    throw new Error("retained workspace does not match the canonical execution path");
  }
  const [runtimeRoot, projectRoot, workspacePath, workingDirectory] = await Promise.all([
    realpath(workspaceRootFor(input.runtimeDir)),
    realpath(input.projectRoot),
    realpath(input.workspacePath),
    realpath(input.workingDirectory),
  ]);
  const runDirectory = await realpath(expectedRunDirectory);
  const [runInfo, workspaceInfo] = await Promise.all([lstat(expectedRunDirectory), lstat(expectedWorkspace)]);
  if (
    !runInfo.isDirectory() ||
    runInfo.isSymbolicLink() ||
    !workspaceInfo.isDirectory() ||
    workspaceInfo.isSymbolicLink()
  ) {
    throw new Error("retained workspace path contains an unsafe filesystem object");
  }
  if (!isWithin(runtimeRoot, runDirectory) || !isWithin(runDirectory, workspacePath)) {
    throw new Error("retained workspace escapes the canonical runtime root");
  }
  if (!isWithin(workspacePath, workingDirectory)) {
    throw new Error("workflow working directory is outside its retained workspace");
  }
  if (projectRoot === workspacePath || isWithin(workspacePath, projectRoot)) {
    throw new Error("retained workspace overlaps the canonical project");
  }
  const gitMarker = await lstat(path.join(workspacePath, ".git")).catch(() => null);
  const isGitWorktree = gitMarker?.isFile() === true;
  return {
    runDirectory,
    workspace: {
      id: `ws_${shortId(input.executionId, "run")}`,
      path: workspacePath,
      strategy: isGitWorktree ? "git_worktree" : "safe_copy",
      branch: isGitWorktree ? await getCurrentBranch(workspacePath) : null,
      baseCommit: isGitWorktree ? await getCurrentCommit(workspacePath) : null,
      originalBranch: await getCurrentBranch(projectRoot),
      isGitWorktree,
      originalRoot: projectRoot,
    },
  };
}

async function listRegularFiles(root: string, current = root, output: string[] = []): Promise<string[]> {
  if (output.length > 5_000) throw new Error("retained workspace contains too many files to diff safely");
  const entries = (await readdir(current, { withFileTypes: true })) as Array<{
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }>;
  for (const entry of entries) {
    if (entry.name === ".git" || (entry.isDirectory() && isIgnoredDirectory(entry.name))) continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) await listRegularFiles(root, absolute, output);
    else if (entry.isFile()) {
      const relativePath = normalizeSlashes(path.relative(root, absolute));
      if (!isSecretFile(relativePath)) output.push(relativePath);
    }
  }
  return output;
}

async function gitChangedPaths(workspacePath: string): Promise<{ tracked: string[]; untracked: string[] }> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: workspacePath,
    timeout: 30_000,
  });
  const tracked: string[] = [];
  const untracked: string[] = [];
  const records = stdout.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    const candidate = normalizeSlashes(record.slice(3));
    if (!isSecretFile(candidate)) {
      if (status === "??") untracked.push(candidate);
      else tracked.push(candidate);
    }
    if (status.includes("R") || status.includes("C")) {
      const destination = records[index + 1];
      if (destination && !isSecretFile(destination)) tracked.push(normalizeSlashes(destination));
      index += 1;
    }
  }
  return { tracked: [...new Set(tracked)], untracked: [...new Set(untracked)] };
}

export async function collectRetainedWorkspaceDiff(
  inspection: RetainedWorkspaceInspection
): Promise<CollectDiffResult> {
  let result: CollectDiffResult;
  if (inspection.workspace.isGitWorktree) {
    const paths = await gitChangedPaths(inspection.workspace.path);
    const tracked = await collectDiff({
      workspace: inspection.workspace,
      originalRoot: inspection.workspace.originalRoot,
      paths: paths.tracked,
    });
    const untracked = await collectDiff({
      workspace: inspection.workspace,
      originalRoot: inspection.workspace.originalRoot,
      paths: paths.untracked,
      preferManual: true,
    });
    result = {
      diff: [tracked.diff, untracked.diff].filter(Boolean).join("\n"),
      filesChanged: [...new Set([...tracked.filesChanged, ...untracked.filesChanged])],
      filesAdded: [...new Set([...tracked.filesAdded, ...untracked.filesAdded])],
      filesRemoved: [...new Set([...tracked.filesRemoved, ...untracked.filesRemoved])],
      truncated: tracked.truncated || untracked.truncated,
    };
  } else {
    const paths = [
      ...new Set([
        ...(await listRegularFiles(inspection.workspace.originalRoot)),
        ...(await listRegularFiles(inspection.workspace.path)),
      ]),
    ].sort();
    result = await collectDiff({
      workspace: inspection.workspace,
      originalRoot: inspection.workspace.originalRoot,
      paths,
      preferManual: true,
    });
  }
  const maxDiffBytes = 2 * 1024 * 1024;
  if (new TextEncoder().encode(result.diff).byteLength <= maxDiffBytes) return result;
  return { ...result, diff: result.diff.slice(0, maxDiffBytes), truncated: true };
}

export async function cleanupRetainedWorkspace(inspection: RetainedWorkspaceInspection): Promise<void> {
  if (inspection.workspace.isGitWorktree) {
    await execFileAsync("git", ["worktree", "remove", "--force", inspection.workspace.path], {
      cwd: inspection.workspace.originalRoot,
      timeout: 30_000,
    });
    const expectedBranch = `ai/dev/${path.basename(inspection.runDirectory)}`;
    if (inspection.workspace.branch === expectedBranch) {
      await execFileAsync("git", ["branch", "-D", expectedBranch], {
        cwd: inspection.workspace.originalRoot,
        timeout: 30_000,
      }).catch(() => undefined);
    }
  }
  await rm(inspection.runDirectory, { recursive: true, force: false });
}

async function tryGitDiff(input: CollectDiffInput): Promise<CollectDiffResult | null> {
  const { workspace, originalRoot, paths } = input;
  if (paths.length === 0) return null;

  let raw: string | null = null;

  try {
    if (workspace.isGitWorktree) {
      // git diff HEAD -- <paths> inside the worktree gives us changes vs the base commit.
      const { stdout } = await execFileAsync("git", ["diff", "--no-color", "HEAD", "--", ...paths], {
        cwd: workspace.path,
        timeout: 30_000,
      });
      raw = stdout;
    } else {
      // safe_copy: git diff --no-index original workspace compares two directory trees.
      // Exit code 1 = differences found (expected). We also accept non-zero codes
      // where git wrote diff output to stdout.
      try {
        const { stdout } = await execFileAsync(
          "git",
          ["diff", "--no-color", "--no-index", originalRoot, workspace.path],
          { cwd: originalRoot, timeout: 30_000 }
        );
        raw = stdout;
      } catch (error) {
        const execError = error as { code?: number; stdout?: unknown; stderr?: unknown };
        if (execError.code === 1 || execError.code === 0) {
          raw = String(execError.stdout ?? execError.stderr ?? "");
        } else {
          return null;
        }
      }
    }
  } catch (error) {
    console.warn("[worktree] tryGitDiff failed:", error instanceof Error ? error.message : String(error));
    return null;
  }

  if (raw == null || raw.trim().length === 0) return null;
  return parseGitDiffOutput(raw, paths);
}

/**
 * Parse a raw unified diff into structured file lists.
 * Preserves the complete raw diff output for review/patch use.
 */
function parseGitDiffOutput(raw: string, requestedPaths: string[]): CollectDiffResult {
  const pathSet = new Set(requestedPaths);
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  const diffLines = raw.split("\n");
  let currentFile: string | null = null;

  for (const line of diffLines) {
    const diffHeader = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (diffHeader) {
      const diffPath = diffHeader[2];
      if (!diffPath) continue;
      currentFile = diffPath;
      continue;
    }
    if (line.startsWith("new file mode") || line.startsWith("new file")) {
      if (currentFile && pathSet.has(currentFile) && !added.includes(currentFile)) {
        added.push(currentFile);
      }
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      if (currentFile && pathSet.has(currentFile) && !removed.includes(currentFile)) {
        removed.push(currentFile);
      }
      continue;
    }
    // A hunk header means the file has content changes.
    if (line.startsWith("@@") && currentFile && pathSet.has(currentFile) && !changed.includes(currentFile)) {
      changed.push(currentFile);
    }
  }

  return {
    // Return the raw diff as-is so it is suitable for review and for use as a patch.
    diff: raw,
    filesChanged: changed,
    filesAdded: added,
    filesRemoved: removed,
    truncated: false,
  };
}

async function safeReadText(filePath: string, maxBytes: number): Promise<{ value: string; truncated: boolean }> {
  try {
    const info = await stat(filePath);
    const buffer = await readFile(filePath);
    const bounded = buffer.slice(0, maxBytes);
    if (bounded.includes(0)) {
      return { value: `[binary content omitted: ${info.size} bytes]`, truncated: info.size > maxBytes };
    }
    return { value: new TextDecoder().decode(bounded), truncated: info.size > maxBytes };
  } catch (error) {
    console.warn("[worktree] safeReadText failed:", error instanceof Error ? error.message : String(error));
    return { value: "", truncated: false };
  }
}

export interface ApplyPatchInput {
  workspace: WorkspaceRecord;
  originalRoot: string;
  paths: string[];
  allowedRoots: ReadonlyArray<string>;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function assertNoSymlinkEscape(root: string, relativePath: string, requireLeaf: boolean): Promise<void> {
  const canonicalRoot = await realpath(root);
  const parts = normalizeSlashes(relativePath).split("/").filter(Boolean);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`refused symlink patch path: ${relativePath}`);
      if (index === parts.length - 1 && requireLeaf && !info.isFile()) {
        throw new Error(`patch source is not a regular file: ${relativePath}`);
      }
      const canonical = await realpath(current);
      if (!isWithin(canonicalRoot, canonical)) throw new Error(`patch path escapes canonical root: ${relativePath}`);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT") {
        if (requireLeaf) throw new Error(`patch source is missing: ${relativePath}`);
        break;
      }
      throw error;
    }
  }
}

async function assertApplyTargetUnchanged(
  workspace: WorkspaceRecord,
  originalRoot: string,
  paths: string[]
): Promise<void> {
  if (workspace.baseCommit) {
    const currentCommit = await getCurrentCommit(originalRoot);
    if (currentCommit !== workspace.baseCommit) {
      throw new Error(
        `project HEAD changed since workspace creation (${workspace.baseCommit} -> ${currentCommit ?? "unknown"})`
      );
    }
  }
  if (workspace.originalBranch) {
    const currentBranch = await getCurrentBranch(originalRoot);
    if (currentBranch !== workspace.originalBranch) {
      throw new Error(
        `project branch changed since workspace creation (${workspace.originalBranch} -> ${currentBranch ?? "unknown"})`
      );
    }
  }
  if (workspace.baseCommit && paths.length > 0) {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all", "--", ...paths],
      { cwd: originalRoot, timeout: 30_000 }
    );
    if (stdout.trim().length > 0) {
      throw new Error("one or more reviewed patch paths changed in the original project");
    }
  }
}

export async function applyWorkspaceToOriginal(
  input: ApplyPatchInput
): Promise<{ applied: string[]; skipped: string[] }> {
  const originalRoot = path.resolve(input.originalRoot);
  const canonicalRoot = await realpath(originalRoot);
  const canonicalWorkspace = await realpath(input.workspace.path);
  const allowed = new Set(
    await Promise.all(input.allowedRoots.map(async (value) => await realpath(path.resolve(value))))
  );
  if (!allowed.has(canonicalRoot)) {
    throw new Error(`original root ${canonicalRoot} is not in the allowed list`);
  }
  if ((await realpath(input.workspace.originalRoot)) !== canonicalRoot) {
    throw new Error("workspace original root does not match the apply target");
  }
  const uniquePaths = [...new Set(input.paths.map(normalizeSlashes))];
  await assertApplyTargetUnchanged(input.workspace, originalRoot, uniquePaths);
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const relativePath of uniquePaths) {
    const workspacePath = path.join(input.workspace.path, relativePath);
    const target = path.resolve(path.join(originalRoot, relativePath));
    if (!isWithin(originalRoot, target)) {
      skipped.push(relativePath);
      continue;
    }
    if (isIgnoredDirectory(relativePath)) {
      skipped.push(relativePath);
      continue;
    }
    await assertNoSymlinkEscape(originalRoot, relativePath, false);
    if (!existsSync(workspacePath)) {
      if (existsSync(target)) {
        await rm(target, { force: true });
        applied.push(relativePath);
      } else {
        skipped.push(relativePath);
      }
      continue;
    }
    await assertNoSymlinkEscape(input.workspace.path, relativePath, true);
    const canonicalSource = await realpath(workspacePath);
    if (!isWithin(canonicalWorkspace, canonicalSource)) throw new Error(`workspace path escapes root: ${relativePath}`);
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
