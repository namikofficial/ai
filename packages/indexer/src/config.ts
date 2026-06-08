// Embedding configuration helpers.
//
// Centralizes the AI_EMBEDDING_* env knobs so the rest of the system can
// stay provider-agnostic. The defaults match the existing heuristic
// provider so behavior is preserved when no env override is supplied.

import { isCloudProviderKind } from "../../safety/src/index.ts";

export interface EmbeddingConfig {
  provider: "heuristic" | "llama_cpp" | "fastembed" | "openai_compat" | "mock";
  model: string;
  dimension: number;
  batchSize: number;
  cloudEnabled: boolean;
}

export interface EmbeddingConfigInput {
  env?: Record<string, string | undefined>;
  cloudEnabled?: boolean;
}

const KNOWN_PROVIDERS = new Set(["heuristic", "llama_cpp", "fastembed", "openai_compat", "mock"]);

function readString(
  env: Record<string, string | undefined>,
  key: string,
  fallback: string
): string {
  const raw = env[key];
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? fallback : trimmed;
}

function readNumber(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number
): number {
  const raw = env[key];
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function readBool(
  env: Record<string, string | undefined>,
  key: string,
  fallback: boolean
): boolean {
  const raw = env[key];
  if (typeof raw !== "string") return fallback;
  return /^(1|true|yes)$/i.test(raw);
}

export function readEmbeddingConfig(input: EmbeddingConfigInput = {}): EmbeddingConfig {
  const env = input.env ?? process.env;
  const cloudEnabled = input.cloudEnabled ?? readBool(env, "AI_CLOUD_ENABLED", false);
  const providerRaw = readString(env, "AI_EMBEDDING_PROVIDER", "heuristic").toLowerCase();
  const provider = KNOWN_PROVIDERS.has(providerRaw)
    ? (providerRaw as EmbeddingConfig["provider"])
    : "heuristic";
  if (isCloudProviderKind(provider) && !cloudEnabled) {
    // Cloud embeddings are explicitly disabled until cloud is enabled.
    return {
      provider: "heuristic",
      model: readString(env, "AI_EMBEDDING_MODEL", "heuristic-embedding"),
      dimension: readNumber(env, "AI_EMBEDDING_DIM", 32),
      batchSize: readNumber(env, "AI_EMBEDDING_BATCH_SIZE", 32),
      cloudEnabled,
    };
  }
  return {
    provider,
    model: readString(env, "AI_EMBEDDING_MODEL", defaultModelForProvider(provider)),
    dimension: readNumber(env, "AI_EMBEDDING_DIM", defaultDimensionForProvider(provider)),
    batchSize: readNumber(env, "AI_EMBEDDING_BATCH_SIZE", 32),
    cloudEnabled,
  };
}

export function defaultModelForProvider(provider: EmbeddingConfig["provider"]): string {
  switch (provider) {
    case "llama_cpp":
      return "llama.cpp-embedding";
    case "fastembed":
      return "fastembed-default";
    case "openai_compat":
      return "openai-compat-embedding";
    case "mock":
      return "mock-embedding";
    case "heuristic":
    default:
      return "heuristic-embedding";
  }
}

export function defaultDimensionForProvider(provider: EmbeddingConfig["provider"]): number {
  switch (provider) {
    case "llama_cpp":
      return 384;
    case "fastembed":
      return 384;
    case "openai_compat":
      return 1536;
    case "mock":
      return 4;
    case "heuristic":
    default:
      return 32;
  }
}

export function collectionNameForEmbedding(config: EmbeddingConfig, baseName: string): string {
  const safeBase = baseName.replace(/[^a-z0-9_-]+/gi, "_") || "ai_chunks";
  return `${safeBase}_${config.provider}_${config.dimension}`;
}
