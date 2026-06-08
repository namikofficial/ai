import type {
  EmbeddingRequest,
  EmbeddingResult,
  ModelInvokeRequest,
  ModelInvokeResult,
  RerankRequest,
  RerankResult,
} from "../index.ts";
import type { ModelHealthResult, ModelProviderAdapter } from "./types.ts";

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function hashEmbedding(input: string, dim: number): number[] {
  const vector = Array.from({ length: dim }, () => 0);
  const terms = input
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((term) => term.length >= 2);
  for (const term of terms) {
    let hash = 2166136261;
    for (let index = 0; index < term.length; index += 1) {
      hash ^= term.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    const bucket = hash >>> 0;
    vector[bucket % dim] += 1;
    vector[(bucket >>> 5) % dim] += term.length / 8;
    vector[(bucket >>> 11) % dim] += term.includes("auth") ? 1.5 : 0.25;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return magnitude > 0 ? vector.map((value) => value / magnitude) : vector;
}

export class HeuristicAdapter implements ModelProviderAdapter {
  readonly kind = "heuristic";
  readonly id: string;
  private readonly dim: number;

  constructor(id: string, dim = 32) {
    this.id = id;
    this.dim = dim;
  }

  async health(): Promise<ModelHealthResult> {
    return { status: "healthy", latencyMs: 0, detail: "heuristic adapter" };
  }

  async invoke(request: ModelInvokeRequest): Promise<ModelInvokeResult> {
    const prompt = request.messages
      .map((message) => `${message.role}: ${message.content}`)
      .join("\n");
    const lastUserMessage =
      request.messages.filter((m) => m.role === "user").at(-1)?.content ?? prompt;
    let text: string;

    switch (request.role) {
      case "summarizer":
        text = `Summary: ${lastUserMessage}`.slice(0, 800);
        break;
      case "intent":
        text = `lookup: heuristic classification of "${lastUserMessage.slice(0, 80)}"`;
        break;
      case "query_rewrite":
        text = lastUserMessage.replace(/\?$/, "").trim();
        break;
      case "answer":
        text = `Heuristic answer based on the provided context:\n${lastUserMessage}`.slice(0, 1200);
        break;
      case "reflection":
        text = `Reflection notes: ${lastUserMessage.slice(0, 600)}`;
        break;
      default:
        text = `Heuristic ${request.role} response:\n${lastUserMessage}`.slice(0, 1200);
    }

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
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    const embeddings = inputs.map((input) => hashEmbedding(input, this.dim));
    return {
      embeddings,
      dimensions: this.dim,
      modelName: request.modelName ?? "heuristic-embedding",
      providerId: this.id,
    };
  }

  async rerank(request: RerankRequest): Promise<RerankResult> {
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
  }
}
