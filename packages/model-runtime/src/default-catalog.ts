// Default model provider and profile catalog.
//
// The seed is local-first: a real OpenAI-compatible llama.cpp / llama-swap
// provider is registered by default and the most-used profiles route to it.
// The heuristic profile is kept only as an explicit fallback / mock profile.
//
// Cloud is still gated behind AI_CLOUD_ENABLED=true.
//
// This catalog is the single source of truth used by the DB layer to
// bootstrap a fresh database. Tests and CLI tools that want to start from
// the same defaults import `seedDefaultModelCatalog` from here.

import type {
  ModelProfileRecord,
  ModelProviderKind,
  ModelProviderRecord,
  ModelRole,
} from "../../shared/src/index.ts";

export interface DefaultProviderInput {
  id: string;
  kind: ModelProviderKind;
  displayName: string;
  baseUrl: string | null;
  apiKeyEnv: string | null;
  enabled: boolean;
}

export interface DefaultEnvOverrides {
  localBaseUrl?: string;
  modelFast?: string;
  modelDeep?: string;
  modelCoder?: string;
  embeddingModel?: string;
}

function readEnvOverrides(env: NodeJS.ProcessEnv = process.env): DefaultEnvOverrides {
  return {
    localBaseUrl:
      env.AI_LOCAL_BASE_URL && env.AI_LOCAL_BASE_URL.length > 0 ? env.AI_LOCAL_BASE_URL : undefined,
    modelFast:
      env.AI_LOCAL_MODEL_FAST && env.AI_LOCAL_MODEL_FAST.length > 0
        ? env.AI_LOCAL_MODEL_FAST
        : undefined,
    modelDeep:
      env.AI_LOCAL_MODEL_DEEP && env.AI_LOCAL_MODEL_DEEP.length > 0
        ? env.AI_LOCAL_MODEL_DEEP
        : undefined,
    modelCoder:
      env.AI_LOCAL_MODEL_CODER && env.AI_LOCAL_MODEL_CODER.length > 0
        ? env.AI_LOCAL_MODEL_CODER
        : undefined,
    embeddingModel:
      env.AI_LOCAL_EMBEDDING_MODEL && env.AI_LOCAL_EMBEDDING_MODEL.length > 0
        ? env.AI_LOCAL_EMBEDDING_MODEL
        : undefined,
  };
}

export const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:8080/v1";
export const DEFAULT_FAST_MODEL = "qwen2.5-coder:7b";
export const DEFAULT_DEEP_MODEL = "qwen2.5-coder:14b";
export const DEFAULT_CODER_MODEL = "qwen2.5-coder:14b";
export const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text";

export const DEFAULT_PROVIDER_ROWS: DefaultProviderInput[] = [
  {
    id: "provider_llamacpp_local",
    kind: "local_openai_compat",
    displayName: "Local llama.cpp (OpenAI-compatible)",
    baseUrl: DEFAULT_LOCAL_BASE_URL,
    apiKeyEnv: null,
    enabled: true,
  },
  {
    id: "provider_heuristic_local",
    kind: "heuristic",
    displayName: "Heuristic fallback (mock only)",
    baseUrl: null,
    apiKeyEnv: null,
    enabled: true,
  },
  {
    id: "provider_cloud_openai_compat",
    kind: "cloud_openai_compat",
    displayName: "Cloud OpenAI-compatible",
    baseUrl: null,
    apiKeyEnv: "AI_CLOUD_API_KEY",
    enabled: false,
  },
];

export interface DefaultProfileInput {
  id: string;
  providerId: string;
  role: ModelRole;
  modelName: string;
  displayName: string;
  localOnly?: boolean;
  enabled?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  qualityScore?: number;
  latencyScore?: number;
}

export function buildDefaultProfileRows(
  env: NodeJS.ProcessEnv = process.env
): DefaultProfileInput[] {
  const overrides = readEnvOverrides(env);
  const fastModel = overrides.modelFast ?? DEFAULT_FAST_MODEL;
  const deepModel = overrides.modelDeep ?? DEFAULT_DEEP_MODEL;
  const coderModel = overrides.modelCoder ?? DEFAULT_CODER_MODEL;
  const embeddingModel = overrides.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
  const local = "provider_llamacpp_local";
  return [
    {
      id: "intent-local",
      providerId: local,
      role: "intent",
      modelName: fastModel,
      displayName: "Intent classifier (local)",
    },
    {
      id: "query-rewrite-local",
      providerId: local,
      role: "query_rewrite",
      modelName: fastModel,
      displayName: "Query rewriter (local)",
    },
    {
      id: "retrieval-judge-local",
      providerId: local,
      role: "retrieval_judge",
      modelName: fastModel,
      displayName: "Retrieval judge (local)",
    },
    {
      id: "reranker-local",
      providerId: local,
      role: "reranker",
      modelName: fastModel,
      displayName: "Reranker (local)",
    },
    {
      id: "embedding-local",
      providerId: local,
      role: "embedding",
      modelName: embeddingModel,
      displayName: "Embedding (local)",
    },
    {
      id: "summarizer-local",
      providerId: local,
      role: "summarizer",
      modelName: fastModel,
      displayName: "Summarizer (local)",
    },
    {
      id: "reviewer-local",
      providerId: local,
      role: "reviewer",
      modelName: fastModel,
      displayName: "Reviewer (local)",
    },
    {
      id: "reflection-local",
      providerId: local,
      role: "reflection",
      modelName: deepModel,
      displayName: "Reflection (local)",
    },
    {
      id: "indexer-local",
      providerId: local,
      role: "embedding",
      modelName: embeddingModel,
      displayName: "Indexer (local)",
    },
    {
      id: "ask-fast-local",
      providerId: local,
      role: "answer",
      modelName: fastModel,
      displayName: "Fast answer (local)",
    },
    {
      id: "ask-extended-local",
      providerId: local,
      role: "answer",
      modelName: deepModel,
      displayName: "Extended answer (local)",
      contextWindow: 16_384,
      maxOutputTokens: 4_096,
    },
    {
      id: "ask-deep-local",
      providerId: local,
      role: "answer",
      modelName: deepModel,
      displayName: "Deep answer (local)",
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
    },
    {
      id: "ask-hybrid-router",
      providerId: local,
      role: "answer",
      modelName: fastModel,
      displayName: "Hybrid answer router (local)",
    },
    {
      id: "ask-cloud-router",
      providerId: "provider_cloud_openai_compat",
      role: "answer",
      modelName: "ask-cloud-router",
      displayName: "Cloud answer router",
      localOnly: false,
      enabled: false,
    },
    {
      id: "planner-fast-local",
      providerId: local,
      role: "planner",
      modelName: fastModel,
      displayName: "Fast planner (local)",
    },
    {
      id: "planner-balanced-local",
      providerId: local,
      role: "planner",
      modelName: deepModel,
      displayName: "Balanced planner (local)",
    },
    {
      id: "planner-deep-local",
      providerId: local,
      role: "planner",
      modelName: deepModel,
      displayName: "Deep planner (local)",
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
    },
    {
      id: "handoff-local",
      providerId: local,
      role: "coder_handoff",
      modelName: coderModel,
      displayName: "Handoff compiler (local)",
    },
    {
      id: "checker-local",
      providerId: local,
      role: "reviewer",
      modelName: fastModel,
      displayName: "Check summarizer (local)",
    },
    {
      id: "dev-editor-local",
      providerId: local,
      role: "coder_handoff",
      modelName: coderModel,
      displayName: "Dev editor (local)",
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
    },
    {
      id: "dev-repair-local",
      providerId: local,
      role: "coder_handoff",
      modelName: coderModel,
      displayName: "Dev repair (local)",
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
    },
    // Heuristic-only fallback. Kept disabled by default; only used by tests
    // and explicit CLI flags that want a deterministic mock model.
    {
      id: "heuristic-fallback",
      providerId: "provider_heuristic_local",
      role: "answer",
      modelName: "heuristic",
      displayName: "Heuristic fallback (mock)",
      enabled: false,
    },
  ];
}

export const DEFAULT_PROFILE_ROWS: DefaultProfileInput[] = buildDefaultProfileRows();

export function buildDefaultProvider(
  provider: DefaultProviderInput,
  baseUrl?: string
): ModelProviderRecord {
  const ts = new Date().toISOString();
  return {
    id: provider.id,
    kind: provider.kind,
    displayName: provider.displayName,
    baseUrl:
      provider.id === "provider_llamacpp_local" ? (baseUrl ?? provider.baseUrl) : provider.baseUrl,
    apiKeyEnv: provider.apiKeyEnv,
    enabled: provider.enabled,
    createdAt: ts,
    updatedAt: ts,
  };
}

export function buildDefaultProfile(profile: DefaultProfileInput): ModelProfileRecord {
  const ts = new Date().toISOString();
  const isDeep = profile.id.includes("deep");
  const isExtended = profile.id.includes("extended") || profile.contextWindow === 16_384;
  const isCloud = profile.localOnly === false;
  const contextWindow = profile.contextWindow ?? (isDeep ? 32_768 : isExtended ? 16_384 : 8_192);
  const maxOutputTokens = profile.maxOutputTokens ?? (isDeep ? 4_096 : 2_048);
  return {
    id: profile.id,
    providerId: profile.providerId,
    role: profile.role,
    modelName: profile.modelName,
    displayName: profile.displayName,
    contextWindow,
    maxOutputTokens,
    localOnly: profile.localOnly !== false,
    enabled: profile.enabled !== false,
    fallbackProfileId: null,
    qualityScore:
      profile.qualityScore ??
      (profile.role === "planner"
        ? 0.7
        : profile.role === "answer"
          ? 0.65
          : profile.role === "coder_handoff"
            ? 0.7
            : 0.6),
    latencyScore: profile.latencyScore ?? (profile.role === "embedding" ? 0.8 : 0.7),
    costScore: isCloud ? 0.2 : 0.9,
    meta: {},
    createdAt: ts,
    updatedAt: ts,
  };
}

export interface ModelCatalogRepo {
  listProviders(): ModelProviderRecord[];
  listProfiles(): ModelProfileRecord[];
  upsertProvider(provider: ModelProviderRecord): void;
  upsertProfile(profile: ModelProfileRecord): void;
}

export function seedDefaultModelCatalog(
  repo: ModelCatalogRepo,
  env: NodeJS.ProcessEnv = process.env
): { providersAdded: number; profilesAdded: number; skipped: boolean; localBaseUrl: string } {
  const overrides = readEnvOverrides(env);
  const localBaseUrl = overrides.localBaseUrl ?? DEFAULT_LOCAL_BASE_URL;
  const existing = repo.listProfiles();
  if (existing.length > 0) {
    return { providersAdded: 0, profilesAdded: 0, skipped: true, localBaseUrl };
  }
  for (const provider of DEFAULT_PROVIDER_ROWS) {
    repo.upsertProvider(buildDefaultProvider(provider, localBaseUrl));
  }
  const profiles = buildDefaultProfileRows(env);
  for (const profile of profiles) {
    repo.upsertProfile(buildDefaultProfile(profile));
  }
  return {
    providersAdded: DEFAULT_PROVIDER_ROWS.length,
    profilesAdded: profiles.length,
    skipped: false,
    localBaseUrl,
  };
}
