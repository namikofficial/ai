#!/usr/bin/env node
// Deterministic project-knowledge generator.
//
// Reads source files and config manifests to emit structured .ai/ markdown
// artifacts. No model is involved.
//
// Generated artifacts:
//   project-summary.md, repo-map.md, routes.md, db-schema.md, env-vars.md,
//   scripts.md, testing.md, deployment.md, known-bugs.md, decisions.md,
//   agent-rules.md

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function walk(dir) {
  const files = [];
  const skip = new Set([
    ".git",
    "node_modules",
    "dist",
    "build",
    "coverage",
    "runtime",
    ".venv",
    "__pycache__",
    "target",
  ]);
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name) || entry.name.startsWith(".")) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...walk(abs));
      else files.push(abs);
    }
  } catch {
    /* noop */
  }
  return files;
}

function readLines(path, max = 30000) {
  try {
    return readFileSync(path, "utf8").split("\n").slice(0, max);
  } catch {
    return [];
  }
}

function grepLines(lines, ...patterns) {
  return lines.filter((l) => patterns.some((p) => p.test(l)));
}

function extractAfter(lines, pattern) {
  const found = [];
  for (const line of lines) {
    const m = line.match(pattern);
    if (m?.[1]) found.push(m[1]);
  }
  return found;
}

function relativePaths(root, absPaths) {
  return absPaths.map((p) => relative(root, p)).sort();
}

function safeReadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

function genProjectSummary(input) {
  const pkg = safeReadJson(join(input.root, "package.json"));
  const _hasTurbo = input.allFiles.some((f) => basename(f) === "turbo.json");
  const hasPoetry = input.allFiles.some((f) => basename(f) === "pyproject.toml");
  const hasCargo = input.allFiles.some((f) => basename(f) === "Cargo.toml");
  const hasDocker = input.allFiles.some((f) => basename(f) === "Dockerfile" || basename(f) === "docker-compose.yml");
  const lines = [
    "# Project Summary",
    "",
    `- Root: ${input.root}`,
    `- Generated: ${new Date().toISOString()}`,
    `- Files: ${input.allFiles.length}`,
    `- PackageManager: ${pkg?.packageManager ?? "-"}`,
    `- Language: ${hasCargo ? "Rust" : hasPoetry ? "Python" : "TypeScript/JavaScript"}`,
    `- Docker: ${hasDocker ? "yes" : "no"}`,
    "",
    "## File type counts",
    ...Object.entries(
      input.allFiles.reduce((acc, f) => {
        const ext = f.match(/\.[^.]+$/)?.[0] ?? "other";
        acc[ext] = (acc[ext] ?? 0) + 1;
        return acc;
      }, {})
    )
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `- ${k}: ${v}`),
    "",
  ];
  return lines.join("\n");
}

function genRepoMap(input) {
  const rels = relativePaths(input.root, input.allFiles);
  return ["# Repo Map", "", `Total files: ${rels.length}`, "", ...rels.map((r) => `- ${r}`), ""].join("\n");
}

function genRoutes(input) {
  const routeFiles = input.allFiles.filter(
    (f) => /route|router|api|handler|endpoint|server/i.test(basename(f)) && /\.(ts|js|py|rs|go)$/.test(f)
  );
  const lines = ["# Routes", ""];
  for (const file of routeFiles.slice(0, 30)) {
    const rel = relative(input.root, file);
    const content = readLines(file, 200);
    const routes = grepLines(content, /(?:router|app|route)\.(get|post|put|patch|delete|use)\s*\(/i);
    if (routes.length > 0) {
      lines.push(`## ${rel}`);
      lines.push(...routes.slice(0, 20).map((r) => `- \`${r.trim()}\``));
      lines.push("");
    }
  }
  if (lines.length < 3) lines.push("(no routes detected)");
  return lines.join("\n");
}

function genDbSchema(input) {
  const sqlFiles = input.allFiles.filter((f) => f.endsWith(".sql") && /migration|schema/.test(f));
  const ormFiles = input.allFiles.filter(
    (f) => /schema|prisma|drizzle|entity/.test(basename(f)) && /\.(prisma|ts|py)$/.test(f)
  );
  const lines = ["# DB Schema", ""];
  for (const file of [...sqlFiles.slice(0, 20), ...ormFiles.slice(0, 10)]) {
    const rel = relative(input.root, file);
    const content = readLines(file, 100);
    const tables = grepLines(content, /create\s+table/i, /create\s+view/i, /^\s*model\s+/i, /^\s*table\s+/i);
    if (tables.length > 0) {
      lines.push(`## ${rel}`);
      lines.push(...tables.slice(0, 30).map((r) => `- \`${r.trim().slice(0, 120)}\``));
      lines.push("");
    }
  }
  if (lines.length < 3) lines.push("(no database schema detected)");
  return lines.join("\n");
}

function genEnvVars(input) {
  const envFiles = input.allFiles.filter((f) => /\.env\.example|env\.config/.test(basename(f)));
  const lines = ["# Environment Variables", ""];
  for (const file of envFiles) {
    const rel = relative(input.root, file);
    const content = readLines(file, 500);
    const vars = grepLines(content, /^[A-Z][A-Z_0-9]+=/);
    if (vars.length > 0) {
      lines.push(`## ${rel}`);
      lines.push(...vars.map((v) => `- \`${v.split("=")[0]}\` = \`${v.split("=").slice(1).join("=")}\``));
      lines.push("");
    }
  }
  const configFiles = input.allFiles.filter((f) => /\/config\.ts$|\/env\.ts$|\/settings\.ts$/.test(f));
  for (const file of configFiles.slice(0, 5)) {
    const content = readLines(file, 200);
    const refs = extractAfter(content, /process\.env\.(\w+)/g);
    if (refs.length > 0) {
      lines.push(`## ${relative(input.root, file)} (referenced)`);
      lines.push(...[...new Set(refs)].map((v) => `- \`${v}\``));
      lines.push("");
    }
  }
  if (lines.length < 3) lines.push("(no env files found)");
  return lines.join("\n");
}

function genScripts(input) {
  const pkg = safeReadJson(join(input.root, "package.json"));
  const lines = ["# Scripts", ""];
  if (pkg?.scripts && typeof pkg.scripts === "object") {
    lines.push("## package.json scripts");
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      lines.push(`- \`${name}\`: \`${cmd}\``);
    }
    lines.push("");
  }
  for (const file of input.allFiles.filter((f) => basename(f) === "Cargo.toml")) {
    const content = readLines(file, 100);
    const aliases = grepLines(content, /^\s*\w+\s*=\s*"/);
    if (aliases.length > 0) {
      lines.push(`## ${relative(input.root, file)}`);
      lines.push(...aliases.slice(0, 20).map((l) => `- \`${l.trim()}\``));
      lines.push("");
    }
  }
  for (const file of input.allFiles.filter((f) => basename(f) === "Makefile")) {
    const targets = grepLines(readLines(file, 80), /^[a-zA-Z_][a-zA-Z0-9_.-]+:/);
    if (targets.length > 0) {
      lines.push("## Makefile", ...targets.slice(0, 20).map((t) => `- \`${t.trim()}\``), "");
    }
  }
  if (lines.length < 3) lines.push("(no scripts found)");
  return lines.join("\n");
}

function genTesting(input) {
  const testFiles = input.allFiles.filter((f) => /\.(test|spec)\.[a-z]+$/.test(f) || /__tests__|tests?\//i.test(f));
  const configFiles = input.allFiles.filter((f) =>
    /(jest|vitest|playwright|ava|mocha|pytest|test)\.config/.test(basename(f))
  );
  const pkg = safeReadJson(join(input.root, "package.json"));
  const lines = ["# Testing", ""];
  if (pkg?.scripts) {
    const testScripts = Object.entries(pkg.scripts).filter(([k]) => /test|check/i.test(k));
    if (testScripts.length > 0) {
      lines.push("## Test scripts");
      lines.push(...testScripts.map(([k, v]) => `- \`${k}\`: \`${v}\``));
      lines.push("");
    }
  }
  for (const f of configFiles) lines.push(`- Test config: ${relative(input.root, f)}`);
  lines.push(`- Test files: ${testFiles.length}`);
  if (testFiles.length > 0) {
    lines.push("", "### Test files", ...relativePaths(input.root, testFiles.slice(0, 100)).map((r) => `- ${r}`));
  }
  lines.push("");
  return lines.join("\n");
}

function genDeployment(input) {
  const deployFiles = input.allFiles.filter(
    (f) => /docker-compose|Dockerfile|\.github\/|\.gitlab-ci|deploy|k8s|helm/i.test(f) && !/node_modules/.test(f)
  );
  const lines = ["# Deployment", ""];
  for (const f of deployFiles.slice(0, 20)) {
    const content = readLines(f, 30);
    lines.push(`## ${relative(input.root, f)}`, "```", content.slice(0, 20).join("\n"), "```", "");
  }
  if (lines.length < 3) lines.push("(no deployment config found)");
  return lines.join("\n");
}

function genKnownBugs(input) {
  const sourceFiles = input.allFiles.filter((f) => /\.(ts|js|tsx|jsx|py|rs|go|sql)$/.test(f));
  const lines = ["# Known Bugs & Technical Debt", ""];
  let total = 0;
  for (const file of sourceFiles.slice(0, 200)) {
    const rel = relative(input.root, file);
    const content = readLines(file, 500);
    const bugLines = grepLines(content, /FIXME|TODO|BUG|HACK|XXX|WORKAROUND|HARDCODED|TEMP/i);
    if (bugLines.length > 0) {
      lines.push(`## ${rel}`);
      lines.push(...bugLines.slice(0, 10).map((l) => `- ${l.trim().slice(0, 150)}`));
      total += bugLines.length;
      lines.push("");
    }
  }
  lines.push(`Total annotations found: ${total}`);
  return lines.join("\n");
}

function genDecisions(input) {
  const adrFiles = input.allFiles.filter(
    (f) => /adr|decision|design-doc|RFC|rfcs?\/\d+/i.test(f) && /\.(md|mdx)$/.test(f)
  );
  const lines = ["# Architecture Decisions", ""];
  if (adrFiles.length > 0) {
    lines.push(...relativePaths(input.root, adrFiles).map((r) => `- ${r}`));
  } else {
    const docsDecisions = input.allFiles.filter(
      (f) => /docs\/.*(?:architecture|decision|design)/i.test(f) && f.endsWith(".md")
    );
    if (docsDecisions.length > 0) {
      lines.push(...relativePaths(input.root, docsDecisions).map((r) => `- ${r}`));
    } else {
      lines.push("(no decision records found)");
    }
  }
  lines.push("");
  return lines.join("\n");
}

function genAgentRules(input) {
  const ruleFiles = input.allFiles.filter(
    (f) => /AGENTS\.md|CLAUDE\.md|llms\.txt$/.test(basename(f)) || /\.cursor\/rules\/|\.codex\//.test(f)
  );
  const lines = ["# Agent Rules", ""];
  for (const f of ruleFiles) {
    const content = readLines(f, 300);
    lines.push(`## ${relative(input.root, f)}`, "", content.slice(0, 200).join("\n"), "");
  }
  if (lines.length < 4) lines.push("(no agent rules found)");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function generateProjectKnowledge(rootArg, outputArg) {
  const root = resolve(rootArg || process.cwd());
  const output = resolve(outputArg || root);
  const dotAiDir = join(output, ".ai");
  mkdirSync(dotAiDir, { recursive: true });

  const allFiles = walk(root);
  const input = { root, allFiles, dotAiDir };

  const generators = [
    { name: "project-summary.md", fn: genProjectSummary },
    { name: "repo-map.md", fn: genRepoMap },
    { name: "routes.md", fn: genRoutes },
    { name: "db-schema.md", fn: genDbSchema },
    { name: "env-vars.md", fn: genEnvVars },
    { name: "scripts.md", fn: genScripts },
    { name: "testing.md", fn: genTesting },
    { name: "deployment.md", fn: genDeployment },
    { name: "known-bugs.md", fn: genKnownBugs },
    { name: "decisions.md", fn: genDecisions },
    { name: "agent-rules.md", fn: genAgentRules },
  ];

  for (const { name, fn } of generators) {
    const content = fn(input);
    writeFileSync(join(dotAiDir, name), content, "utf8");
  }

  return { root, output: dotAiDir, artifacts: generators.length, files: allFiles.length };
}

// CLI entry
import { mkdirSync } from "node:fs";

const isCli = process.argv[1] && /\bgenerate-project-knowledge\.(m)?js$/.test(process.argv[1]);
if (isCli) {
  const result = generateProjectKnowledge(process.argv[2], process.argv[3]);
  console.log(JSON.stringify(result, null, 2));
}
