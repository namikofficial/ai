import type { EmbeddingRequest, EmbeddingResult, ModelInvokeRequest, ModelInvokeResult } from "../index.ts";
import type { ModelHealthResult, ModelProviderAdapter } from "./types.ts";

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export class OpenAICompatAdapter implements ModelProviderAdapter {
  readonly id: string;
  readonly kind: "openai_compat" | "llama_cpp";
  private readonly baseUrl: string;
  private readonly apiKey: string | null;

  constructor(id: string, kind: "openai_compat" | "llama_cpp", baseUrl: string, apiKey?: string | null) {
    this.id = id;
    this.kind = kind;
    this.baseUrl = baseUrl;
    this.apiKey = apiKey ?? null;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  private async fetchJson(path: string, body?: Record<string, unknown>) {
    const response = await fetch(new URL(path, this.baseUrl), {
      method: body ? "POST" : "GET",
      headers: body ? this.headers() : undefined,
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
