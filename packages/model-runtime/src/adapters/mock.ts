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

export class MockAdapter implements ModelProviderAdapter {
  readonly kind = "mock";
  readonly id: string;

  constructor(id: string) {
    this.id = id;
  }

  async health(): Promise<ModelHealthResult> {
    return { status: "healthy", latencyMs: 0, detail: "mock adapter" };
  }

  async invoke(request: ModelInvokeRequest): Promise<ModelInvokeResult> {
    const prompt = request.messages.map((message) => message.content).join("\n");
    const text = `[mock:${request.role}] ${prompt}`.slice(0, 1200);
    return {
      text,
      promptTokens: estimateTokens(prompt),
      completionTokens: estimateTokens(text),
      latencyMs: 0,
    };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    return {
      embeddings: inputs.map(() => [1, 0, 0, 0]),
      dimensions: 4,
      modelName: request.modelName ?? "mock-embedding",
      providerId: this.id,
    };
  }

  async rerank(request: RerankRequest): Promise<RerankResult> {
    return {
      scores: request.documents.map((_, index) => ({
        index,
        score: request.documents.length - index,
      })),
    };
  }
}
