import { readFile, stat } from "node:fs/promises";

const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/;
const PROTECTED_ENVIRONMENT_NAMES = new Set([
  "HOME",
  "LOGNAME",
  "PATH",
  "SHELL",
  "USER",
  "XDG_RUNTIME_DIR",
  "AI_WORKBENCH_API_URL",
  "AI_WORKBENCH_EXECUTION_ID",
  "AI_WORKBENCH_PROJECT_ID",
  "AI_WORKBENCH_SECRET_FILE",
  "AI_WORKBENCH_SESSION_ID",
  "AI_WORKBENCH_TASK_ID",
]);

export function isProtectedWorkflowEnvironmentReference(name: string): boolean {
  return PROTECTED_ENVIRONMENT_NAMES.has(name);
}

export interface SecretProvider {
  resolve(names: string[]): Promise<Record<string, string>>;
}

export class SecretResolutionError extends Error {
  readonly code: "provider_unavailable" | "provider_permissions" | "invalid_reference" | "missing_reference";

  constructor(
    code: "provider_unavailable" | "provider_permissions" | "invalid_reference" | "missing_reference",
    message: string
  ) {
    super(message);
    this.name = "SecretResolutionError";
    this.code = code;
  }
}

function parseSecretEnvironmentFile(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new SecretResolutionError(
        "provider_unavailable",
        `secret provider contains an invalid entry at line ${index + 1}`
      );
    }
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1);
    if (!SECRET_NAME.test(name)) {
      throw new SecretResolutionError(
        "invalid_reference",
        `secret provider contains an invalid reference name at line ${index + 1}`
      );
    }
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value.includes("\0")) {
      throw new SecretResolutionError(
        "provider_unavailable",
        `secret provider contains an invalid value at line ${index + 1}`
      );
    }
    values.set(name, value);
  }
  return values;
}

export function createFileSecretProvider(
  filePath: string | null = process.env.AI_WORKBENCH_SECRET_FILE ?? null
): SecretProvider {
  return {
    async resolve(names) {
      if (names.length === 0) return {};
      if (!filePath) {
        throw new SecretResolutionError("provider_unavailable", "approved secret provider is not configured");
      }
      const info = await stat(filePath).catch(() => null);
      if (!info?.isFile()) {
        throw new SecretResolutionError("provider_unavailable", "approved secret provider is unavailable");
      }
      if ((info.mode & 0o077) !== 0) {
        throw new SecretResolutionError(
          "provider_permissions",
          "approved secret provider must have mode 0600 or stricter"
        );
      }
      if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
        throw new SecretResolutionError(
          "provider_permissions",
          "approved secret provider must be owned by the Workbench user"
        );
      }
      const available = parseSecretEnvironmentFile(await readFile(filePath, "utf8"));
      const resolved: Record<string, string> = {};
      for (const name of names) {
        if (!SECRET_NAME.test(name)) {
          throw new SecretResolutionError("invalid_reference", `invalid secret reference: ${name}`);
        }
        const value = available.get(name);
        if (value === undefined) {
          throw new SecretResolutionError("missing_reference", `approved secret reference is unavailable: ${name}`);
        }
        resolved[name] = value;
      }
      return resolved;
    },
  };
}

export async function resolveManifestWorkflowEnvironment(input: {
  requestedRefs: string[];
  approvedRefs: string[];
  provider?: SecretProvider;
}): Promise<Record<string, string>> {
  const approved = new Set(input.approvedRefs);
  const requested = [...new Set(input.requestedRefs)];
  const protectedName = requested.find(isProtectedWorkflowEnvironmentReference);
  if (protectedName) {
    throw new SecretResolutionError(
      "invalid_reference",
      `secret reference cannot override protected workflow environment: ${protectedName}`
    );
  }
  const unapproved = requested.find((name) => !approved.has(name));
  if (unapproved) {
    throw new SecretResolutionError(
      "invalid_reference",
      `secret reference is not approved by the manifest: ${unapproved}`
    );
  }
  return (input.provider ?? createFileSecretProvider()).resolve(requested);
}
