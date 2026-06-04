import type { ConfigSnapshot } from "../../shared/src/index.ts";
import { readEmbeddingConfig } from "../../indexer/src/index.ts";

export interface EmbeddingConfig {
  providerId: string;
  modelName: string;
  dimensions: number;
  expectedCollection: string;
}

export function resolveEmbeddingConfig(): EmbeddingConfig {
  const embedding = readEmbeddingConfig({ env: process.env });
  const expectedCollection = process.env.AI_QDRANT_COLLECTION ?? "ai_chunks";
  return {
    providerId: embedding.provider,
    modelName: embedding.model,
    dimensions: embedding.dimension,
    expectedCollection,
  };
}

export function resolveConfig(overrides: Partial<ConfigSnapshot> = {}): ConfigSnapshot {
  const cwd = process.cwd();
  const envDatabasePath = process.env.AI_DATABASE_PATH;
  const envRuntimeDir = process.env.AI_RUNTIME_DIR;
  const envApiPort = process.env.AI_API_PORT ? Number(process.env.AI_API_PORT) : null;
  const envWebPort = process.env.AI_WEB_PORT ? Number(process.env.AI_WEB_PORT) : null;
  const envApiUrl = process.env.AI_API_URL;
  const envCloudEnabled = /^(1|true|yes)$/i.test(process.env.AI_CLOUD_ENABLED ?? "");
  const envQdrantEnabled = /^(1|true|yes)$/i.test(process.env.AI_QDRANT_ENABLED ?? "");
  const envQdrantUrl = process.env.AI_QDRANT_URL ?? null;
  const envQdrantCollection = process.env.AI_QDRANT_COLLECTION ?? "ai_chunks";
  const apiPort = overrides.apiPort ?? 4242;
  const qdrantEnabled = overrides.qdrantEnabled ?? envQdrantEnabled;
  return {
    databasePath: overrides.databasePath ?? envDatabasePath ?? `${cwd}/runtime/ai.db`,
    runtimeDir: overrides.runtimeDir ?? envRuntimeDir ?? `${cwd}/runtime`,
    apiUrl: overrides.apiUrl ?? envApiUrl ?? `http://127.0.0.1:${envApiPort ?? apiPort}`,
    webPort: overrides.webPort ?? envWebPort ?? 3000,
    apiPort: overrides.apiPort ?? envApiPort ?? apiPort,
    cloudEnabled: overrides.cloudEnabled ?? envCloudEnabled,
    qdrantEnabled,
    qdrantUrl: overrides.qdrantUrl ?? envQdrantUrl ?? (qdrantEnabled ? "http://127.0.0.1:6333" : null),
    qdrantCollection: overrides.qdrantCollection ?? envQdrantCollection,
  };
}
