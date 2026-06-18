// Tool registry for the local-first workbench.
//
// A "tool" is a typed async function the small model can call to
// read, search, or modify project state. Every tool is:
//   * registered with a JSON schema (so the small model knows the
//     exact shape of the arguments it should produce)
//   * gated to a project root so the model can't reach outside the
//     workspace
//   * classified by risk (low / medium / high) and whether the user
//     has to approve it before it runs
//   * tied to a model role so the router picks the cheapest local
//     model that can call it
//
// The registry is the single source of truth for the tool surface.
// Both the dev-agent and the live MCP server route every tool call
// through here, so an LLM can never reach the file system, the
// shell, or the database without going through a registered,
// allowlisted, path-guarded implementation.

import { readFile, readdir, stat, type Dirent } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { createId } from "../../shared/src/index.ts";
import type { ModelRole } from "../../shared/src/index.ts";
import { guardPath, isHighRiskPath, isSecretFile, readProjectFile, writeProjectFile, applyEdit } from "../../execution-engine/src/index.ts";
import { createCodeIntelligenceRepo } from "../../db/src/repositories/code-intelligence.ts";

export type ToolCategory = "read" | "search" | "write" | "analyze";
export type ToolRisk = "low" | "medium" | "high";

export interface ToolDescriptor {
  name: string;
  description: string;
  category: ToolCategory;
  risk: ToolRisk;
  requiresApproval: boolean;
  /** Model role that should be used when the small model picks this tool. */
  preferredRole: ModelRole;
  /** JSON schema describing the expected input shape. */
  inputSchema: Record<string, unknown>;
}

export interface ToolContext {
  projectPath: string;
  projectId: string;
  sessionId: string;
  allowHighRisk: boolean;
  /** Optional database handle for code-intel lookups. */
  db?: Parameters<typeof createCodeIntelligenceRepo>[0];
}

export interface ToolResult {
  ok: boolean;
  output: unknown;
  error?: string;
  /** True when secrets or paths were redacted from the output. */
  redacted: boolean;
  /** Which path the tool actually touched, for audit logs. */
  touchedPath?: string | null;
}

export type ToolImplementation = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

interface RegisteredTool {
  descriptor: ToolDescriptor;
  implementation: ToolImplementation;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(descriptor: ToolDescriptor, implementation: ToolImplementation): void {
    this.tools.set(descriptor.name, { descriptor, implementation });
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  list(): ToolDescriptor[] {
    return Array.from(this.tools.values()).map((entry) => entry.descriptor);
  }

  byCategory(category: ToolCategory): ToolDescriptor[] {
    return this.list().filter((descriptor) => descriptor.category === category);
  }

  async call(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const entry = this.tools.get(name);
    if (!entry) {
      return { ok: false, output: null, error: `unknown tool: ${name}`, redacted: false };
    }
    if (entry.descriptor.risk === "high" && !ctx.allowHighRisk) {
      return {
        ok: false,
        output: null,
        error: `tool ${name} is high-risk and requires explicit approval`,
        redacted: false,
      };
    }
    const validated = validateArgs(args, entry.descriptor.inputSchema);
    if (!validated.ok) {
      return {
        ok: false,
        output: null,
        error: `invalid arguments: ${validated.error}`,
        redacted: false,
      };
    }
    try {
      const result = await entry.implementation(validated.value, ctx);
      return result;
    } catch (error) {
      return {
        ok: false,
        output: null,
        error: error instanceof Error ? error.message : String(error),
        redacted: false,
      };
    }
  }
}

function validateArgs(
  args: unknown,
  schema: Record<string, unknown>
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (args == null) return { ok: true, value: {} };
  if (typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, error: "args must be an object" };
  }
  const properties = (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
  const required = (schema.required as string[] | undefined) ?? [];
  const value = args as Record<string, unknown>;
  for (const key of required) {
    if (!(key in value)) {
      return { ok: false, error: `missing required field: ${key}` };
    }
  }
  for (const [key, fieldSchema] of Object.entries(properties)) {
    if (!(key in value)) continue;
    const expected = fieldSchema.type as string | undefined;
    const actual = value[key];
    if (expected === "string" && typeof actual !== "string") {
      return { ok: false, error: `field ${key} must be a string` };
    }
    if (expected === "number" && typeof actual !== "number") {
      return { ok: false, error: `field ${key} must be a number` };
    }
    if (expected === "boolean" && typeof actual !== "boolean") {
      return { ok: false, error: `field ${key} must be a boolean` };
    }
    if (expected === "array" && !Array.isArray(actual)) {
      return { ok: false, error: `field ${key} must be an array` };
    }
    if (expected === "object" && (actual == null || typeof actual !== "object" || Array.isArray(actual))) {
      return { ok: false, error: `field ${key} must be an object` };
    }
  }
  return { ok: true, value };
}

// ----------------------------------------------------------------------------
// Built-in tool implementations
// ----------------------------------------------------------------------------

const RELATIVE_PATH_SCHEMA = { type: "string", description: "Path relative to the project root." } as const;
const POSITIVE_INTEGER_SCHEMA = { type: "number", description: "Positive integer." } as const;
const STRING_SCHEMA = { type: "string" } as const;
const BOOLEAN_SCHEMA = { type: "boolean" } as const;

const fileReadDescriptor: ToolDescriptor = {
  name: "file_read",
  description:
    "Read a UTF-8 text file from the project root. Returns the file contents, " +
    "a SHA-256 content hash, the line count, and the byte size. Refuses to " +
    "read files outside the project root and refuses secret files (.env, keys, " +
    "PEMs, .npmrc, .pypirc, etc.).",
  category: "read",
  risk: "low",
  requiresApproval: false,
  preferredRole: "file_read",
  inputSchema: {
    type: "object",
    properties: {
      path: RELATIVE_PATH_SCHEMA,
      maxBytes: { type: "number", description: "Soft cap on returned bytes (default 64 KiB)." },
      startLine: { type: "number", description: "Optional 1-based start line." },
      endLine: { type: "number", description: "Optional 1-based end line (inclusive)." },
    },
    required: ["path"],
  },
};

async function fileReadImpl(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const path = String(args.path);
  const guard = guardPath({ root: ctx.projectPath, candidate: path });
  if (!guard.ok) {
    return {
      ok: false,
      output: null,
      error: guard.reason,
      redacted: guard.isSecret,
      touchedPath: guard.relative,
    };
  }
  if (isSecretFile(guard.relative)) {
    return {
      ok: false,
      output: null,
      error: "refuses to read secret file",
      redacted: true,
      touchedPath: guard.relative,
    };
  }
  const content = await readProjectFile(ctx.projectPath, guard.relative);
  const maxBytes = typeof args.maxBytes === "number" && args.maxBytes > 0 ? args.maxBytes : 64 * 1024;
  const lines = content.split("\n");
  const startLine = typeof args.startLine === "number" ? Math.max(1, Math.floor(args.startLine)) : 1;
  const endLine = typeof args.endLine === "number" ? Math.floor(args.endLine) : lines.length;
  const slice = lines.slice(startLine - 1, endLine).join("\n");
  const truncated = slice.length > maxBytes;
  const output = truncated ? `${slice.slice(0, maxBytes)}\n[truncated]` : slice;
  return {
    ok: true,
    output: {
      path: guard.relative,
      content: output,
      bytes: content.length,
      lines: lines.length,
      startLine,
      endLine: Math.min(endLine, lines.length),
      truncated,
    },
    redacted: false,
    touchedPath: guard.relative,
  };
}

const fileWriteDescriptor: ToolDescriptor = {
  name: "file_write",
  description:
    "Create or overwrite a UTF-8 text file under the project root. Refuses " +
    "secret files, refuses to escape the project root, and marks high-risk " +
    "paths (auth, migrations, manifests, schema) as medium risk.",
  category: "write",
  risk: "medium",
  requiresApproval: true,
  preferredRole: "file_write",
  inputSchema: {
    type: "object",
    properties: {
      path: RELATIVE_PATH_SCHEMA,
      contents: STRING_SCHEMA,
      overwrite: { type: "boolean", description: "Allow overwriting an existing file (default false)." },
    },
    required: ["path", "contents"],
  },
};

async function fileWriteImpl(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const path = String(args.path);
  const contents = String(args.contents ?? "");
  const overwrite = args.overwrite === true;
  const result = await writeProjectFile({
    root: ctx.projectPath,
    candidate: path,
    contents,
    overwrite,
  });
  if (!result.ok) {
    return { ok: false, output: null, error: result.reason, redacted: false, touchedPath: result.relative };
  }
  return {
    ok: true,
    output: {
      path: result.relative,
      bytes: contents.length,
      created: result.created,
      isHighRisk: result.isHighRisk,
    },
    redacted: false,
    touchedPath: result.relative,
  };
}

const fileEditDescriptor: ToolDescriptor = {
  name: "file_edit",
  description:
    "Apply a find/replace edit to a single file. The 'oldText' must match " +
    "exactly (whitespace included) and is replaced by 'newText'. Refuses " +
    "secret files. Use this for surgical edits; use file_write for new files.",
  category: "write",
  risk: "medium",
  requiresApproval: true,
  preferredRole: "file_edit",
  inputSchema: {
    type: "object",
    properties: {
      path: RELATIVE_PATH_SCHEMA,
      oldText: STRING_SCHEMA,
      newText: STRING_SCHEMA,
      changeType: { type: "string", enum: ["replace", "create", "append"] },
    },
    required: ["path", "newText"],
  },
};

async function fileEditImpl(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const path = String(args.path);
  const result = await applyEdit({
    root: ctx.projectPath,
    edit: {
      path,
      oldText: typeof args.oldText === "string" ? args.oldText : undefined,
      newText: String(args.newText ?? ""),
      changeType:
        args.changeType === "create" || args.changeType === "append" ? args.changeType : "replace",
    },
  });
  if (!result.ok) {
    return { ok: false, output: null, error: result.reason, redacted: false, touchedPath: result.relative };
  }
  return {
    ok: true,
    output: {
      path: result.relative,
      created: result.created,
      isHighRisk: result.isHighRisk,
      before: result.before,
      after: result.after,
    },
    redacted: false,
    touchedPath: result.relative,
  };
}

const projectListDescriptor: ToolDescriptor = {
  name: "project_list",
  description:
    "List files under the project root up to a configurable depth. " +
    "Skips .git, node_modules, dist, build, coverage, and other noise. " +
    "Returns at most 'limit' entries.",
  category: "search",
  risk: "low",
  requiresApproval: false,
  preferredRole: "file_read",
  inputSchema: {
    type: "object",
    properties: {
      prefix: { type: "string", description: "Only include paths that start with this prefix." },
      maxDepth: { type: "number", description: "Maximum directory depth (default 4)." },
      limit: { type: "number", description: "Maximum number of entries (default 200)." },
    },
  },
};

async function projectListImpl(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const prefix = typeof args.prefix === "string" ? args.prefix : "";
  const maxDepth = typeof args.maxDepth === "number" ? args.maxDepth : 4;
  const limit = typeof args.limit === "number" ? args.limit : 200;
  const IGNORED = new Set([".git", "node_modules", "dist", "build", "coverage", ".turbo", ".next", "runtime", ".cache", "out", ".pnpm-store"]);
  const root = resolve(ctx.projectPath);
  const out: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (out.length >= limit) return;
    if (depth > maxDepth) return;
    let entries: Dirent[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (IGNORED.has(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.name !== ".env.example" && entry.name !== ".ai-workbench.json") continue;
      const full = join(dir, entry.name);
      const rel = relative(root, full).replaceAll("\\", "/");
      if (prefix && !rel.startsWith(prefix)) {
        if (entry.isDirectory()) await walk(full, depth + 1);
        continue;
      }
      out.push(rel);
      if (entry.isDirectory()) await walk(full, depth + 1);
    }
  }
  await walk(root, 0);
  return { ok: true, output: { count: out.length, files: out }, redacted: false };
}

const projectGrepDescriptor: ToolDescriptor = {
  name: "project_grep",
  description:
    "Run a case-sensitive regex search across text files in the project. " +
    "Returns file path, line number, and the matching line. 'include' and " +
    "'exclude' are glob patterns. Skips binary, oversized, and secret files.",
  category: "search",
  risk: "low",
  requiresApproval: false,
  preferredRole: "retrieval_judge",
  inputSchema: {
    type: "object",
    properties: {
      pattern: STRING_SCHEMA,
      include: { type: "string", description: "Glob pattern for files to include." },
      exclude: { type: "string", description: "Glob pattern for files to exclude." },
      limit: { type: "number", description: "Maximum number of matches (default 50)." },
    },
    required: ["pattern"],
  },
};

async function projectGrepImpl(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const pattern = String(args.pattern);
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "m");
  } catch (error) {
    return { ok: false, output: null, error: `invalid regex: ${(error as Error).message}`, redacted: false };
  }
  const include = typeof args.include === "string" ? args.include : null;
  const exclude = typeof args.exclude === "string" ? args.exclude : null;
  const limit = typeof args.limit === "number" ? args.limit : 50;
  const matches: Array<{ path: string; line: number; text: string }> = [];
  const root = resolve(ctx.projectPath);
  const IGNORED = new Set([".git", "node_modules", "dist", "build", "coverage", ".turbo", ".next", "runtime", ".cache", "out"]);
  async function walk(dir: string): Promise<void> {
    if (matches.length >= limit) return;
    let entries: Dirent[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matches.length >= limit) return;
      if (IGNORED.has(entry.name)) continue;
      const full = join(dir, entry.name);
      const rel = relative(root, full).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (isSecretFile(rel)) continue;
      if (include && !globToRegex(include).test(rel)) continue;
      if (exclude && globToRegex(exclude).test(rel)) continue;
      try {
        const st = await stat(full);
        if (st.size > 256_000) continue;
        const content = await readFile(full, { encoding: "utf8" });
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i];
          if (regex.test(line)) {
            matches.push({ path: rel, line: i + 1, text: line.slice(0, 240) });
            if (matches.length >= limit) return;
          }
        }
      } catch {
        // unreadable; skip
      }
    }
  }
  await walk(root);
  return { ok: true, output: { count: matches.length, matches }, redacted: false };
}

function globToRegex(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/");
  let regex = "^";
  for (let i = 0; i < normalized.length; i += 1) {
    const c = normalized[i];
    const next = normalized[i + 1];
    if (c === "*" && next === "*") {
      regex += ".*";
      i += 1;
      continue;
    }
    if (c === "*") {
      regex += "[^/]*";
      continue;
    }
    if (c === "?") {
      regex += "[^/]";
      continue;
    }
    if (/[.+^${}()|[\]\\]/.test(c)) {
      regex += `\\${c}`;
      continue;
    }
    regex += c;
  }
  regex += "$";
  return new RegExp(regex);
}

const symbolLookupDescriptor: ToolDescriptor = {
  name: "symbol_lookup",
  description:
    "Look up a code symbol (function, class, const, method) by name within " +
    "the project's code intelligence index. Returns the file, line range, " +
    "and signature. Use this before editing a file so the edit scope is right.",
  category: "analyze",
  risk: "low",
  requiresApproval: false,
  preferredRole: "retrieval_judge",
  inputSchema: {
    type: "object",
    properties: {
      name: STRING_SCHEMA,
      kind: { type: "string", enum: ["function", "class", "method", "const", "interface", "type", "any"] },
      limit: POSITIVE_INTEGER_SCHEMA,
    },
    required: ["name"],
  },
};

async function symbolLookupImpl(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.db) {
    return { ok: false, output: null, error: "symbol_lookup requires a database handle", redacted: false };
  }
  const repo = createCodeIntelligenceRepo(ctx.db);
  const name = String(args.name);
  const kind = typeof args.kind === "string" ? args.kind : "any";
  const limit = typeof args.limit === "number" ? args.limit : 20;
  const matches = repo.listSymbols(ctx.projectId, name, limit).filter((symbol) => {
    if (kind === "any") return true;
    return symbol.kind === kind;
  });
  return {
    ok: true,
    output: {
      count: matches.length,
      symbols: matches.map((symbol) => ({
        id: symbol.id,
        path: symbol.path,
        name: symbol.name,
        qualifiedName: symbol.qualifiedName,
        kind: symbol.kind,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        signature: symbol.signature,
      })),
    },
    redacted: false,
  };
}

const fileSummaryDescriptor: ToolDescriptor = {
  name: "file_summary",
  description:
    "Return a small structural summary of a file: the path, byte size, line " +
    "count, detected language, and (if the code-intelligence index has it) " +
    "the top symbols defined in the file. Use this to orient before a longer " +
    "file_read.",
  category: "analyze",
  risk: "low",
  requiresApproval: false,
  preferredRole: "summarizer",
  inputSchema: {
    type: "object",
    properties: {
      path: RELATIVE_PATH_SCHEMA,
    },
    required: ["path"],
  },
};

async function fileSummaryImpl(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const path = String(args.path);
  const guard = guardPath({ root: ctx.projectPath, candidate: path });
  if (!guard.ok) {
    return { ok: false, output: null, error: guard.reason, redacted: false, touchedPath: guard.relative };
  }
  if (isSecretFile(guard.relative)) {
    return { ok: false, output: null, error: "refuses to summarize secret file", redacted: true, touchedPath: guard.relative };
  }
  const content = await readProjectFile(ctx.projectPath, guard.relative);
  const lines = content.split("\n");
  const ext = guard.relative.match(/\.[^.]+$/)?.[0]?.toLowerCase() ?? "";
  const language = ({
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".py": "python",
    ".rs": "rust",
    ".go": "go",
    ".sql": "sql",
  } as Record<string, string>)[ext] ?? "text";
  let symbols: Array<{ name: string; kind: string; startLine: number; endLine: number }> = [];
  if (ctx.db && (language === "typescript" || language === "javascript" || language === "python")) {
    const repo = createCodeIntelligenceRepo(ctx.db);
    symbols = repo
      .listSymbols(ctx.projectId, "", 50)
      .filter((symbol) => symbol.path === guard.relative)
      .slice(0, 20)
      .map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
      }));
  }
  return {
    ok: true,
    output: {
      path: guard.relative,
      bytes: content.length,
      lines: lines.length,
      language,
      isHighRisk: isHighRiskPath(guard.relative),
      symbolCount: symbols.length,
      symbols,
    },
    redacted: false,
    touchedPath: guard.relative,
  };
}

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(fileReadDescriptor, fileReadImpl);
  registry.register(fileWriteDescriptor, fileWriteImpl);
  registry.register(fileEditDescriptor, fileEditImpl);
  registry.register(projectListDescriptor, projectListImpl);
  registry.register(projectGrepDescriptor, projectGrepImpl);
  registry.register(symbolLookupDescriptor, symbolLookupImpl);
  registry.register(fileSummaryDescriptor, fileSummaryImpl);
  return registry;
}

export function describeToolCallRecord(input: {
  toolName: string;
  args: unknown;
  ctx: ToolContext;
  result: ToolResult;
  durationMs: number;
}): Record<string, unknown> {
  return {
    id: createId("tool"),
    ts: new Date().toISOString(),
    tool: input.toolName,
    projectId: input.ctx.projectId,
    sessionId: input.ctx.sessionId,
    args: input.args,
    ok: input.result.ok,
    error: input.result.error ?? null,
    touchedPath: input.result.touchedPath ?? null,
    durationMs: input.durationMs,
  };
}
