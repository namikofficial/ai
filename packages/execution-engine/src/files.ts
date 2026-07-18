// File-system helpers for the execution engine.
//
// The execution engine never lets the model or a check command write
// outside the project root or its workspace. This module provides path
// normalization, secret/path blocking, and safe file read/write.

import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";

export const IGNORED_DIRECTORIES: ReadonlyArray<string> = [
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".next",
  "runtime",
  ".cache",
  ".pnpm-store",
  "out",
];

export const SECRET_FILE_PATTERNS: ReadonlyArray<RegExp> = [
  /^\.env(\..+)?$/i,
  /(^|\/)id_rsa(\.pub)?$/,
  /(^|\/)id_ed25519(\.pub)?$/,
  /(^|\/)id_ecdsa(\.pub)?$/,
  /(^|\/)id_dsa(\.pub)?$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.pypirc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)secrets?\.(json|ya?ml|toml|txt)$/i,
  /(^|\/)\.ssh\//,
  /\.pem$/i,
  /\.key$/i,
  /\.pfx$/i,
  /\.p12$/i,
  /\.keystore$/i,
  /(^|\/)credentials(\.json)?$/i,
  /(^|\/)service-account.*\.json$/i,
];

export const HIGH_RISK_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:^|\/)\.env(\..+)?$/i,
  /(?:^|\/)migrations?\//i,
  /(?:^|\/)auth\//i,
  /(?:^|\/)package\.json$/,
  /(?:^|\/)pnpm-lock\.yaml$/,
  /(?:^|\/)yarn\.lock$/,
  /(?:^|\/)package-lock\.json$/,
  /(?:^|\/)Cargo\.toml$/,
  /(?:^|\/)go\.mod$/,
  /(?:^|\/)pyproject\.toml$/,
  /(?:^|\/)tsconfig(\..+)?\.json$/,
  /(?:^|\/)schema\.(prisma|sql)$/i,
  /(?:^|\/)db\/migrations?\//i,
];

export interface PathGuardInput {
  root: string;
  candidate: string;
}

export interface PathGuardResult {
  ok: boolean;
  resolved: string;
  relative: string;
  reason: string;
  isSecret: boolean;
  isHighRisk: boolean;
}

function normalizeSlashes(value: string): string {
  return value.replaceAll("\\", "/");
}

export { normalizeSlashes };

export function isSecretFile(relativePath: string): boolean {
  return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(relativePath));
}

export function isHighRiskPath(relativePath: string): boolean {
  return HIGH_RISK_PATH_PATTERNS.some((pattern) => pattern.test(relativePath));
}

export function isIgnoredDirectory(relativePath: string): boolean {
  const parts = relativePath.split("/").filter(Boolean);
  return parts.some((part) => IGNORED_DIRECTORIES.includes(part));
}

export function guardPath(input: PathGuardInput): PathGuardResult {
  const root = path.resolve(input.root);
  const candidateRaw = path.isAbsolute(input.candidate) ? input.candidate : path.join(root, input.candidate);
  const normalized = path.resolve(candidateRaw);
  const relative = path.relative(root, normalized);
  const relativeSlash = normalizeSlashes(relative);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return {
      ok: false,
      resolved: normalized,
      relative,
      reason: "path escapes root",
      isSecret: false,
      isHighRisk: false,
    };
  }
  if (isIgnoredDirectory(relativeSlash)) {
    return {
      ok: false,
      resolved: normalized,
      relative,
      reason: "path is inside an ignored directory",
      isSecret: false,
      isHighRisk: false,
    };
  }
  const secret = isSecretFile(relativeSlash);
  const highRisk = isHighRiskPath(relativeSlash);
  return {
    ok: !secret,
    resolved: normalized,
    relative,
    reason: secret ? "path matches a secret file pattern" : "ok",
    isSecret: secret,
    isHighRisk: highRisk,
  };
}

export async function readProjectFile(root: string, candidate: string): Promise<string> {
  const guard = guardPath({ root, candidate });
  if (!guard.ok) {
    throw new Error(`refused to read ${candidate}: ${guard.reason}`);
  }
  return readFile(guard.resolved, { encoding: "utf8" });
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export interface WriteFileInput {
  root: string;
  candidate: string;
  contents: string;
  overwrite?: boolean;
}

export interface WriteFileResult {
  ok: boolean;
  resolved: string;
  relative: string;
  reason: string;
  isSecret: boolean;
  isHighRisk: boolean;
  created: boolean;
}

export async function writeProjectFile(input: WriteFileInput): Promise<WriteFileResult> {
  const guard = guardPath({ root: input.root, candidate: input.candidate });
  if (!guard.ok) {
    return {
      ok: false,
      resolved: guard.resolved,
      relative: guard.relative,
      reason: guard.reason,
      isSecret: guard.isSecret,
      isHighRisk: guard.isHighRisk,
      created: false,
    };
  }
  const exists = await fileExists(guard.resolved);
  if (exists && !input.overwrite) {
    return {
      ok: false,
      resolved: guard.resolved,
      relative: guard.relative,
      reason: "file already exists and overwrite is disabled",
      isSecret: guard.isSecret,
      isHighRisk: guard.isHighRisk,
      created: false,
    };
  }
  await mkdir(path.dirname(guard.resolved), { recursive: true });
  await writeFile(guard.resolved, input.contents, { encoding: "utf8" });
  return {
    ok: true,
    resolved: guard.resolved,
    relative: guard.relative,
    reason: "ok",
    isSecret: guard.isSecret,
    isHighRisk: guard.isHighRisk,
    created: !exists,
  };
}

export async function removeProjectFile(root: string, candidate: string): Promise<boolean> {
  const guard = guardPath({ root, candidate });
  if (!guard.ok) {
    return false;
  }
  if (!(await fileExists(guard.resolved))) {
    return false;
  }
  await unlink(guard.resolved);
  return true;
}

export interface ListProjectFilesInput {
  root: string;
  glob?: string;
  maxDepth?: number;
  limit?: number;
}

export async function listProjectFiles(input: ListProjectFilesInput): Promise<string[]> {
  const root = path.resolve(input.root);
  const maxDepth = Math.max(0, Math.floor(input.maxDepth ?? 8));
  const limit = Math.max(1, Math.floor(input.limit ?? 500));
  const files: string[] = [];
  const matcher = createSimpleMatcher(input.glob);

  async function walk(current: string, depth: number): Promise<void> {
    if (files.length >= limit || depth > maxDepth) return;
    const entries = (await readdir(current, { withFileTypes: true })) as Array<{
      name: string;
      isDirectory(): boolean;
      isFile(): boolean;
    }>;
    for (const entry of entries) {
      if (files.length >= limit) break;
      const fullPath = path.join(current, entry.name);
      const relativePath = normalizeSlashes(path.relative(root, fullPath));
      if (isIgnoredDirectory(relativePath)) continue;
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const guard = guardPath({ root, candidate: relativePath });
      if (!guard.ok || guard.isSecret) continue;
      if (matcher(relativePath)) files.push(relativePath);
    }
  }

  await walk(root, 0);
  return files;
}

export interface SearchProjectTextInput {
  root: string;
  query: string;
  glob?: string;
  maxDepth?: number;
  limit?: number;
  maxFileBytes?: number;
}

export interface SearchProjectTextMatch {
  path: string;
  line: number;
  text: string;
}

export async function searchProjectText(input: SearchProjectTextInput): Promise<SearchProjectTextMatch[]> {
  const query = input.query.trim();
  if (!query) return [];
  const limit = Math.max(1, Math.floor(input.limit ?? 100));
  const maxFileBytes = Math.max(1_024, Math.floor(input.maxFileBytes ?? 256 * 1024));
  const files = await listProjectFiles({
    root: input.root,
    glob: input.glob,
    maxDepth: input.maxDepth,
    limit: Math.max(limit, 500),
  });
  const matches: SearchProjectTextMatch[] = [];
  const needle = query.toLowerCase();
  for (const file of files) {
    if (matches.length >= limit) break;
    const guard = guardPath({ root: input.root, candidate: file });
    if (!guard.ok || guard.isSecret) continue;
    const info = await stat(guard.resolved);
    if (info.size > maxFileBytes) continue;
    const content = await readFile(guard.resolved, { encoding: "utf8" });
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (matches.length >= limit) break;
      const line = lines[index] ?? "";
      if (line.toLowerCase().includes(needle)) {
        matches.push({ path: file, line: index + 1, text: line.slice(0, 500) });
      }
    }
  }
  return matches;
}

export interface ApplyEditInput {
  root: string;
  edit: {
    path: string;
    newText: string;
    oldText?: string;
    changeType: "replace" | "create" | "append";
  };
}

export interface ApplyEditResult {
  ok: boolean;
  resolved: string;
  relative: string;
  reason: string;
  created: boolean;
  isSecret: boolean;
  isHighRisk: boolean;
  before: string | null;
  after: string | null;
}

export async function applyEdit(input: ApplyEditInput): Promise<ApplyEditResult> {
  const guard = guardPath({ root: input.root, candidate: input.edit.path });
  if (!guard.ok) {
    return {
      ok: false,
      resolved: guard.resolved,
      relative: guard.relative,
      reason: guard.reason,
      created: false,
      isSecret: guard.isSecret,
      isHighRisk: guard.isHighRisk,
      before: null,
      after: null,
    };
  }
  const exists = await fileExists(guard.resolved);
  if (input.edit.changeType === "create" && exists) {
    return {
      ok: false,
      resolved: guard.resolved,
      relative: guard.relative,
      reason: "file already exists; create cannot overwrite",
      created: false,
      isSecret: guard.isSecret,
      isHighRisk: guard.isHighRisk,
      before: null,
      after: null,
    };
  }
  let before: string | null = null;
  if (exists) {
    before = await readFile(guard.resolved, { encoding: "utf8" });
  }
  let after: string;
  if (input.edit.changeType === "append") {
    after = (before ?? "") + input.edit.newText;
  } else if (input.edit.changeType === "create") {
    after = input.edit.newText;
  } else {
    if (!exists) {
      return {
        ok: false,
        resolved: guard.resolved,
        relative: guard.relative,
        reason: "file does not exist; replace cannot create",
        created: false,
        isSecret: guard.isSecret,
        isHighRisk: guard.isHighRisk,
        before: null,
        after: null,
      };
    }
    if (input.edit.oldText && before && !before.includes(input.edit.oldText)) {
      return {
        ok: false,
        resolved: guard.resolved,
        relative: guard.relative,
        reason: "oldText not found in file",
        created: false,
        isSecret: guard.isSecret,
        isHighRisk: guard.isHighRisk,
        before,
        after: null,
      };
    }
    if (input.edit.oldText && before) {
      after = before.split(input.edit.oldText).join(input.edit.newText);
    } else {
      after = input.edit.newText;
    }
  }
  await mkdir(path.dirname(guard.resolved), { recursive: true });
  await writeFile(guard.resolved, after, { encoding: "utf8" });
  return {
    ok: true,
    resolved: guard.resolved,
    relative: guard.relative,
    reason: "ok",
    created: !exists,
    isSecret: guard.isSecret,
    isHighRisk: guard.isHighRisk,
    before,
    after,
  };
}

export interface ApplyStructuredPatchInput {
  root: string;
  edits: ApplyEditInput["edit"][];
}

export async function applyStructuredPatch(input: ApplyStructuredPatchInput): Promise<ApplyEditResult[]> {
  const results: ApplyEditResult[] = [];
  for (const edit of input.edits) {
    results.push(await applyEdit({ root: input.root, edit }));
  }
  return results;
}

function createSimpleMatcher(glob: string | undefined): (relativePath: string) => boolean {
  const trimmed = glob?.trim();
  if (!trimmed || trimmed === "**/*" || trimmed === "*") return () => true;
  const escaped = trimmed
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0000", ".*");
  const pattern = new RegExp(`^${escaped}$`);
  return (relativePath) => pattern.test(relativePath);
}

export interface SimpleUnifiedDiffInput {
  root: string;
  path: string;
  before: string | null;
  after: string;
}

export function buildSimpleUnifiedDiff(input: SimpleUnifiedDiffInput): string {
  const beforeLines = (input.before ?? "").split("\n");
  const afterLines = input.after.split("\n");
  const header = `--- a/${input.path}\n+++ b/${input.path}\n`;
  const hunks: string[] = [];
  const max = Math.max(beforeLines.length, afterLines.length);
  let hunk: string[] = [];
  let inHunk = false;
  const flushHunk = (): void => {
    if (hunk.length === 0) return;
    hunks.push(`@@ -1,${beforeLines.length} +1,${afterLines.length} @@\n${hunk.join("\n")}`);
    hunk = [];
    inHunk = false;
  };
  for (let index = 0; index < max; index += 1) {
    const beforeLine = beforeLines[index];
    const afterLine = afterLines[index];
    if (beforeLine === afterLine) {
      if (inHunk) {
        hunk.push(` ${beforeLine ?? ""}`);
      }
      continue;
    }
    if (!inHunk) {
      inHunk = true;
    }
    if (beforeLine !== undefined) {
      hunk.push(`-${beforeLine}`);
    }
    if (afterLine !== undefined) {
      hunk.push(`+${afterLine}`);
    }
  }
  flushHunk();
  if (hunks.length === 0) {
    return `${header}(no textual changes)\n`;
  }
  return `${header + hunks.join("\n")}\n`;
}
