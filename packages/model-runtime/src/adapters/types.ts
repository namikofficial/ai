import type {
  ModelHealthStatus,
} from "../../../shared/src/index.ts";
import type {
  ModelInvokeRequest,
  ModelInvokeResult,
  EmbeddingRequest,
  EmbeddingResult,
  RerankRequest,
  RerankResult,
} from "../index.ts";

export interface ModelHealthResult {
  status: ModelHealthStatus;
  latencyMs: number | null;
  detail: string | null;
}

export interface ModelProviderAdapter {
  id: string;
  kind: "heuristic" | "openai_compat" | "llama_cpp" | "mock";
  health(): Promise<ModelHealthResult>;
  invoke(request: ModelInvokeRequest): Promise<ModelInvokeResult>;
  embed?(request: EmbeddingRequest): Promise<EmbeddingResult>;
  rerank?(request: RerankRequest): Promise<RerankResult>;
}
