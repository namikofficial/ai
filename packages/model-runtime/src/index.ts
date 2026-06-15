import { checkCloudGuard, redactSecrets } from "../../safety/src/index.ts";
import type {
  ModelCallStatus,
  ModelHealthStatus,
  ModelProfileRecord,
  ModelProviderRecord,
  ModelRole,
} from "../../shared/src/index.ts";
import { HeuristicAdapter } from "./adapters/heuristic.ts";
import { MockAdapter } from "./adapters/mock.ts";
import { OpenAICompatAdapter } from "./adapters/openai-compat.ts";
import type { ModelHealthResult, ModelProviderAdapter } from "./adapters/types.ts";
import { HeuristicModelRouter, type ModelRouter } from "./router.ts";

export type { ModelHealthResult, ModelProviderAdapter };

export interface ModelRouteDetails {
  risk?: "low" | "medium" | "high";
  depth?: "shallow" | "standard" | "deep";
  question?: string;
  goal?: string;
  contextTokens?: number;
}

export interface ModelInvokeMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelInvokeRequest {
  role: ModelRole;
  modelName?: string;
  messages: ModelInvokeMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  metadata?: Record<string, unknown>;
}

export interface ModelInvokeUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ModelInvokeResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  usage?: ModelInvokeUsage;
  raw?: unknown;
  profileId?: string;
  providerId?: string;
  status?: ModelCallStatus;
}

export interface EmbeddingRequest {
  input: string | string[];
  modelName?: string;
}

export interface EmbeddingResult {
  embeddings: number[][];
  dimensions: number;
  modelName: string;
  providerId: string;
  raw?: unknown;
}

export interface RerankRequest {
  query: string;
  documents: string[];
  topK?: number;
}

export interface RerankResult {
  scores: Array<{ index: number; score: number }>;
  raw?: unknown;
}

export interface ModelRouteInput {
  role: ModelRole;
  mode: "local" | "cloud" | "hybrid" | "any";
  cloudEnabled: boolean;
  details?: ModelRouteDetails;
  fallbackProfileId?: string | null;
}

export interface ModelRouteDecision {
  profileId: string | null;
  fallbackProfileId: string | null;
  blocked: boolean;
  reason: string;
}

export type ModelCallRecordedHook = (input: {
  profileId: string;
  role: ModelRole;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  status: ModelCallStatus;
  request: Record<string, unknown>;
  response: Record<string, unknown>;
  error?: string | null;
  sessionId?: string | null;
  taskId?: string | null;
  retrievalQueryId?: string | null;
}) => void;

export interface ModelInvokeOptions {
  sessionId?: string | null;
  taskId?: string | null;
  retrievalQueryId?: string | null;
  recordCall?: ModelCallRecordedHook;
  fallbackProfileId?: string | null;
}

export interface ModelRuntime {
  route(input: ModelRouteInput): Promise<ModelRouteDecision>;
  health(providerId?: string): Promise<
    Array<{
      providerId: string;
      status: ModelHealthStatus;
      latencyMs: number | null;
      detail: string | null;
    }>
  >;
  invoke(profileId: string, request: ModelInvokeRequest, options?: ModelInvokeOptions): Promise<ModelInvokeResult>;
  embed(profileId: string, request: EmbeddingRequest, options?: ModelInvokeOptions): Promise<EmbeddingResult>;
  rerank(profileId: string, request: RerankRequest): Promise<RerankResult>;
  listProfiles(): ModelProfileRecord[];
  listProviders(): Array<
    Pick<ModelProviderRecord, "id" | "kind" | "displayName" | "baseUrl" | "apiKeyEnv" | "enabled">
  >;
  isCloudEnabled(): boolean;
}

export interface ModelRuntimeInput {
  providers: Array<Pick<ModelProviderRecord, "id" | "kind" | "displayName" | "baseUrl" | "apiKeyEnv" | "enabled">>;
  profiles: ModelProfileRecord[];
  cloudEnabled: boolean;
  recordCall?: ModelCallRecordedHook;
}

function redactMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!metadata) return null;
  try {
    const text = JSON.stringify(metadata);
    const redacted = redactSecrets(text).text;
    return JSON.parse(redacted) as Record<string, unknown>;
  } catch {
    return { redacted: true };
  }
}

export type LegacyRouteMode = string;

export interface LegacyRouteDetails {
  risk?: "low" | "medium" | "high";
  depth?: "shallow" | "standard" | "deep";
  question?: string;
  goal?: string;
}

export function selectModelProfile(mode: LegacyRouteMode, details: LegacyRouteDetails = {}): string {
  if (mode === "cloud") return "ask-cloud-router";
  if (mode === "hybrid") return "ask-hybrid-router";
  if (mode === "index") return "indexer-local";
  if (mode === "plan") {
    if (details.risk === "high") return "planner-deep-local";
    if (details.risk === "medium") return "planner-balanced-local";
    return "planner-fast-local";
  }
  if (mode === "ask") {
    if (details.depth === "deep") return "ask-deep-local";
    if ((details.question ?? "").length > 120) return "ask-extended-local";
    return "ask-fast-local";
  }
  return "ask-fast-local";
}

export function buildAnswer(
  question: string,
  project: { name: string; id?: string; path?: string; [key: string]: unknown },
  chunks: Array<{
    path: string;
    startLine: number;
    endLine: number;
    content?: string;
    [key: string]: unknown;
  }>,
  citations: Array<{ path: string; startLine: number; endLine: number; score?: number }>,
  confidence: number
): string {
  const citationLines = citations
    .map((citation) => `- ${citation.path}:${citation.startLine}-${citation.endLine}`)
    .join("\n");
  const chunkSummary = chunks.map((chunk) => `- ${chunk.path}:${chunk.startLine}-${chunk.endLine}`).join("\n");
  return [
    `Question: ${question}`,
    `Project: ${project.name}`,
    `Confidence: ${Math.round(confidence * 100)}%`,
    citationLines ? `Citations:\n${citationLines}` : "Citations: none",
    chunkSummary ? `Chunks:\n${chunkSummary}` : "Chunks: none",
  ].join("\n");
}

export function normalizeProviderKind(kind: string): ModelProviderAdapter["kind"] {
  if (kind === "cloud_openai_compat" || kind === "openai_compat") return "openai_compat";
  if (kind === "local_openai_compat" || kind === "llama_cpp") return "llama_cpp";
  if (kind === "mock") return "mock";
  return "heuristic";
}

export function createModelRuntime(input: ModelRuntimeInput): ModelRuntime {
  const providerMap = new Map(input.providers.map((p) => [p.id, p]));
  const adapters = new Map<string, ModelProviderAdapter>();
  const router = new HeuristicModelRouter(input.profiles);

  function getAdapter(profile: ModelProfileRecord): ModelProviderAdapter {
    const cached = adapters.get(profile.providerId);
    if (cached) return cached;
    const provider = providerMap.get(profile.providerId);
    if (!provider) {
      const fallback = new HeuristicAdapter(profile.providerId);
      adapters.set(profile.providerId, fallback);
      return fallback;
    }
    const kind = normalizeProviderKind(provider.kind);
    let adapter: ModelProviderAdapter;
    switch (kind) {
      case "mock":
        adapter = new MockAdapter(provider.id);
        break;
      case "openai_compat":
      case "llama_cpp":
        adapter = new OpenAICompatAdapter(
          provider.id,
          kind,
          provider.baseUrl ?? "http://127.0.0.1:11434",
          provider.apiKeyEnv ? (process.env[provider.apiKeyEnv] ?? null) : null
        );
        break;
      default:
        adapter = new HeuristicAdapter(provider.id);
    }
    adapters.set(profile.providerId, adapter);
    return adapter;
  }

  function recordCallSafely(payload: Parameters<ModelCallRecordedHook>[0], options?: ModelInvokeOptions): void {
    const hook = options?.recordCall ?? input.recordCall;
    if (!hook) return;
    try {
      hook(payload);
    } catch {
      // ignore recorder errors
    }
  }

  return {
    async route(inputRoute: ModelRouteInput) {
      return router.route(inputRoute);
    },
    listProfiles() {
      return input.profiles.slice();
    },
    listProviders() {
      return input.providers.slice();
    },
    isCloudEnabled() {
      return input.cloudEnabled;
    },
    async health(providerId?: string) {
      const providers = providerId ? input.providers.filter((p) => p.id === providerId) : input.providers;
      const results: Array<{
        providerId: string;
        status: ModelHealthStatus;
        latencyMs: number | null;
        detail: string | null;
      }> = [];
      for (const provider of providers) {
        const normalized = normalizeProviderKind(provider.kind);
        if (normalized === "openai_compat" && !input.cloudEnabled) {
          results.push({
            providerId: provider.id,
            status: "disabled",
            latencyMs: null,
            detail: "cloud disabled",
          });
          continue;
        }
        // Use a heuristic adapter to check health if no profile exists for this provider yet
        const profile = input.profiles.find((p) => p.providerId === provider.id) ?? input.profiles[0];
        const adapter = profile ? getAdapter(profile) : new HeuristicAdapter(provider.id);
        const result = await adapter.health();
        results.push({
          providerId: provider.id,
          status: result.status,
          latencyMs: result.latencyMs,
          detail: result.detail,
        });
      }
      return results;
    },
    async invoke(profileId: string, request: ModelInvokeRequest, options?: ModelInvokeOptions) {
      const profile = input.profiles.find((p) => p.id === profileId);
      if (!profile) throw new Error(`Unknown profile: ${profileId}`);

      const provider = providerMap.get(profile.providerId);
      if (provider) {
        const guard = checkCloudGuard({
          cloudEnabled: input.cloudEnabled,
          providerKind: provider.kind,
          profileLocalOnly: profile.localOnly,
        });
        if (!guard.allowed) {
          const fallbackId =
            options?.fallbackProfileId ??
            profile.fallbackProfileId ??
            input.profiles.find((p) => p.role === profile.role && p.localOnly && p.enabled)?.id ??
            null;
          recordCallSafely(
            {
              profileId,
              role: request.role,
              promptTokens: 0,
              completionTokens: 0,
              latencyMs: 0,
              status: "blocked",
              request: { ...request, metadata: redactMetadata(request.metadata) },
              response: { blocked: true, reason: guard.reason },
              error: guard.reason,
              sessionId: options?.sessionId,
              taskId: options?.taskId,
              retrievalQueryId: options?.retrievalQueryId,
            },
            options
          );
          if (fallbackId && fallbackId !== profileId) {
            return this.invoke(fallbackId, request, options);
          }
          throw new Error(`model call blocked: ${guard.reason}`);
        }
      }

      const adapter = getAdapter(profile);
      const started = Date.now();
      try {
        const result = await adapter.invoke({
          ...request,
          modelName: request.modelName ?? profile.modelName,
        });
        const latencyMs = Date.now() - started;

        recordCallSafely(
          {
            profileId,
            role: request.role,
            promptTokens: result.promptTokens,
            completionTokens: result.completionTokens,
            latencyMs,
            status: "ok",
            request: { ...request, metadata: redactMetadata(request.metadata) },
            response: { text: result.text.slice(0, 1000), usage: result.usage },
            sessionId: options?.sessionId,
            taskId: options?.taskId,
            retrievalQueryId: options?.retrievalQueryId,
          },
          options
        );

        return { ...result, profileId, providerId: profile.providerId, status: "ok", latencyMs };
      } catch (error) {
        const latencyMs = Date.now() - started;
        const message = error instanceof Error ? error.message : String(error);

        const fallbackId = options?.fallbackProfileId ?? profile.fallbackProfileId;
        if (provider?.kind === "local_openai_compat") {
          if (fallbackId && fallbackId !== profileId) {
            return this.invoke(fallbackId, request, options);
          }
          if (profile.providerId) {
            const heuristic = new HeuristicAdapter(profile.providerId);
            const fallbackStarted = Date.now();
            const fallbackResult = await heuristic.invoke({
              ...request,
              modelName: request.modelName ?? profile.modelName,
            });
            recordCallSafely(
              {
                profileId,
                role: request.role,
                promptTokens: fallbackResult.promptTokens,
                completionTokens: fallbackResult.completionTokens,
                latencyMs: Date.now() - fallbackStarted,
                status: "fallback",
                request: { ...request, metadata: redactMetadata(request.metadata) },
                response: {
                  text: fallbackResult.text.slice(0, 1000),
                  usage: fallbackResult.usage,
                  fallbackFrom: message,
                },
                error: message,
                sessionId: options?.sessionId,
                taskId: options?.taskId,
                retrievalQueryId: options?.retrievalQueryId,
              },
              options
            );
            return {
              ...fallbackResult,
              profileId,
              providerId: profile.providerId,
              status: "fallback",
              latencyMs: Date.now() - fallbackStarted,
            };
          }
        }
        if (fallbackId && fallbackId !== profileId) {
          recordCallSafely(
            {
              profileId,
              role: request.role,
              promptTokens: 0,
              completionTokens: 0,
              latencyMs,
              status: "failed",
              request: { ...request, metadata: redactMetadata(request.metadata) },
              response: { error: message },
              error: message,
              sessionId: options?.sessionId,
              taskId: options?.taskId,
              retrievalQueryId: options?.retrievalQueryId,
            },
            options
          );
          return this.invoke(fallbackId, request, options);
        }
        recordCallSafely(
          {
            profileId,
            role: request.role,
            promptTokens: 0,
            completionTokens: 0,
            latencyMs,
            status: "failed",
            request: { ...request, metadata: redactMetadata(request.metadata) },
            response: { error: message },
            error: message,
            sessionId: options?.sessionId,
            taskId: options?.taskId,
            retrievalQueryId: options?.retrievalQueryId,
          },
          options
        );
        if (profile.providerId) {
          const heuristic = new HeuristicAdapter(profile.providerId);
          const fallbackStarted = Date.now();
          const fallbackResult = await heuristic.invoke({
            ...request,
            modelName: request.modelName ?? profile.modelName,
          });
          recordCallSafely(
            {
              profileId,
              role: request.role,
              promptTokens: fallbackResult.promptTokens,
              completionTokens: fallbackResult.completionTokens,
              latencyMs: Date.now() - fallbackStarted,
              status: "fallback",
              request: { ...request, metadata: redactMetadata(request.metadata) },
              response: {
                text: fallbackResult.text.slice(0, 1000),
                usage: fallbackResult.usage,
                fallbackFrom: message,
              },
              error: message,
              sessionId: options?.sessionId,
              taskId: options?.taskId,
              retrievalQueryId: options?.retrievalQueryId,
            },
            options
          );
          return {
            ...fallbackResult,
            profileId,
            providerId: profile.providerId,
            status: "fallback",
            latencyMs: Date.now() - fallbackStarted,
          };
        }
        throw error;
      }
    },
    async embed(profileId: string, request: EmbeddingRequest, options?: ModelInvokeOptions) {
      const profile = input.profiles.find((p) => p.id === profileId);
      if (!profile) throw new Error(`Unknown profile: ${profileId}`);
      const adapter = getAdapter(profile);
      const started = Date.now();
      try {
        const result = adapter.embed
          ? await adapter.embed(request)
          : await new HeuristicAdapter(profile.providerId).embed(request);
        recordCallSafely(
          {
            profileId,
            role: "embedding",
            promptTokens: Array.isArray(request.input) ? request.input.join("\n").length : request.input.length,
            completionTokens: result.embeddings.length,
            latencyMs: Date.now() - started,
            status: "ok",
            request: { ...request },
            response: {
              dimensions: result.dimensions,
              modelName: result.modelName,
              providerId: result.providerId,
            },
            sessionId: options?.sessionId,
            taskId: options?.taskId,
            retrievalQueryId: options?.retrievalQueryId,
          },
          options
        );
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const heuristic = new HeuristicAdapter(profile.providerId);
        const fallback = await heuristic.embed(request);
        recordCallSafely(
          {
            profileId,
            role: "embedding",
            promptTokens: Array.isArray(request.input) ? request.input.join("\n").length : request.input.length,
            completionTokens: fallback.embeddings.length,
            latencyMs: Date.now() - started,
            status: "fallback",
            request: { ...request },
            response: {
              dimensions: fallback.dimensions,
              modelName: fallback.modelName,
              providerId: fallback.providerId,
              fallbackFrom: message,
            },
            error: message,
            sessionId: options?.sessionId,
            taskId: options?.taskId,
            retrievalQueryId: options?.retrievalQueryId,
          },
          options
        );
        return fallback;
      }
    },
    async rerank(profileId: string, request: RerankRequest) {
      const profile = input.profiles.find((p) => p.id === profileId);
      if (!profile) throw new Error(`Unknown profile: ${profileId}`);

      const adapter = getAdapter(profile);
      if (!adapter.rerank) {
        const heuristic = new HeuristicAdapter(profile.providerId);
        return heuristic.rerank(request);
      }
      return adapter.rerank(request);
    },
  };
}
