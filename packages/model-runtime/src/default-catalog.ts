// Default model provider and profile catalog.
//
// The seed is intentionally local-first: every profile resolves to the
// heuristic provider so the system runs end-to-end without a real model.
// The cloud profile is registered but disabled; it only becomes available
// when AI_CLOUD_ENABLED=true (or when an explicit config enables it).
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

export const DEFAULT_PROVIDER_ROWS: DefaultProviderInput[] = [
  {
    id: "provider_heuristic_local",
    kind: "heuristic",
    displayName: "Heuristic local router",
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
}

export const DEFAULT_PROFILE_ROWS: DefaultProfileInput[] = [
  { id: "intent-local", providerId: "provider_heuristic_local", role: "intent", modelName: "intent-local", displayName: "Intent classifier" },
  { id: "query-rewrite-local", providerId: "provider_heuristic_local", role: "query_rewrite", modelName: "query-rewrite-local", displayName: "Query rewriter" },
  { id: "retrieval-judge-local", providerId: "provider_heuristic_local", role: "retrieval_judge", modelName: "retrieval-judge-local", displayName: "Retrieval judge" },
  { id: "reranker-local", providerId: "provider_heuristic_local", role: "reranker", modelName: "reranker-local", displayName: "Reranker" },
  { id: "embedding-local", providerId: "provider_heuristic_local", role: "embedding", modelName: "embedding-local", displayName: "Embedding model" },
  { id: "summarizer-local", providerId: "provider_heuristic_local", role: "summarizer", modelName: "summarizer-local", displayName: "Summarizer" },
  { id: "reviewer-local", providerId: "provider_heuristic_local", role: "reviewer", modelName: "reviewer-local", displayName: "Reviewer" },
  { id: "reflection-local", providerId: "provider_heuristic_local", role: "reflection", modelName: "reflection-local", displayName: "Reflection model" },
  { id: "indexer-local", providerId: "provider_heuristic_local", role: "embedding", modelName: "indexer-local", displayName: "Indexer" },
  { id: "ask-fast-local", providerId: "provider_heuristic_local", role: "answer", modelName: "ask-fast-local", displayName: "Fast answer" },
  { id: "ask-extended-local", providerId: "provider_heuristic_local", role: "answer", modelName: "ask-extended-local", displayName: "Extended answer" },
  { id: "ask-deep-local", providerId: "provider_heuristic_local", role: "answer", modelName: "ask-deep-local", displayName: "Deep answer" },
  { id: "ask-hybrid-router", providerId: "provider_heuristic_local", role: "answer", modelName: "ask-hybrid-router", displayName: "Hybrid answer router" },
  {
    id: "ask-cloud-router",
    providerId: "provider_cloud_openai_compat",
    role: "answer",
    modelName: "ask-cloud-router",
    displayName: "Cloud answer router",
    localOnly: false,
    enabled: false,
  },
  { id: "planner-fast-local", providerId: "provider_heuristic_local", role: "planner", modelName: "planner-fast-local", displayName: "Fast planner" },
  { id: "planner-balanced-local", providerId: "provider_heuristic_local", role: "planner", modelName: "planner-balanced-local", displayName: "Balanced planner" },
  { id: "planner-deep-local", providerId: "provider_heuristic_local", role: "planner", modelName: "planner-deep-local", displayName: "Deep planner" },
  { id: "handoff-local", providerId: "provider_heuristic_local", role: "coder_handoff", modelName: "handoff-local", displayName: "Handoff compiler" },
  { id: "checker-local", providerId: "provider_heuristic_local", role: "reviewer", modelName: "checker-local", displayName: "Check summarizer" },
];

export function buildDefaultProvider(provider: DefaultProviderInput): ModelProviderRecord {
  const ts = new Date().toISOString();
  return {
    id: provider.id,
    kind: provider.kind,
    displayName: provider.displayName,
    baseUrl: provider.baseUrl,
    apiKeyEnv: provider.apiKeyEnv,
    enabled: provider.enabled,
    createdAt: ts,
    updatedAt: ts,
  };
}

export function buildDefaultProfile(profile: DefaultProfileInput): ModelProfileRecord {
  const ts = new Date().toISOString();
  const isDeep = profile.id.includes("deep");
  const isExtended = profile.id.includes("extended");
  const isCloud = profile.localOnly === false;
  return {
    id: profile.id,
    providerId: profile.providerId,
    role: profile.role,
    modelName: profile.modelName,
    displayName: profile.displayName,
    contextWindow: isDeep ? 32_768 : isExtended ? 16_384 : 8_192,
    maxOutputTokens: isDeep ? 4_096 : 2_048,
    localOnly: profile.localOnly !== false,
    enabled: profile.enabled !== false,
    fallbackProfileId: null,
    qualityScore: profile.role === "planner" ? 0.7 : profile.role === "answer" ? 0.65 : 0.6,
    latencyScore: profile.role === "embedding" ? 0.8 : 0.7,
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

export function seedDefaultModelCatalog(repo: ModelCatalogRepo): { providersAdded: number; profilesAdded: number; skipped: boolean } {
  const existing = repo.listProfiles();
  if (existing.length > 0) {
    return { providersAdded: 0, profilesAdded: 0, skipped: true };
  }
  for (const provider of DEFAULT_PROVIDER_ROWS) {
    repo.upsertProvider(buildDefaultProvider(provider));
  }
  for (const profile of DEFAULT_PROFILE_ROWS) {
    repo.upsertProfile(buildDefaultProfile(profile));
  }
  return { providersAdded: DEFAULT_PROVIDER_ROWS.length, profilesAdded: DEFAULT_PROFILE_ROWS.length, skipped: false };
}
