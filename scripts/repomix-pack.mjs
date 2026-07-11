#!/usr/bin/env node
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const project = resolve(args.shift() || process.cwd());
const styleIndex = args.indexOf("--style");
const style = styleIndex >= 0 ? args[styleIndex + 1] : "xml";
const outputIndex = args.indexOf("--output");
const output =
  outputIndex >= 0
    ? resolve(args[outputIndex + 1])
    : resolve(process.env.HOME || ".", "ai-knowledge", "packs", basename(project) + "." + (style === "plain" ? "txt" : style));
if (!existsSync(project)) throw new Error("project does not exist: " + project);
if (!["xml", "markdown", "json", "plain"].includes(style)) throw new Error("invalid Repomix style");
mkdirSync(dirname(output), { recursive: true });
const forwarded = args.filter(
  (_, index) => index !== styleIndex && index !== styleIndex + 1 && index !== outputIndex && index !== outputIndex + 1
);
const result = spawnSync("pnpm", ["dlx", "repomix", "--style", style, "--output", output, project, ...forwarded], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
