import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readEmbeddingConfig } from "../../indexer/src/index.ts";
import type { ConfigSnapshot } from "../../shared/src/index.ts";

export interface EmbeddingConfig {
  providerId: string;
  modelName: string;
  dimensions: number;
  expectedCollection: string;
}

export interface ChecksConfig {
  defaultChecks: string[];
  requireApprovalFor: string[];
  maxRepairLoops: number;
}

export interface DevConfig {
  defaultChecks: string[];
  maxRepairLoops: number;
  requireApprovalFor: string[];
}

export interface ProjectConfig {
  sourcePath: string | null;
  ignore: string[];
  include: string[];
  chunking: {
    preferTreeSitter: boolean;
    maxChunkTokens: number;
  };
  codeIntelligence: {
    enabled: boolean;
  };
  retrieval: {
    boostPaths: string[];
    authHints: string[];
  };
  models: {
    answer: string | null;
    embedding: string | null;
  };
  checks: ChecksConfig;
  dev: DevConfig;
  raw: Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(readString).filter((item): item is string => item != null) : [];
}

function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(path, { encoding: "utf8" });
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function readProjectConfigObject(projectPath: string): { path: string; value: Record<string, unknown> } | null {
  const candidates = [".ai-workbench.json", ".ai-workbench", ".aiconfig"];
  for (const name of candidates) {
    const filePath = join(projectPath, name);
    const parsed = readJsonObject(filePath);
    if (parsed) return { path: filePath, value: parsed };
  }
  return null;
}

function compileGlobPattern(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/").trim();
  let regex = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    const next = normalized[index + 1] ?? "";
    if (char === "*" && next === "*") {
      regex += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      regex += "[^/]*";
      continue;
    }
    if (/[.+^${}()|[\]\\?]/.test(char)) {
      regex += `\\${char}`;
      continue;
    }
    regex += char;
  }
  regex += "$";
  return new RegExp(regex);
}

function createGlobMatcher(patterns: string[]): (value: string) => boolean {
  const regexes = patterns.map(compileGlobPattern);
  return (value: string) => {
    const normalized = value.replaceAll("\\", "/").replace(/^\.?\//, "");
    return regexes.some((regex) => regex.test(normalized));
  };
}

export function resolveEmbeddingConfig(): EmbeddingConfig {
  const embedding = readEmbeddingConfig({ env: process.env });
  const expectedCollection = process.env.AI_QDRANT_COLLECTION ?? "ai_chunks";
  return {
    providerId: embedding.provider,
    modelName: embedding.model,
    dimensions: embedding.dimension,
    expectedCollection,
  };
}

export function resolveConfig(overrides: Partial<ConfigSnapshot> = {}): ConfigSnapshot {
  const cwd = process.cwd();
  const envDatabasePath = process.env.AI_DATABASE_PATH;
  const envRuntimeDir = process.env.AI_RUNTIME_DIR;
  const envApiPort = process.env.AI_API_PORT ? Number(process.env.AI_API_PORT) : null;
  const envWebPort = process.env.AI_WEB_PORT ? Number(process.env.AI_WEB_PORT) : null;
  const envApiUrl = process.env.AI_API_URL;
  const envCloudEnabled = /^(1|true|yes)$/i.test(process.env.AI_CLOUD_ENABLED ?? "");
  const envQdrantEnabled = /^(1|true|yes)$/i.test(process.env.AI_QDRANT_ENABLED ?? "");
  const envQdrantUrl = process.env.AI_QDRANT_URL ?? null;
  const envQdrantCollection = process.env.AI_QDRANT_COLLECTION ?? "ai_chunks";
  const apiPort = overrides.apiPort ?? 4242;
  const qdrantEnabled = overrides.qdrantEnabled ?? envQdrantEnabled;
  return {
    databasePath: overrides.databasePath ?? envDatabasePath ?? `${cwd}/runtime/ai.db`,
    runtimeDir: overrides.runtimeDir ?? envRuntimeDir ?? `${cwd}/runtime`,
    apiUrl: overrides.apiUrl ?? envApiUrl ?? `http://127.0.0.1:${envApiPort ?? apiPort}`,
    webPort: overrides.webPort ?? envWebPort ?? 3000,
    apiPort: overrides.apiPort ?? envApiPort ?? apiPort,
    cloudEnabled: overrides.cloudEnabled ?? envCloudEnabled,
    qdrantEnabled,
    qdrantUrl: overrides.qdrantUrl ?? envQdrantUrl ?? (qdrantEnabled ? "http://127.0.0.1:6333" : null),
    qdrantCollection: overrides.qdrantCollection ?? envQdrantCollection,
  };
}

export function resolveProjectConfig(projectPath: string): ProjectConfig {
  const loaded = readProjectConfigObject(projectPath);
  const raw = loaded?.value ?? {};
  const hasConfig = loaded != null;
  return {
    sourcePath: loaded?.path ?? null,
    ignore: hasConfig ? readStringArray(raw.ignore ?? ["dist/**", "coverage/**"]) : [],
    include: hasConfig ? readStringArray(raw.include ?? ["apps/**", "packages/**"]) : [],
    chunking: {
      preferTreeSitter: hasConfig
        ? readBoolean((raw.chunking as Record<string, unknown> | undefined)?.preferTreeSitter, true)
        : true,
      maxChunkTokens: hasConfig
        ? readNumber((raw.chunking as Record<string, unknown> | undefined)?.maxChunkTokens, 900)
        : 900,
    },
    codeIntelligence: {
      enabled: hasConfig
        ? readBoolean((raw.codeIntelligence as Record<string, unknown> | undefined)?.enabled, false)
        : false,
    },
    retrieval: {
      boostPaths: hasConfig
        ? readStringArray(
            (raw.retrieval as Record<string, unknown> | undefined)?.boostPaths ?? ["apps/api/**", "packages/**"]
          )
        : [],
      authHints: hasConfig
        ? readStringArray(
            (raw.retrieval as Record<string, unknown> | undefined)?.authHints ?? ["auth", "session", "jwt", "tenant"]
          )
        : [],
    },
    models: {
      answer: hasConfig ? readString((raw.models as Record<string, unknown> | undefined)?.answer) : null,
      embedding: hasConfig ? readString((raw.models as Record<string, unknown> | undefined)?.embedding) : null,
    },
    checks: {
      defaultChecks: hasConfig
        ? readStringArray((raw.checks as Record<string, unknown> | undefined)?.defaultChecks ?? ["typecheck"])
        : ["typecheck"],
      requireApprovalFor: hasConfig
        ? readStringArray((raw.checks as Record<string, unknown> | undefined)?.requireApprovalFor ?? [])
        : [],
      maxRepairLoops: hasConfig
        ? readNumber((raw.checks as Record<string, unknown> | undefined)?.maxRepairLoops, 1)
        : 1,
    },
    dev: {
      defaultChecks: hasConfig
        ? readStringArray((raw.dev as Record<string, unknown> | undefined)?.defaultChecks ?? ["typecheck"])
        : ["typecheck"],
      maxRepairLoops: hasConfig
        ? readNumber((raw.dev as Record<string, unknown> | undefined)?.maxRepairLoops, 1)
        : 1,
      requireApprovalFor: hasConfig
        ? readStringArray((raw.dev as Record<string, unknown> | undefined)?.requireApprovalFor ?? ["env", "migrations", "auth", "db", "package"])
        : ["env", "migrations", "auth", "db", "package"],
    },
    raw,
  };
}

export function projectPathMatchesConfig(path: string, config: ProjectConfig): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.?\//, "");
  const matchesInclude = config.include.length === 0 || createGlobMatcher(config.include)(normalized);
  const matchesIgnore = config.ignore.length > 0 && createGlobMatcher(config.ignore)(normalized);
  return matchesInclude && !matchesIgnore;
}

export function boostWeightForPath(path: string, config: ProjectConfig): number {
  const normalized = path.replaceAll("\\", "/").replace(/^\.?\//, "");
  const matcher = createGlobMatcher(config.retrieval.boostPaths);
  return matcher(normalized) ? 1 : 0;
}
