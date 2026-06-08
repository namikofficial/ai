// Project file walking and basic I/O helpers used by the indexer.
//
// This module owns the small amount of filesystem traversal the local
// indexer needs. The DB layer does not call into node:fs directly anymore;
// everything goes through this surface so it can be tested and swapped.

import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";

export const DEFAULT_IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".next",
  "runtime",
]);

export const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".mdx",
  ".txt",
  ".yaml",
  ".yml",
  ".toml",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".sh",
  ".sql",
  ".css",
  ".html",
]);

export interface WalkOptions {
  ignoreDirs?: Set<string>;
}

export async function walkFiles(root: string, options: WalkOptions = {}): Promise<string[]> {
  const ignore = options.ignoreDirs ?? DEFAULT_IGNORE_DIRS;
  const entries: string[] = [];

  async function visit(current: string): Promise<void> {
    const items = (await readdir(current, { withFileTypes: true })) as Array<{
      name: string;
      isDirectory(): boolean;
      isSymbolicLink(): boolean;
    }>;
    for (const item of items) {
      if (item.name.startsWith(".")) {
        if (!ignore.has(item.name)) {
          continue;
        }
      }
      if (ignore.has(item.name)) {
        continue;
      }
      const nextPath = join(current, item.name);
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) {
        await visit(nextPath);
        continue;
      }
      entries.push(nextPath);
    }
  }
  await visit(root);
  return entries;
}

export function isProbablyTextFile(path: string): boolean {
  return (
    TEXT_EXTENSIONS.has(extname(path).toLowerCase()) ||
    /(^|\/)(package\.json|Dockerfile)$/i.test(path)
  );
}

export async function safeReadText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export async function isReadableFile(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function inferLanguage(path: string): string | null {
  const extension = extname(path).toLowerCase();
  if (extension === ".ts" || extension === ".tsx") return "typescript";
  if (extension === ".js" || extension === ".jsx") return "javascript";
  if (extension === ".py") return "python";
  if (extension === ".rs") return "rust";
  if (extension === ".go") return "go";
  if (extension === ".sql") return "sql";
  if (extension === ".java") return "java";
  if (extension === ".sh") return "shell";
  return null;
}
