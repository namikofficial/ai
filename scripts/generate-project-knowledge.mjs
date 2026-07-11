#!/usr/bin/env node
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(process.argv[2] || process.cwd());
const output = resolve(process.argv[3] || root);
mkdirSync(output, { recursive: true });
const important = new Set(["AGENTS.md", "CLAUDE.md", "README.md", "llms.txt", "openapi.json", "swagger.json", "package.json", "Cargo.toml", "turbo.json", "pnpm-workspace.yaml", "docker-compose.yml"]);
const files = [];
function visit(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if ([".git", "node_modules", "dist", "build", "coverage", "runtime"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) visit(path);
    else if (/\.(md|json|ya?ml|toml)$/i.test(entry.name)) files.push(path);
  }
}
visit(root);
const selected = files.filter((path) => {
  const rel = relative(root, path);
  return important.has(rel) || rel.startsWith("docs/") || rel.startsWith(".codex/") || rel.startsWith(".cursor/rules/");
}).sort();
const summary = "# Project Summary\n\n- Root: " + root + "\n- Generated: " + new Date().toISOString() + "\n- Knowledge files: " + selected.length + "\n";
const map = "# Repo Map\n\n" + selected.map((path) => "- " + relative(root, path)).join("\n") + "\n";
const ruleFiles = selected.filter((path) => /(^|\/)(AGENTS|CLAUDE|llms\.txt)$|(^|\/)(\.cursor\/rules|\.codex)\//.test(relative(root, path)));
const rules = "# Agent Rules\n\n" + (ruleFiles.map((path) => "## " + relative(root, path) + "\n\n" + readFileSync(path, "utf8").slice(0, 12000)).join("\n\n") || "No agent rules found.\n");
writeFileSync(join(output, ".project-summary.md"), summary);
writeFileSync(join(output, ".repo-map.md"), map);
writeFileSync(join(output, ".agent-rules.md"), rules);
console.log(JSON.stringify({ root, output, files: selected.length }, null, 2));
