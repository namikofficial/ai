import type {
  ModelCallRecord,
  ModelHealthCheckRecord,
  ModelHealthStatus,
  ModelProfileRecord,
  ModelProviderRecord,
  ModelRole,
  ProjectSummary,
  RetrievalChunk,
} from "../../shared/src/index.ts";

export interface ModelRouteDetails {
  risk?: "low" | "medium" | "high";
  depth?: "shallow" | "standard" | "deep";
  question?: string;
  goal?: string;
}

export interface ModelHealthResult {
  status: ModelHealthStatus;
  latencyMs: number | null;
  detail: string | null;
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

export interface ModelInvokeResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  raw?: unknown;
}

export interface EmbeddingRequest {
  input: string | string[];
  modelName?: string;
}

export interface EmbeddingResult {
  embeddings: number[][];
  dimensions: number;
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

export interface ModelProviderAdapter {
  id: string;
  kind: "heuristic" | "openai_compat" | "llama_cpp" | "mock";
  health(): Promise<ModelHealthResult>;
  invoke(request: ModelInvokeRequest): Promise<ModelInvokeResult>;
  embed?(request: EmbeddingRequest): Promise<EmbeddingResult>;
  rerank?(request: RerankRequest): Promise<RerankResult>;
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

export interface ModelRuntime {
  route(input: ModelRouteInput): ModelRouteDecision;
  health(providerId?: string): Promise<Array<{ providerId: string; status: ModelHealthStatus; latencyMs: number | null; detail: string | null }>>;
  invoke(profileId: string, request: ModelInvokeRequest): Promise<ModelInvokeResult>;
  embed(profileId: string, request: EmbeddingRequest): Promise<EmbeddingResult>;
  rerank(profileId: string, request: RerankRequest): Promise<RerankResult>;
}

export interface ModelRuntimeAdapterInput {
  provider: Pick<ModelProviderRecord, "id" | "kind" | "displayName" | "baseUrl" | "apiKeyEnv" | "enabled">;
  profile: ModelProfileRecord;
}

export interface ModelRuntimeInput {
  providers: Array<Pick<ModelProviderRecord, "id" | "kind" | "displayName" | "baseUrl" | "apiKeyEnv" | "enabled">>;
  profiles: ModelProfileRecord[];
  cloudEnabled: boolean;
}

export function selectModelProfile(
  mode: "local" | "cloud" | "hybrid" | "ask" | "any" | "index" | "plan" | "handoff" | "check" | "reflect",
  details: ModelRouteDetails = {},
): string {
  if (mode === "cloud") {
    return "ask-cloud-router";
  }
  if (mode === "hybrid") {
    return "ask-hybrid-router";
  }
  if (mode === "index") {
    return "indexer-local";
  }
  if (mode === "plan") {
    if (details.risk === "high" || details.depth === "deep") return "planner-deep-local";
    if (details.risk === "medium") return "planner-balanced-local";
    return "planner-fast-local";
  }
  if (mode === "handoff") {
    return "handoff-local";
  }
  if (mode === "check") {
    return "checker-local";
  }
  if (mode === "reflect") {
    return "reflector-local";
  }
  if (details.depth === "deep") return "ask-deep-local";
  if (details.question && details.question.length > 120) return "ask-extended-local";
  return "ask-fast-local";
}

export function buildAnswer(
  question: string,
  project: ProjectSummary,
  chunks: RetrievalChunk[],
  citations: Array<{ path: string; startLine: number; endLine: number; score: number }>,
  confidence: number,
): string {
  const bullets = chunks.slice(0, 3).map((chunk, index) => {
    const excerpt = chunk.content.split("\n").slice(0, 3).join(" ");
    return `${index + 1}. ${chunk.path}:${chunk.startLine}-${chunk.endLine} ${excerpt.slice(0, 160)}`;
  });
  return [
    `I found the most relevant local context in ${project.name} for "${question}".`,
    `Confidence: ${Math.round(confidence * 100)}%.`,
    "",
    ...bullets,
    "",
    "Citations:",
    ...citations.slice(0, 3).map((citation) => `- ${citation.path}:${citation.startLine}-${citation.endLine}`),
  ].join("\n");
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function normalizeProviderKind(kind: string): ModelProviderAdapter["kind"] {
  if (kind === "cloud_openai_compat" || kind === "openai_compat") return "openai_compat";
  if (kind === "local_openai_compat" || kind === "llama_cpp") return "llama_cpp";
  if (kind === "mock") return "mock";
  return "heuristic";
}

function createHeuristicProviderAdapter(id: string): ModelProviderAdapter {
  return {
    id,
    kind: "heuristic",
    async health() {
      return { status: "healthy", latencyMs: 0, detail: "heuristic adapter" };
    },
    async invoke(request) {
      const prompt = request.messages.map((message) => `${message.role}: ${message.content}`).join("\n");
      const text = request.role === "summarizer"
        ? `Summary: ${request.messages.at(-1)?.content ?? prompt}`.slice(0, 800)
        : `Heuristic ${request.role} response:\n${request.messages.at(-1)?.content ?? prompt}`.slice(0, 1200);
      return {
        text,
        promptTokens: estimateTokens(prompt),
        completionTokens: estimateTokens(text),
        latencyMs: 0,
        usage: {
          promptTokens: estimateTokens(prompt),
          completionTokens: estimateTokens(text),
          totalTokens: estimateTokens(prompt) + estimateTokens(text),
        },
      };
    },
    async embed(request) {
      const inputs = Array.isArray(request.input) ? request.input : [request.input];
      const embeddings = inputs.map((input) => {
        const vector = Array.from({ length: 32 }, () => 0);
        const terms = input.toLowerCase().split(/[^a-z0-9]+/g).filter((term) => term.length >= 2);
        for (const term of terms) {
          let hash = 2166136261;
          for (let index = 0; index < term.length; index += 1) {
            hash ^= term.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
          }
          const bucket = hash >>> 0;
          vector[bucket % vector.length] += 1;
          vector[(bucket >>> 5) % vector.length] += term.length / 8;
        }
        const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
        return magnitude > 0 ? vector.map((value) => value / magnitude) : vector;
      });
      return { embeddings, dimensions: 32 };
    },
    async rerank(request) {
      const lowered = request.query.toLowerCase();
      const terms = lowered.split(/[^a-z0-9]+/g).filter((term) => term.length >= 3);
      const scores = request.documents.map((document, index) => {
        let score = 0;
        const haystack = document.toLowerCase();
        for (const term of terms) {
          if (haystack.includes(term)) score += 1;
        }
        return { index, score };
      });
      scores.sort((left, right) => right.score - left.score);
      return { scores: scores.slice(0, request.topK ?? scores.length) };
    },
  };
}

function createMockProviderAdapter(id: string): ModelProviderAdapter {
  return {
    id,
    kind: "mock",
    async health() {
      return { status: "healthy", latencyMs: 0, detail: "mock adapter" };
    },
    async invoke(request) {
      const prompt = request.messages.map((message) => message.content).join("\n");
      const text = `[mock:${request.role}] ${prompt}`.slice(0, 1200);
      return {
        text,
        promptTokens: estimateTokens(prompt),
        completionTokens: estimateTokens(text),
        latencyMs: 0,
      };
    },
    async embed(request) {
      const inputs = Array.isArray(request.input) ? request.input : [request.input];
      return {
        embeddings: inputs.map(() => [1, 0, 0, 0]),
        dimensions: 4,
      };
    },
    async rerank(request) {
      return {
        scores: request.documents.map((_, index) => ({ index, score: request.documents.length - index })),
      };
    },
  };
}

function createOpenAICompatProviderAdapter(input: {
  id: string;
  baseUrl: string;
  apiKey?: string | null;
  kind: "openai_compat" | "llama_cpp";
}): ModelProviderAdapter {
  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}),
  });

  async function fetchJson(path: string, body?: Record<string, unknown>) {
    const response = await fetch(new URL(path, input.baseUrl), {
      method: body ? "POST" : "GET",
      headers: body ? headers() : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let raw: unknown = text;
    try {
      raw = JSON.parse(text);
    } catch {
      // keep raw text
    }
    return { response, raw };
  }

  return {
    id: input.id,
    kind: input.kind,
    async health() {
      const started = Date.now();
      try {
        const { response, raw } = await fetchJson("/v1/models");
        return {
          status: response.ok ? "healthy" : "degraded",
          latencyMs: Date.now() - started,
          detail: response.ok ? "models endpoint reachable" : `health check failed: ${JSON.stringify(raw).slice(0, 200)}`,
        };
      } catch (error) {
        return {
          status: "unreachable",
          latencyMs: Date.now() - started,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async invoke(request) {
      const started = Date.now();
      const { response, raw } = await fetchJson("/v1/chat/completions", {
        model: request.modelName ?? input.id,
        messages: request.messages,
        temperature: request.temperature ?? 0,
        max_tokens: request.maxOutputTokens ?? 512,
      });
      if (!response.ok) {
        throw new Error(`OpenAI-compatible invocation failed: ${JSON.stringify(raw).slice(0, 200)}`);
      }
      const parsed = raw as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const text = parsed.choices?.[0]?.message?.content ?? "";
      const promptTokens = parsed.usage?.prompt_tokens ?? estimateTokens(request.messages.map((message) => message.content).join("\n"));
      const completionTokens = parsed.usage?.completion_tokens ?? estimateTokens(text);
      return {
        text,
        promptTokens,
        completionTokens,
        latencyMs: Date.now() - started,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: parsed.usage?.total_tokens ?? promptTokens + completionTokens,
        },
        raw,
      };
    },
    async embed(request) {
      const inputs = Array.isArray(request.input) ? request.input : [request.input];
      const started = Date.now();
      const { response, raw } = await fetchJson("/v1/embeddings", {
        model: request.modelName ?? input.id,
        input: inputs,
      });
      if (!response.ok) {
        throw new Error(`OpenAI-compatible embedding failed: ${JSON.stringify(raw).slice(0, 200)}`);
      }
      const parsed = raw as { data?: Array<{ embedding?: number[] }>; model?: string };
      const embeddings = (parsed.data ?? []).map((entry) => entry.embedding ?? []);
      return {
        embeddings,
        dimensions: embeddings[0]?.length ?? 0,
        raw: { ...parsed, latencyMs: Date.now() - started },
      };
    },
  };
}

export function createModelRuntime(input: ModelRuntimeInput): ModelRuntime {
  const providerMap = new Map(input.providers.map((provider) => [provider.id, provider]));
  const adapters = new Map<string, ModelProviderAdapter>();
  const profilesByRole = new Map<ModelRole, ModelProfileRecord[]>();
  for (const profile of input.profiles) {
    const current = profilesByRole.get(profile.role) ?? [];
    current.push(profile);
    profilesByRole.set(profile.role, current);
  }

  function getAdapter(profile: ModelProfileRecord): ModelProviderAdapter {
    const cached = adapters.get(profile.providerId);
    if (cached) return cached;
    const provider = providerMap.get(profile.providerId);
    if (!provider) {
      const fallback = createHeuristicProviderAdapter(profile.providerId);
      adapters.set(profile.providerId, fallback);
      return fallback;
    }
    const kind = normalizeProviderKind(provider.kind);
    const adapter =
      kind === "mock"
        ? createMockProviderAdapter(provider.id)
        : kind === "heuristic"
          ? createHeuristicProviderAdapter(provider.id)
          : createOpenAICompatProviderAdapter({
              id: provider.id,
              baseUrl: provider.baseUrl ?? "http://127.0.0.1:11434",
              apiKey: provider.apiKeyEnv ? process.env[provider.apiKeyEnv] ?? null : null,
              kind,
            });
    adapters.set(profile.providerId, adapter);
    return adapter;
  }

  function chooseProfile(inputRoute: ModelRouteInput): ModelRouteDecision {
    const candidates = (profilesByRole.get(inputRoute.role) ?? []).filter((profile) => profile.enabled);
    const localCandidates = candidates.filter((profile) => profile.localOnly);
    const cloudCandidates = candidates.filter((profile) => !profile.localOnly);
    const pickBest = (list: ModelProfileRecord[]): ModelProfileRecord | null =>
      list.slice().sort((left, right) =>
        right.qualityScore - left.qualityScore ||
        right.latencyScore - left.latencyScore ||
        right.costScore - left.costScore,
      )[0] ?? null;

    if (inputRoute.mode === "cloud" && !inputRoute.cloudEnabled) {
      const fallback = inputRoute.fallbackProfileId ?? pickBest(localCandidates)?.id ?? pickBest(candidates)?.id ?? null;
      return { profileId: null, fallbackProfileId: fallback, blocked: true, reason: "cloud disabled" };
    }

    if (inputRoute.mode === "local") {
      const profile = pickBest(localCandidates) ?? pickBest(candidates);
      return {
        profileId: profile?.id ?? null,
        fallbackProfileId: inputRoute.fallbackProfileId ?? null,
        blocked: profile == null,
        reason: profile ? "local profile selected" : "no matching local profile",
      };
    }

    if (inputRoute.mode === "cloud") {
      const profile = pickBest(cloudCandidates);
      return {
        profileId: profile?.id ?? null,
        fallbackProfileId: inputRoute.fallbackProfileId ?? pickBest(localCandidates)?.id ?? null,
        blocked: profile == null,
        reason: profile ? "cloud profile selected" : "no matching cloud profile",
      };
    }

    if (inputRoute.mode === "hybrid") {
      const profile = pickBest(localCandidates) ?? pickBest(cloudCandidates) ?? pickBest(candidates);
      return {
        profileId: profile?.id ?? null,
        fallbackProfileId: inputRoute.fallbackProfileId ?? pickBest(localCandidates)?.id ?? null,
        blocked: profile == null,
        reason: profile ? "hybrid profile selected" : "no matching profile",
      };
    }

    const profile = pickBest(candidates);
    return {
      profileId: profile?.id ?? null,
      fallbackProfileId: inputRoute.fallbackProfileId ?? null,
      blocked: profile == null,
      reason: profile ? "profile selected" : "no matching profile",
    };
  }

  return {
    route: chooseProfile,
    async health(providerId?: string) {
      const providers = providerId ? input.providers.filter((provider) => provider.id === providerId) : input.providers;
      const results: Array<{ providerId: string; status: ModelHealthStatus; latencyMs: number | null; detail: string | null }> = [];
      for (const provider of providers) {
        const normalized = normalizeProviderKind(provider.kind);
        if (normalized === "openai_compat" && !input.cloudEnabled) {
          results.push({ providerId: provider.id, status: "disabled", latencyMs: null, detail: "cloud disabled" });
          continue;
        }
        const profile = input.profiles.find((candidate) => candidate.providerId === provider.id) ?? input.profiles[0];
        const adapter = profile ? getAdapter(profile) : createHeuristicProviderAdapter(provider.id);
        const result = await adapter.health();
        results.push({ providerId: provider.id, status: result.status, latencyMs: result.latencyMs, detail: result.detail });
      }
      return results;
    },
    async invoke(profileId: string, request: ModelInvokeRequest) {
      const profile = input.profiles.find((candidate) => candidate.id === profileId);
      if (!profile) {
        throw new Error(`Unknown profile: ${profileId}`);
      }
      return getAdapter(profile).invoke({ ...request, modelName: request.modelName ?? profile.modelName });
    },
    async embed(profileId: string, request: EmbeddingRequest) {
      const profile = input.profiles.find((candidate) => candidate.id === profileId);
      if (!profile) {
        throw new Error(`Unknown profile: ${profileId}`);
      }
      const adapter = getAdapter(profile);
      if (!adapter.embed) {
        return createHeuristicProviderAdapter(profile.providerId).embed!(request);
      }
      return adapter.embed(request);
    },
    async rerank(profileId: string, request: RerankRequest) {
      const profile = input.profiles.find((candidate) => candidate.id === profileId);
      if (!profile) {
        throw new Error(`Unknown profile: ${profileId}`);
      }
      const adapter = getAdapter(profile);
      if (!adapter.rerank) {
        return createHeuristicProviderAdapter(profile.providerId).rerank!(request);
      }
      return adapter.rerank(request);
    },
  };
}
