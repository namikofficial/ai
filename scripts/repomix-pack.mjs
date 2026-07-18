#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const project = resolve(args.shift() || process.cwd());
const styleIndex = args.indexOf("--style");
const style = styleIndex >= 0 ? args[styleIndex + 1] : "xml";
const outputIndex = args.indexOf("--output");
const output =
  outputIndex >= 0
    ? resolve(args[outputIndex + 1])
    : resolve(
        process.env.HOME || ".",
        "ai-knowledge",
        "packs",
        `${basename(project)}.${style === "plain" ? "txt" : style}`
      );
if (!existsSync(project)) throw new Error(`project does not exist: ${project}`);
if (!["xml", "markdown", "json", "plain"].includes(style)) throw new Error("invalid Repomix style");
mkdirSync(dirname(output), { recursive: true });
const forwarded = args.filter(
  (_, index) => index !== styleIndex && index !== styleIndex + 1 && index !== outputIndex && index !== outputIndex + 1
);
const repomixArgs = ["--style", style, "--output", output, project, ...forwarded];
// Prefer the workspace-installed repomix binary (declared in devDependencies)
// via `pnpm exec`; fall back to `pnpm dlx` when it is not installed so packing
// still works without a prior install.
const local = spawnSync("pnpm", ["exec", "repomix", ...repomixArgs], { stdio: "inherit" });
const result =
  local.error && local.error.code === "ENOENT"
    ? spawnSync("pnpm", ["dlx", "repomix", ...repomixArgs], { stdio: "inherit" })
    : local;
process.exit(result.status ?? 1);
