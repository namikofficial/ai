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

import type { ModelProfileRecord, ModelProviderKind, ModelProviderRecord, ModelRole } from "../../shared/src/index.ts";

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
  embeddingBaseUrl?: string;
  modelFast?: string;
  modelFast2?: string;
  modelDeep?: string;
  modelCoder?: string;
  modelReasoner?: string;
  modelRouter?: string;
  modelTiny?: string;
  modelTiny2?: string;
  embeddingModel?: string;
  embeddingDimension?: number;
}

function readEnvOverrides(env: NodeJS.ProcessEnv = process.env): DefaultEnvOverrides {
  return {
    localBaseUrl: env.AI_LOCAL_BASE_URL && env.AI_LOCAL_BASE_URL.length > 0 ? env.AI_LOCAL_BASE_URL : undefined,
    embeddingBaseUrl:
      env.AI_EMBEDDING_BASE_URL && env.AI_EMBEDDING_BASE_URL.length > 0 ? env.AI_EMBEDDING_BASE_URL : undefined,
    modelFast: env.AI_LOCAL_MODEL_FAST && env.AI_LOCAL_MODEL_FAST.length > 0 ? env.AI_LOCAL_MODEL_FAST : undefined,
    modelFast2: env.AI_LOCAL_MODEL_FAST2 && env.AI_LOCAL_MODEL_FAST2.length > 0 ? env.AI_LOCAL_MODEL_FAST2 : undefined,
    modelDeep: env.AI_LOCAL_MODEL_DEEP && env.AI_LOCAL_MODEL_DEEP.length > 0 ? env.AI_LOCAL_MODEL_DEEP : undefined,
    modelCoder: env.AI_LOCAL_MODEL_CODER && env.AI_LOCAL_MODEL_CODER.length > 0 ? env.AI_LOCAL_MODEL_CODER : undefined,
    modelReasoner:
      env.AI_LOCAL_MODEL_REASONER && env.AI_LOCAL_MODEL_REASONER.length > 0 ? env.AI_LOCAL_MODEL_REASONER : undefined,
    modelRouter:
      env.AI_LOCAL_MODEL_ROUTER && env.AI_LOCAL_MODEL_ROUTER.length > 0 ? env.AI_LOCAL_MODEL_ROUTER : undefined,
    modelTiny: env.AI_LOCAL_MODEL_TINY && env.AI_LOCAL_MODEL_TINY.length > 0 ? env.AI_LOCAL_MODEL_TINY : undefined,
    modelTiny2: env.AI_LOCAL_MODEL_TINY2 && env.AI_LOCAL_MODEL_TINY2.length > 0 ? env.AI_LOCAL_MODEL_TINY2 : undefined,
    embeddingModel:
      env.AI_LOCAL_EMBEDDING_MODEL && env.AI_LOCAL_EMBEDDING_MODEL.length > 0
        ? env.AI_LOCAL_EMBEDDING_MODEL
        : undefined,
    embeddingDimension:
      env.AI_LOCAL_EMBEDDING_DIM && env.AI_LOCAL_EMBEDDING_DIM.length > 0
        ? Number(env.AI_LOCAL_EMBEDDING_DIM)
        : undefined,
  };
}

export const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:8080/v1";
// Defaults are tuned for the workstation's small/local llama-swap set.
export const DEFAULT_FAST_MODEL = "qwen3-4b-local";
export const DEFAULT_FAST2_MODEL = "qwen3-4b-local";
export const DEFAULT_DEEP_MODEL = "qwen3-4b-local";
export const DEFAULT_CODER_MODEL = "qwen3-4b-local";
export const DEFAULT_REASONER_MODEL = "granite-agent";
export const DEFAULT_ROUTER_MODEL = "qwen3-4b-local";
export const DEFAULT_TINY_MODEL = "qwen3-4b-local";
export const DEFAULT_TINY2_MODEL = "qwen3-4b-local";
export const DEFAULT_EMBEDDING_MODEL = "nomic-text-embed";
export const DEFAULT_EMBEDDING_DIMENSION = 768;

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
    id: "provider_fastembed_local",
    kind: "fastembed",
    displayName: "Local Fastembed (OpenAI-compatible)",
    baseUrl: "http://127.0.0.1:8080/v1",
    apiKeyEnv: null,
    enabled: false,
  },
  {
    id: "provider_llamacpp_embeddings",
    kind: "local_openai_compat",
    displayName: "Local llama.cpp embeddings",
    baseUrl: "http://127.0.0.1:8081/v1",
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

export function buildDefaultProfileRows(env: NodeJS.ProcessEnv = process.env): DefaultProfileInput[] {
  const overrides = readEnvOverrides(env);
  const fastModel = overrides.modelFast ?? DEFAULT_FAST_MODEL;
  const fastModel2 = overrides.modelFast2 ?? DEFAULT_FAST2_MODEL;
  const deepModel = overrides.modelDeep ?? DEFAULT_DEEP_MODEL;
  const coderModel = overrides.modelCoder ?? DEFAULT_CODER_MODEL;
  const reasonerModel = overrides.modelReasoner ?? DEFAULT_REASONER_MODEL;
  const routerModel = overrides.modelRouter ?? DEFAULT_ROUTER_MODEL;
  const tinyModel = overrides.modelTiny ?? DEFAULT_TINY_MODEL;
  const tinyModel2 = overrides.modelTiny2 ?? DEFAULT_TINY2_MODEL;
  const embeddingModel = overrides.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
  const local = "provider_llamacpp_local";
  return [
    // --- tiny / fast models (used for cheap calls) ---
    {
      id: "intent-local",
      providerId: local,
      role: "intent",
      modelName: tinyModel,
      displayName: "Intent classifier (tiny)",
      qualityScore: 0.55,
      latencyScore: 0.95,
    },
    {
      id: "tool-select-local",
      providerId: local,
      role: "tool_select",
      modelName: tinyModel,
      displayName: "Tool selector (tiny)",
      qualityScore: 0.55,
      latencyScore: 0.95,
    },
    {
      id: "file-read-local",
      providerId: local,
      role: "file_read",
      modelName: tinyModel2,
      displayName: "File reader (tiny)",
      qualityScore: 0.55,
      latencyScore: 0.95,
    },
    {
      id: "file-write-local",
      providerId: local,
      role: "file_write",
      modelName: fastModel2,
      displayName: "File writer (small)",
      qualityScore: 0.6,
      latencyScore: 0.9,
    },
    {
      id: "file-edit-local",
      providerId: local,
      role: "file_edit",
      modelName: coderModel,
      displayName: "File editor (coder)",
      qualityScore: 0.7,
      latencyScore: 0.85,
    },
    {
      id: "summarizer-local",
      providerId: local,
      role: "summarizer",
      modelName: tinyModel2,
      displayName: "Summarizer (small)",
      qualityScore: 0.55,
      latencyScore: 0.95,
    },
    {
      id: "query-rewrite-local",
      providerId: local,
      role: "query_rewrite",
      modelName: fastModel2,
      displayName: "Query rewriter (small)",
      qualityScore: 0.6,
      latencyScore: 0.9,
    },
    {
      id: "retrieval-judge-local",
      providerId: local,
      role: "retrieval_judge",
      modelName: fastModel2,
      displayName: "Retrieval judge (small)",
      qualityScore: 0.6,
      latencyScore: 0.9,
    },
    {
      id: "reranker-local",
      providerId: local,
      role: "reranker",
      modelName: tinyModel2,
      displayName: "Reranker (small)",
      qualityScore: 0.5,
      latencyScore: 0.9,
    },
    // --- embeddings ---
    {
      id: "embedding-local",
      providerId: "provider_llamacpp_embeddings",
      role: "embedding",
      modelName: embeddingModel,
      displayName: "Embedding (local)",
    },
    {
      id: "indexer-local",
      providerId: local,
      role: "embedding",
      modelName: embeddingModel,
      displayName: "Indexer embedding (local)",
    },
    // --- fastembed embeddings ---
    {
      id: "embedding-fastembed-local",
      providerId: "provider_fastembed_local",
      role: "embedding",
      modelName: "fastembed-default",
      displayName: "Fastembed embedding (local)",
    },
    // --- reviewers / reflection / checks ---
    {
      id: "reviewer-local",
      providerId: local,
      role: "reviewer",
      modelName: fastModel2,
      displayName: "Reviewer (small)",
    },
    {
      id: "checker-local",
      providerId: local,
      role: "reviewer",
      modelName: fastModel2,
      displayName: "Check summarizer (small)",
    },
    {
      id: "reflection-local",
      providerId: local,
      role: "reflection",
      modelName: deepModel,
      displayName: "Reflection (deep)",
    },
    {
      id: "fact-extract-local",
      providerId: local,
      role: "fact_extract",
      modelName: fastModel2,
      displayName: "Fact extractor (small)",
    },
    // --- answers ---
    {
      id: "ask-fast-local",
      providerId: local,
      role: "answer",
      modelName: fastModel,
      displayName: "Fast answer (small)",
    },
    {
      id: "ask-extended-local",
      providerId: local,
      role: "answer",
      modelName: deepModel,
      displayName: "Extended answer (deep)",
      contextWindow: 16_384,
      maxOutputTokens: 4_096,
    },
    {
      id: "ask-deep-local",
      providerId: local,
      role: "answer",
      modelName: reasonerModel,
      displayName: "Deep reasoning answer (reasoner)",
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
    },
    {
      id: "ask-hybrid-router",
      providerId: local,
      role: "answer",
      modelName: routerModel,
      displayName: "Hybrid answer router (router)",
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
    // --- planners ---
    {
      id: "planner-fast-local",
      providerId: local,
      role: "planner",
      modelName: fastModel2,
      displayName: "Fast planner (small)",
    },
    {
      id: "planner-balanced-local",
      providerId: local,
      role: "planner",
      modelName: deepModel,
      displayName: "Balanced planner (deep)",
    },
    {
      id: "planner-deep-local",
      providerId: local,
      role: "planner",
      modelName: reasonerModel,
      displayName: "Deep planner (reasoner)",
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
    },
    // --- handoffs / dev editing ---
    {
      id: "handoff-local",
      providerId: local,
      role: "coder_handoff",
      modelName: coderModel,
      displayName: "Handoff compiler (coder)",
    },
    {
      id: "dev-editor-local",
      providerId: local,
      role: "coder_handoff",
      modelName: coderModel,
      displayName: "Dev editor (coder)",
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
    },
    {
      id: "dev-repair-local",
      providerId: local,
      role: "coder_handoff",
      modelName: coderModel,
      displayName: "Dev repair (coder)",
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
  baseUrl?: string,
  embeddingBaseUrl?: string
): ModelProviderRecord {
  const ts = new Date().toISOString();
  return {
    id: provider.id,
    kind: provider.kind,
    displayName: provider.displayName,
    baseUrl:
      provider.id === "provider_llamacpp_local"
        ? (baseUrl ?? provider.baseUrl)
        : provider.id === "provider_llamacpp_embeddings"
          ? (embeddingBaseUrl ?? provider.baseUrl)
          : provider.baseUrl,
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
): { providersAdded: number; profilesAdded: number; profilesUpgraded: number; skipped: boolean; localBaseUrl: string } {
  const overrides = readEnvOverrides(env);
  const localBaseUrl = overrides.localBaseUrl ?? DEFAULT_LOCAL_BASE_URL;
  const embeddingBaseUrl = overrides.embeddingBaseUrl ?? "http://127.0.0.1:8081/v1";
  const existing = repo.listProfiles();
  const existingIds = new Set(existing.map((profile) => profile.id));
  if (existing.length === 0) {
    let providersAdded = 0;
    for (const provider of DEFAULT_PROVIDER_ROWS) {
      repo.upsertProvider(buildDefaultProvider(provider, localBaseUrl, embeddingBaseUrl));
      providersAdded += 1;
    }
    const profiles = buildDefaultProfileRows(env);
    for (const profile of profiles) {
      repo.upsertProfile(buildDefaultProfile(profile));
    }
    return {
      providersAdded,
      profilesAdded: profiles.length,
      profilesUpgraded: 0,
      skipped: false,
      localBaseUrl,
    };
  }
  // Existing catalog: ensure every default provider is present and merge
  // any new default profiles that did not exist before. We never overwrite
  // a profile that the user (or an earlier seed) customised; we only add
  // the missing default ids.
  const existingProviderIds = new Set(repo.listProviders().map((provider) => provider.id));
  let providersAdded = 0;
  for (const provider of DEFAULT_PROVIDER_ROWS) {
    if (existingProviderIds.has(provider.id)) continue;
    repo.upsertProvider(buildDefaultProvider(provider, localBaseUrl, embeddingBaseUrl));
    providersAdded += 1;
  }
  const profiles = buildDefaultProfileRows(env);
  let profilesAdded = 0;
  let profilesUpgraded = 0;
  for (const profile of profiles) {
    if (existingIds.has(profile.id)) {
      const current = existing.find((entry) => entry.id === profile.id);
      const built = buildDefaultProfile(profile);
      // Upgrade the model name if the existing profile is still pointing
      // at a placeholder (heuristic) or a model that no longer exists in
      // the local llama-swap set. This is a soft upgrade: a profile that
      // already has a real model name is left alone.
      if (current && (current.modelName === "heuristic" || current.modelName === "ask-cloud-router")) {
        repo.upsertProfile({ ...current, ...built, modelName: built.modelName });
        profilesUpgraded += 1;
      }
      continue;
    }
    repo.upsertProfile(buildDefaultProfile(profile));
    profilesAdded += 1;
  }
  return {
    providersAdded,
    profilesAdded,
    profilesUpgraded,
    skipped: providersAdded === 0 && profilesAdded === 0 && profilesUpgraded === 0,
    localBaseUrl,
  };
}
