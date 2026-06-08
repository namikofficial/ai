// Allowlist-driven check runner.
//
// The execution engine never executes raw shell from the LLM. Every check
// is resolved through a built-in or project-declared allowlist. Each
// command is a fixed token list and a binary, not a free-form string.

import { spawn } from "node:child_process";

export type CommandStatus = "running" | "completed" | "failed" | "blocked";

export interface CommandSpec {
  id: string;
  description: string;
  binary: string;
  args: string[];
  cwdFrom: "workspace" | "project";
  env?: Record<string, string>;
}

const BUILTIN_COMMANDS: Record<string, CommandSpec> = {
  typecheck: {
    id: "typecheck",
    description: "Run pnpm typecheck in the workspace.",
    binary: "pnpm",
    args: ["typecheck"],
    cwdFrom: "workspace",
  },
  test: {
    id: "test",
    description: "Run pnpm test in the workspace.",
    binary: "pnpm",
    args: ["test"],
    cwdFrom: "workspace",
  },
  lint: {
    id: "lint",
    description: "Run pnpm lint in the workspace.",
    binary: "pnpm",
    args: ["lint"],
    cwdFrom: "workspace",
  },
  format_check: {
    id: "format_check",
    description: "Run pnpm format:check in the workspace.",
    binary: "pnpm",
    args: ["format:check"],
    cwdFrom: "workspace",
  },
};

const DENIED_BINARIES = new Set([
  "rm",
  "sudo",
  "curl",
  "wget",
  "bash",
  "sh",
  "zsh",
  "fish",
  "dd",
  "mkfs",
  "mount",
  "umount",
  "chmod",
  "chown",
  "kill",
  "killall",
  "shutdown",
  "reboot",
  "pacman",
  "apt",
  "apt-get",
  "yum",
  "dnf",
  "systemctl",
  "service",
]);

const DENIED_ARG_PATTERNS: RegExp[] = [
  /\$\(/,
  /`/,
  /\brm\s+-rf\b/i,
  /\bsudo\b/i,
  /curl\s+[^|]*\|\s*sh/i,
  /wget\s+[^|]*\|\s*sh/i,
  />\s*\/dev\//,
  /\|\s*sh\b/i,
  /\|\s*bash\b/i,
];

export function listBuiltinCommands(): CommandSpec[] {
  return Object.values(BUILTIN_COMMANDS);
}

export function getBuiltinCommand(id: string): CommandSpec | null {
  return BUILTIN_COMMANDS[id] ?? null;
}

export interface ProjectChecksConfig {
  checks: Record<string, string>;
  dev: {
    defaultChecks: string[];
    maxRepairLoops: number;
    requireApprovalFor: string[];
  };
}

function defaultProjectChecks(): ProjectChecksConfig["checks"] {
  return {
    typecheck: "pnpm typecheck",
    test: "pnpm test",
    lint: "pnpm lint",
    format_check: "pnpm format:check",
  };
}

function defaultProjectDev(): ProjectChecksConfig["dev"] {
  return {
    defaultChecks: ["typecheck"],
    maxRepairLoops: 1,
    requireApprovalFor: ["env", "migrations", "auth", "db", "package"],
  };
}

export function readProjectChecksConfig(
  raw: Record<string, unknown> | null | undefined
): ProjectChecksConfig {
  if (!raw || typeof raw !== "object") {
    return { checks: defaultProjectChecks(), dev: defaultProjectDev() };
  }
  const rawChecks = (raw.checks as Record<string, unknown> | undefined) ?? {};
  const checks: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawChecks)) {
    if (typeof value === "string" && value.trim().length > 0) {
      checks[key] = value.trim();
    }
  }
  const mergedChecks = { ...defaultProjectChecks(), ...checks };

  const rawDev = (raw.dev as Record<string, unknown> | undefined) ?? {};
  const defaultChecks = Array.isArray(rawDev.defaultChecks)
    ? rawDev.defaultChecks.filter((item): item is string => typeof item === "string")
    : defaultProjectDev().defaultChecks;
  const maxRepairLoops =
    typeof rawDev.maxRepairLoops === "number" &&
    Number.isFinite(rawDev.maxRepairLoops) &&
    rawDev.maxRepairLoops >= 0
      ? Math.floor(rawDev.maxRepairLoops)
      : defaultProjectDev().maxRepairLoops;
  const requireApprovalFor = Array.isArray(rawDev.requireApprovalFor)
    ? rawDev.requireApprovalFor.filter((item): item is string => typeof item === "string")
    : defaultProjectDev().requireApprovalFor;

  return {
    checks: mergedChecks,
    dev: {
      defaultChecks: defaultChecks.length > 0 ? defaultChecks : defaultProjectDev().defaultChecks,
      maxRepairLoops,
      requireApprovalFor,
    },
  };
}

export function resolveCheckCommand(
  name: string,
  projectConfig: ProjectChecksConfig
): CommandSpec | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const builtin = BUILTIN_COMMANDS[trimmed];
  if (builtin) return builtin;
  const projectCommand = projectConfig.checks[trimmed];
  if (!projectCommand) return null;
  const parsed = parseShellCommand(projectCommand);
  if (!parsed) return null;
  return {
    id: trimmed,
    description: `Project-declared check: ${trimmed}`,
    binary: parsed.binary,
    args: parsed.args,
    cwdFrom: "workspace",
  };
}

function parseShellCommand(command: string): { binary: string; args: string[] } | null {
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  if (tokens.length === 0) return null;
  const cleaned = tokens.map((token) => token.replace(/^["']|["']$/g, ""));
  const binary = cleaned[0];
  if (!binary) return null;
  const args = cleaned.slice(1);
  for (const pattern of DENIED_ARG_PATTERNS) {
    if (pattern.test(command)) {
      return null;
    }
  }
  if (DENIED_BINARIES.has(binary)) {
    return null;
  }
  for (const arg of args) {
    if (DENIED_ARG_PATTERNS.some((pattern) => pattern.test(arg))) {
      return null;
    }
  }
  return { binary, args };
}

export interface RunAllowedCommandInput {
  cwd: string;
  command: CommandSpec;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface RunAllowedCommandResult {
  name: string;
  command: string;
  cwd: string;
  status: CommandStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  blockedReason: string | null;
}

export function renderCommand(command: CommandSpec): string {
  return [command.binary, ...command.args].join(" ");
}

export function isCommandSafe(command: CommandSpec): { safe: boolean; reason: string } {
  if (DENIED_BINARIES.has(command.binary)) {
    return { safe: false, reason: `binary ${command.binary} is not allowed` };
  }
  for (const arg of command.args) {
    if (DENIED_ARG_PATTERNS.some((pattern) => pattern.test(arg))) {
      return { safe: false, reason: `argument ${arg} matches denied pattern` };
    }
    if (/^--?[^=]*[|&;()<>]/.test(arg)) {
      return { safe: false, reason: `argument ${arg} contains shell metacharacter` };
    }
  }
  return { safe: true, reason: "ok" };
}

export async function runAllowedCommand(
  input: RunAllowedCommandInput
): Promise<RunAllowedCommandResult> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const timeoutMs = input.timeoutMs ?? 5 * 60_000;
  const safety = isCommandSafe(input.command);
  if (!safety.safe) {
    return {
      name: input.command.id,
      command: renderCommand(input.command),
      cwd: input.cwd,
      status: "blocked",
      exitCode: null,
      stdout: "",
      stderr: "",
      durationMs: 0,
      startedAt,
      finishedAt: new Date().toISOString(),
      blockedReason: safety.reason,
    };
  }
  return new Promise<RunAllowedCommandResult>((resolve) => {
    const child = spawn(input.command.binary, input.command.args, {
      cwd: input.cwd,
      env: { ...process.env, ...(input.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (
      status: CommandStatus,
      exitCode: number | null,
      blockedReason: string | null
    ): void => {
      if (settled) return;
      settled = true;
      resolve({
        name: input.command.id,
        command: renderCommand(input.command),
        cwd: input.cwd,
        status,
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startMs,
        startedAt,
        finishedAt: new Date().toISOString(),
        blockedReason,
      });
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string | Uint8Array) => {
      stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      if (stdout.length > 200_000) {
        stdout = stdout.slice(0, 200_000) + "\n...truncated...";
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string | Uint8Array) => {
      stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      if (stderr.length > 200_000) {
        stderr = stderr.slice(0, 200_000) + "\n...truncated...";
      }
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      settle("failed", null, `command exceeded ${timeoutMs}ms timeout`);
    }, timeoutMs);
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      settle("failed", null, error.message);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      const exitCode = typeof code === "number" ? code : null;
      settle(exitCode === 0 ? "completed" : "failed", exitCode, null);
    });
  });
}

export async function runAllowedChecks(input: {
  cwd: string;
  commandNames: string[];
  projectConfig: ProjectChecksConfig;
  timeoutMs?: number;
}): Promise<RunAllowedCommandResult[]> {
  const results: RunAllowedCommandResult[] = [];
  for (const name of input.commandNames) {
    const command = resolveCheckCommand(name, input.projectConfig);
    if (!command) {
      results.push({
        name,
        command: `<unknown check "${name}">`,
        cwd: input.cwd,
        status: "blocked",
        exitCode: null,
        stdout: "",
        stderr: `Check "${name}" is not in the allowlist.`,
        durationMs: 0,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        blockedReason: "check not in allowlist",
      });
      continue;
    }
    const result = await runAllowedCommand({
      cwd: input.cwd,
      command,
      timeoutMs: input.timeoutMs,
    });
    results.push(result);
  }
  return results;
}

export function checksAllPassed(results: RunAllowedCommandResult[]): boolean {
  return results.every((result) => result.status === "completed" && result.exitCode === 0);
}
