import * as path from "node:path";

export interface CloudGuardInput {
  cloudEnabled: boolean;
  providerKind: "heuristic" | "openai_compat" | "llama_cpp" | "mock" | "cloud_openai_compat" | "local_openai_compat" | "fastembed" | string;
  profileLocalOnly?: boolean;
}

export interface CloudGuardResult {
  allowed: boolean;
  reason: string;
}

export function isCloudProviderKind(kind: string): boolean {
  return kind === "cloud_openai_compat" || kind === "openai_compat";
}

export function checkCloudGuard(input: CloudGuardInput): CloudGuardResult {
  if (isCloudProviderKind(input.providerKind) && !input.cloudEnabled) {
    return { allowed: false, reason: "cloud disabled (AI_CLOUD_ENABLED=false)" };
  }
  return { allowed: true, reason: "ok" };
}

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "aws_access_key", pattern: /AKIA[0-9A-Z]{16}/g },
  { name: "github_token", pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: "openai_key", pattern: /sk-[A-Za-z0-9]{20,}/g },
  { name: "anthropic_key", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "google_api_key", pattern: /AIza[0-9A-Za-z_\-]{30,}/g },
  { name: "slack_token", pattern: /xox[abprs]-[A-Za-z0-9-]{20,}/g },
  { name: "jwt", pattern: /eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}/g },
  { name: "private_key", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { name: "bearer_token", pattern: /(?:bearer|authorization)\s*[:=]\s*["']?[A-Za-z0-9._\-]{20,}["']?/gi },
];

export interface RedactionResult {
  text: string;
  redactions: Array<{ kind: string; count: number }>;
}

export function redactSecrets(text: string): RedactionResult {
  if (!text || text.length === 0) {
    return { text: text ?? "", redactions: [] };
  }
  let output = text;
  const redactions: Array<{ kind: string; count: number }> = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    const matches = output.match(pattern);
    if (matches && matches.length > 0) {
      output = output.replace(pattern, `[REDACTED:${name}]`);
      redactions.push({ kind: name, count: matches.length });
    }
  }
  return { text: output, redactions };
}

export interface PathPolicyInput {
  projectRoot: string;
  candidatePath: string;
}

export interface PathPolicyResult {
  allowed: boolean;
  resolvedPath: string;
  reason: string;
}

export function checkPathPolicy(input: PathPolicyInput): PathPolicyResult {
  const root = path.resolve(input.projectRoot);
  const candidate = path.isAbsolute(input.candidatePath)
    ? path.resolve(input.candidatePath)
    : path.resolve(root, input.candidatePath);
  const normalizedCandidate = path.normalize(candidate);
  const rel = path.relative(root, normalizedCandidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { allowed: false, resolvedPath: normalizedCandidate, reason: "path escapes project root" };
  }
  return { allowed: true, resolvedPath: normalizedCandidate, reason: "ok" };
}

const CHECK_ALLOWLIST = new Set([
  "typecheck",
  "tests",
  "test",
  "build",
  "lint",
  "format",
  "format:check",
  "fmt",
  "pnpm typecheck",
  "pnpm test",
  "pnpm build",
  "pnpm lint",
]);

export function isCheckAllowed(name: string): boolean {
  const trimmed = name.trim().toLowerCase();
  return CHECK_ALLOWLIST.has(trimmed);
}

export function listAllowlistedChecks(): string[] {
  return Array.from(CHECK_ALLOWLIST);
}

const SHELL_DENY_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bsudo\b/i,
  /\bcurl\s+[^|]*\|\s*sh\b/i,
  /\bwget\s+[^|]*\|\s*sh\b/i,
  />\s*\/dev\//i,
  /:\(\)\s*\{/,
  /\bdd\s+if=/i,
];

export function isShellCommandSafe(command: string): { safe: boolean; reason: string } {
  for (const pattern of SHELL_DENY_PATTERNS) {
    if (pattern.test(command)) {
      return { safe: false, reason: `command matches denylist pattern ${pattern.source}` };
    }
  }
  return { safe: true, reason: "ok" };
}
