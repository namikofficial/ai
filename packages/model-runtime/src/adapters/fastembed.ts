import type { EmbeddingRequest, EmbeddingResult, ModelInvokeRequest, ModelInvokeResult } from "../index.ts";
import type { ModelHealthResult, ModelProviderAdapter } from "./types.ts";

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Fastembed HTTP server adapter.
 *
 * Fastembed runs as a local HTTP service (e.g. `fastembed serve --model fastembed-default`).
 * This adapter calls the `/v1/embeddings` endpoint the same way OpenAICompatAdapter does,
 * so a fastembed server is wire-compatible with an OpenAI-compatible embedding endpoint.
 *
 * If no server is reachable the adapter reports `unreachable` health and throws
 * so the runtime can fall back to the heuristic adapter.
 */
export class FastembedAdapter implements ModelProviderAdapter {
  readonly id: string;
  readonly kind: "fastembed" = "fastembed";
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(id: string, baseUrl: string, timeoutMs = 30_000) {
    this.id = id;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
  }

  private async fetchJson(path: string, body?: Record<string, unknown>) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(new URL(path, this.baseUrl), {
        method: body ? "POST" : "GET",
        headers: body ? { "content-type": "application/json" } : undefined,
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
        throw new Error(`fastembed request to ${path} timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<ModelHealthResult> {
    const started = Date.now();
    try {
      // Fastembed serve exposes /v1/models for health, or we can probe /v1/embeddings
      const { response, raw } = await this.fetchJson("/v1/models");
      return {
        status: response.ok ? "healthy" : "degraded",
        latencyMs: Date.now() - started,
        detail: response.ok ? "fastembed server reachable" : `health check failed: ${JSON.stringify(raw).slice(0, 200)}`,
      };
    } catch (error) {
      return {
        status: "unreachable",
        latencyMs: Date.now() - started,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async invoke(_request: ModelInvokeRequest): Promise<ModelInvokeResult> {
    // Fastembed is primarily an embedding provider; chat completions are not typically served by fastembed.
    // Fall back to a lightweight text response for any role that happens to land here.
    return {
      text: "Fastembed adapter does not support chat completions. Use embed() for embeddings.",
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: 0,
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
      throw new Error(`fastembed embedding failed: ${JSON.stringify(raw).slice(0, 200)}`);
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
