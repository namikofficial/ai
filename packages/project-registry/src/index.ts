import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProjectManifest } from "../../contracts/src/index.ts";
import { CONTROL_PLANE_SCHEMA_VERSION, projectManifestSchema } from "../../contracts/src/index.ts";
import type { ActiveProjectSelection, ProjectRegistryRepo } from "../../db/src/repositories/project-registry.ts";

export interface RegistryCache {
  schemaVersion: 1;
  generatedAt: string;
  selection: ActiveProjectSelection | null;
  projects: Array<{
    id: string;
    name: string;
    path: string;
    repositoryRoot: string;
    aliases: string[];
    packageManager: string;
    tmuxSession: string | null;
  }>;
}

export interface ManifestDiffEntry {
  path: string;
  before: unknown;
  after: unknown;
}

export const CONFIG_PRECEDENCE = [
  "manual_override",
  "persisted_workbench",
  "approved_project_local",
  "imported_legacy",
  "automatic_detection",
] as const;
export type RegistryConfigSource = (typeof CONFIG_PRECEDENCE)[number];

export function compareConfigPrecedence(left: RegistryConfigSource, right: RegistryConfigSource): number {
  return CONFIG_PRECEDENCE.indexOf(left) - CONFIG_PRECEDENCE.indexOf(right);
}

function stableValue(value: unknown): string {
  return JSON.stringify(value);
}

export function diffProjectManifests(before: ProjectManifest | null, after: ProjectManifest): ManifestDiffEntry[] {
  if (!before) return [{ path: "$", before: null, after }];
  const changes: ManifestDiffEntry[] = [];
  const visit = (left: unknown, right: unknown, path: string): void => {
    if (stableValue(left) === stableValue(right)) return;
    if (
      left !== null &&
      right !== null &&
      typeof left === "object" &&
      typeof right === "object" &&
      !Array.isArray(left) &&
      !Array.isArray(right)
    ) {
      const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
      for (const key of [...keys].sort()) {
        visit((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], `${path}.${key}`);
      }
      return;
    }
    changes.push({ path, before: left, after: right });
  };
  visit(before, after, "$");
  return changes;
}

export function defaultRegistryCachePath(env: Record<string, string | undefined> = process.env): string {
  const cacheRoot = env.XDG_CACHE_HOME ?? (env.HOME ? join(env.HOME, ".cache") : join(process.cwd(), ".cache"));
  return join(cacheRoot, "ai-workbench", "project-registry-v1.json");
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.argv[0]?.replaceAll("/", "-") ?? "workbench"}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
  await rename(temporary, path);
}

export function buildRegistryCache(
  manifests: ProjectManifest[],
  selection: ActiveProjectSelection | null,
  generatedAt = new Date().toISOString()
): RegistryCache {
  return {
    schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
    generatedAt,
    selection,
    projects: manifests.map((manifest) => ({
      id: manifest.id,
      name: manifest.name,
      path: manifest.path,
      repositoryRoot: manifest.repositoryRoot,
      aliases: manifest.detection.aliases,
      packageManager: manifest.packageManager,
      tmuxSession: manifest.desktop.tmuxSession,
    })),
  };
}

export async function refreshRegistryCache(
  registry: ProjectRegistryRepo,
  path = defaultRegistryCachePath()
): Promise<RegistryCache> {
  const cache = buildRegistryCache(registry.listManifests(), registry.getSelection());
  await atomicWriteJson(path, cache);
  return cache;
}

export async function readRegistryCache(path = defaultRegistryCachePath()): Promise<RegistryCache | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as RegistryCache;
    return parsed.schemaVersion === CONTROL_PLANE_SCHEMA_VERSION && Array.isArray(parsed.projects) ? parsed : null;
  } catch {
    return null;
  }
}

export async function readProjectLocalManifest(projectRoot: string): Promise<{
  path: string | null;
  manifest: ProjectManifest | null;
  error: string | null;
}> {
  const candidates = [".ai-workbench-manifest.json", "workbench.project.json"];
  for (const name of candidates) {
    const path = join(projectRoot, name);
    try {
      return { path, manifest: projectManifestSchema.parse(JSON.parse(await readFile(path, "utf8"))), error: null };
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT") continue;
      return { path, manifest: null, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { path: null, manifest: null, error: null };
}

function sqliteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function integrityResult(db: DatabaseSync): string {
  const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
  return row?.integrity_check ?? "unknown";
}

export async function createWorkbenchBackup(
  db: DatabaseSync,
  destination: string
): Promise<{ path: string; createdAt: string; integrity: string; migrations: string[] }> {
  const backupPath = resolve(destination);
  await mkdir(dirname(backupPath), { recursive: true });
  db.exec(`VACUUM INTO ${sqliteString(backupPath)}`);
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  try {
    const integrity = integrityResult(backup);
    if (integrity !== "ok") throw new Error(`backup integrity check failed: ${integrity}`);
    const migrations = (
      backup.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: string }>
    ).map((row) => row.version);
    const result = { path: backupPath, createdAt: new Date().toISOString(), integrity, migrations };
    await atomicWriteJson(`${backupPath}.metadata.json`, result);
    return result;
  } finally {
    backup.close();
  }
}

export function validateWorkbenchBackup(path: string): { integrity: string; migrations: string[] } {
  const backup = new DatabaseSync(resolve(path), { readOnly: true });
  try {
    const integrity = integrityResult(backup);
    const migrations = (
      backup.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: string }>
    ).map((row) => row.version);
    return { integrity, migrations };
  } finally {
    backup.close();
  }
}

export async function restoreWorkbenchBackup(input: {
  backupPath: string;
  destination: string;
  preRestoreBackupPath?: string;
}): Promise<{
  restoredAt: string;
  source: { path: string; integrity: string; migrations: string[] };
  destination: string;
  preRestoreBackup: { path: string; createdAt: string; integrity: string; migrations: string[] } | null;
  restored: { integrity: string; migrations: string[] };
  removedSidecars: string[];
}> {
  const backupPath = resolve(input.backupPath);
  const destination = resolve(input.destination);
  if (backupPath === destination) throw new Error("backup and restore destination must be different files");
  const sourceInfo = await lstat(backupPath);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
    throw new Error(`backup must be a regular non-symlink file: ${backupPath}`);
  }
  const sourceValidation = validateWorkbenchBackup(backupPath);
  if (sourceValidation.integrity !== "ok") {
    throw new Error(`backup integrity check failed: ${sourceValidation.integrity}`);
  }
  await mkdir(dirname(destination), { recursive: true });
  let preRestoreBackup: Awaited<ReturnType<typeof createWorkbenchBackup>> | null = null;
  try {
    const destinationInfo = await lstat(destination);
    if (!destinationInfo.isFile() || destinationInfo.isSymbolicLink()) {
      throw new Error(`restore destination must be a regular non-symlink file: ${destination}`);
    }
    const current = new DatabaseSync(destination);
    try {
      preRestoreBackup = await createWorkbenchBackup(
        current,
        input.preRestoreBackupPath ?? `${destination}.pre-restore-${Date.now().toString()}.backup`
      );
    } finally {
      current.close();
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT")) throw error;
  }
  const temporary = `${destination}.restore-${randomUUID()}.tmp`;
  const removedSidecars: string[] = [];
  try {
    await copyFile(backupPath, temporary);
    const restored = validateWorkbenchBackup(temporary);
    if (restored.integrity !== "ok") throw new Error(`restored copy integrity check failed: ${restored.integrity}`);
    for (const sidecar of [`${destination}-wal`, `${destination}-shm`]) {
      try {
        await rm(sidecar);
        removedSidecars.push(sidecar);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT")) throw error;
      }
    }
    await rename(temporary, destination);
    const result = {
      restoredAt: new Date().toISOString(),
      source: { path: backupPath, ...sourceValidation },
      destination,
      preRestoreBackup,
      restored,
      removedSidecars,
    };
    await atomicWriteJson(`${destination}.restore.metadata.json`, result);
    return result;
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function packageManagerFor(path: string, checkCommand: string | null): ProjectManifest["packageManager"] {
  const value = `${path} ${checkCommand ?? ""}`.toLowerCase();
  if (value.includes("pnpm")) return "pnpm";
  if (value.includes("cargo")) return "cargo";
  if (value.includes("poetry")) return "poetry";
  if (value.includes("uv ")) return "uv";
  if (value.includes("gradle")) return "gradle";
  if (value.includes("mvn") || value.includes("maven")) return "maven";
  if (value.includes("just")) return "just";
  if (value.includes("make")) return "make";
  if (value.includes("npm")) return "npm";
  return "unknown";
}

function expandHome(path: string, home: string): string {
  return resolve(path.replace(/^\$HOME(?=\/|$)/, home).replace(/^~(?=\/|$)/, home));
}

function parseCaseMappings(source: string, functionName: string): Map<string, string> {
  const body = source.match(new RegExp(`${functionName}\\(\\) \\{([\\s\\S]*?)\\n\\}`, "m"))?.[1] ?? "";
  const mappings = new Map<string, string>();
  const expression = /^\s*([^\s)]+)\)\s+printf\s+'%s\\n'\s+(?:"([^"]*)"|'([^']*)')/gm;
  for (const match of body.matchAll(expression)) {
    const key = match[1];
    const value = match[2] ?? match[3];
    if (key && value) mappings.set(key, value);
  }
  return mappings;
}

export function importLegacyProjectProfiles(
  source: string,
  options: { home: string; observedAt?: string; sourceRef?: string }
): ProjectManifest[] {
  const profileLine = source.match(/^profiles=\(([^)]*)\)/m)?.[1] ?? "";
  const profiles = profileLine.split(/\s+/).filter(Boolean);
  const paths = parseCaseMappings(source, "path_for");
  const checks = parseCaseMappings(source, "check_cmd_for");
  const devCommands = parseCaseMappings(source, "dev_cmd_for");
  const timestamp = options.observedAt ?? new Date().toISOString();
  return profiles.map((id) => {
    const rawPath = paths.get(id);
    if (!rawPath) throw new Error(`legacy profile ${id} has no path`);
    const path = expandHome(rawPath, options.home);
    const check = checks.get(id) ?? null;
    const commands: ProjectManifest["commands"] = {};
    if (check) {
      commands.check = {
        id: "check",
        name: "Check",
        description: "Imported legacy verification command; approval required before execution",
        category: "check",
        executable: "zsh",
        arguments: ["-lc", check],
        workingDirectory: null,
        environmentRefs: [],
        interactive: false,
        executionMode: "direct",
        mutation: "read_only",
        timeoutSeconds: 900,
        retryLimit: 0,
        retryDelaySeconds: 0,
        expectedArtifacts: [],
        successCriteria: [],
        recoveryWorkflowIds: [],
        requiresCapabilities: ["legacy-shell-approval"],
        visibleWhen: ["approved-import"],
      };
    }
    for (const [key, command] of devCommands) {
      const [profile, pane] = key.split(":");
      if (profile !== id || !pane) continue;
      commands[`dev-${pane}`] = {
        id: `dev-${pane}`,
        name: `Development ${pane}`,
        description: `Imported legacy ${pane} command; approval required before execution`,
        category: "development",
        executable: "zsh",
        arguments: ["-lc", command],
        workingDirectory: null,
        environmentRefs: [],
        interactive: true,
        executionMode: "terminal",
        mutation: "workspace_write",
        timeoutSeconds: null,
        retryLimit: 0,
        retryDelaySeconds: 0,
        expectedArtifacts: [],
        successCriteria: [],
        recoveryWorkflowIds: [],
        requiresCapabilities: ["legacy-shell-approval"],
        visibleWhen: ["approved-import"],
      };
    }
    return projectManifestSchema.parse({
      schemaVersion: 1,
      id,
      createdAt: timestamp,
      updatedAt: timestamp,
      origin: { source: "legacy", instanceId: "project-profile", legacyRef: options.sourceRef ?? null },
      capabilities: ["legacy-import"],
      name: id
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" "),
      path,
      kind: id === "dotfiles" ? "dotfiles" : "repository",
      repositoryRoot: path,
      workspaceRoots: [],
      packageManager: packageManagerFor(path, check),
      applications: [],
      detection: { markers: [], remotes: [], aliases: [id] },
      commands,
      checks: check ? ["check"] : [],
      services: [],
      desktop: {
        tmuxSession: id,
        preferredEditor: "code",
        scratchpads: ["ai"],
        scene: commands["dev-api"] ? "full-development" : null,
      },
      ai: {
        retrievalProfile: null,
        defaultModelRole: "coding",
        boostPaths: [],
        include: [],
        exclude: ["node_modules", ".git"],
        checks: check ? ["check"] : [],
        mcpCapabilities: [],
      },
      secretRefs: [],
      approvedRoots: [path],
    });
  });
}
