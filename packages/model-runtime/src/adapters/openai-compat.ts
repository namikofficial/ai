import type { EmbeddingRequest, EmbeddingResult, ModelInvokeRequest, ModelInvokeResult } from "../index.ts";
import type { ModelHealthResult, ModelProviderAdapter } from "./types.ts";

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export interface OpenAICompatAdapterOptions {
  baseUrl: string;
  apiKey?: string | null;
  /**
   * Per-call timeout in milliseconds. When the request runs longer, the
   * adapter aborts the fetch and throws an Error so the runtime can fall
   * back to a cheaper profile. Defaults to 60s.
   */
  timeoutMs?: number;
}

export class OpenAICompatAdapter implements ModelProviderAdapter {
  readonly id: string;
  readonly kind: "openai_compat" | "llama_cpp";
  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly timeoutMs: number;

  constructor(id: string, kind: "openai_compat" | "llama_cpp", baseUrl: string, apiKey?: string | null);
  constructor(id: string, kind: "openai_compat" | "llama_cpp", options: OpenAICompatAdapterOptions);
  constructor(
    id: string,
    kind: "openai_compat" | "llama_cpp",
    baseUrlOrOptions: string | OpenAICompatAdapterOptions,
    apiKey?: string | null
  ) {
    this.id = id;
    this.kind = kind;
    if (typeof baseUrlOrOptions === "string") {
      this.baseUrl = baseUrlOrOptions;
      this.apiKey = apiKey ?? null;
      this.timeoutMs = 60_000;
    } else {
      this.baseUrl = baseUrlOrOptions.baseUrl;
      this.apiKey = baseUrlOrOptions.apiKey ?? null;
      this.timeoutMs = baseUrlOrOptions.timeoutMs ?? 60_000;
    }
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  private async fetchJson(path: string, body?: Record<string, unknown>) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(new URL(path, this.baseUrl), {
        method: body ? "POST" : "GET",
        headers: body ? this.headers() : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      let raw: unknown = text;
      try {
        raw = JSON.parse(text);
      } catch {
        // keep raw text
      }
      return { response, raw };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`request to ${path} timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<ModelHealthResult> {
    const started = Date.now();
    try {
      const { response, raw } = await this.fetchJson("/v1/models");
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
  }

  async invoke(request: ModelInvokeRequest): Promise<ModelInvokeResult> {
    const started = Date.now();
    const { response, raw } = await this.fetchJson("/v1/chat/completions", {
      model: request.modelName ?? this.id,
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
    const promptTokens =
      parsed.usage?.prompt_tokens ?? estimateTokens(request.messages.map((message) => message.content).join("\n"));
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
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    const started = Date.now();
    const { response, raw } = await this.fetchJson("/v1/embeddings", {
      model: request.modelName ?? this.id,
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
      modelName: parsed.model ?? request.modelName ?? this.id,
      providerId: this.id,
      raw: { ...parsed, latencyMs: Date.now() - started },
    };
  }
}
