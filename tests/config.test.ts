import assert from "node:assert/strict";
import test from "node:test";
import { resolveConfig } from "../packages/config/src/index.ts";
import { readEmbeddingConfig } from "../packages/indexer/src/config.ts";

test("uses separate web and api defaults", () => {
  const config = resolveConfig();
  assert.equal(config.webPort, 3000);
  assert.equal(config.apiPort, 4242);
  assert.equal(config.apiUrl, "http://127.0.0.1:4242");
});

test("derives the api url from a custom api port", () => {
  const config = resolveConfig({ apiPort: 4321 });
  assert.equal(config.apiPort, 4321);
  // Support both cases if env is set or not
  const expected = process.env.AI_API_PORT
    ? `http://127.0.0.1:${process.env.AI_API_PORT}`
    : "http://127.0.0.1:4321";
  assert.equal(config.apiUrl, expected);
});

test("honors runtime env overrides", () => {
  const previousDatabasePath = process.env.AI_DATABASE_PATH;
  const previousRuntimeDir = process.env.AI_RUNTIME_DIR;
  const previousApiPort = process.env.AI_API_PORT;
  const previousWebPort = process.env.AI_WEB_PORT;
  const previousApiUrl = process.env.AI_API_URL;
  const previousQdrantEnabled = process.env.AI_QDRANT_ENABLED;
  const previousQdrantUrl = process.env.AI_QDRANT_URL;
  const previousQdrantCollection = process.env.AI_QDRANT_COLLECTION;

  process.env.AI_DATABASE_PATH = "/tmp/ai-test.db";
  process.env.AI_RUNTIME_DIR = "/tmp/ai-runtime";
  process.env.AI_API_PORT = "4999";
  process.env.AI_WEB_PORT = "3999";
  process.env.AI_API_URL = "http://127.0.0.1:4999";
  process.env.AI_QDRANT_ENABLED = "true";
  process.env.AI_QDRANT_URL = "http://127.0.0.1:6333";
  process.env.AI_QDRANT_COLLECTION = "ai-test";

  try {
    const config = resolveConfig();
    assert.equal(config.databasePath, "/tmp/ai-test.db");
    assert.equal(config.runtimeDir, "/tmp/ai-runtime");
    assert.equal(config.apiPort, 4999);
    assert.equal(config.webPort, 3999);
    assert.equal(config.apiUrl, "http://127.0.0.1:4999");
    assert.equal(config.qdrantEnabled, true);
    assert.equal(config.qdrantUrl, "http://127.0.0.1:6333");
    assert.equal(config.qdrantCollection, "ai-test");
  } finally {
    if (previousDatabasePath === undefined) delete process.env.AI_DATABASE_PATH;
    else process.env.AI_DATABASE_PATH = previousDatabasePath;
    if (previousRuntimeDir === undefined) delete process.env.AI_RUNTIME_DIR;
    else process.env.AI_RUNTIME_DIR = previousRuntimeDir;
    if (previousApiPort === undefined) delete process.env.AI_API_PORT;
    else process.env.AI_API_PORT = previousApiPort;
    if (previousWebPort === undefined) delete process.env.AI_WEB_PORT;
    else process.env.AI_WEB_PORT = previousWebPort;
    if (previousApiUrl === undefined) delete process.env.AI_API_URL;
    else process.env.AI_API_URL = previousApiUrl;
    if (previousQdrantEnabled === undefined) delete process.env.AI_QDRANT_ENABLED;
    else process.env.AI_QDRANT_ENABLED = previousQdrantEnabled;
    if (previousQdrantUrl === undefined) delete process.env.AI_QDRANT_URL;
    else process.env.AI_QDRANT_URL = previousQdrantUrl;
    if (previousQdrantCollection === undefined) delete process.env.AI_QDRANT_COLLECTION;
    else process.env.AI_QDRANT_COLLECTION = previousQdrantCollection;
  }
});

test("embedding config defaults to heuristic safely", () => {
  const previousProvider = process.env.AI_EMBEDDING_PROVIDER;
  const previousModel = process.env.AI_EMBEDDING_MODEL;
  const previousDim = process.env.AI_EMBEDDING_DIM;
  const previousBatch = process.env.AI_EMBEDDING_BATCH_SIZE;
  const previousCloudEnabled = process.env.AI_CLOUD_ENABLED;

  delete process.env.AI_EMBEDDING_PROVIDER;
  delete process.env.AI_EMBEDDING_MODEL;
  delete process.env.AI_EMBEDDING_DIM;
  delete process.env.AI_EMBEDDING_BATCH_SIZE;
  delete process.env.AI_CLOUD_ENABLED;

  try {
    const config = readEmbeddingConfig({ env: {} });
    assert.equal(config.provider, "heuristic");
    assert.equal(config.model, "heuristic-embedding");
    assert.equal(config.dimension, 32);
    assert.equal(config.batchSize, 32);
    assert.equal(config.cloudEnabled, false);
  } finally {
    if (previousProvider === undefined) delete process.env.AI_EMBEDDING_PROVIDER;
    else process.env.AI_EMBEDDING_PROVIDER = previousProvider;
    if (previousModel === undefined) delete process.env.AI_EMBEDDING_MODEL;
    else process.env.AI_EMBEDDING_MODEL = previousModel;
    if (previousDim === undefined) delete process.env.AI_EMBEDDING_DIM;
    else process.env.AI_EMBEDDING_DIM = previousDim;
    if (previousBatch === undefined) delete process.env.AI_EMBEDDING_BATCH_SIZE;
    else process.env.AI_EMBEDDING_BATCH_SIZE = previousBatch;
    if (previousCloudEnabled === undefined) delete process.env.AI_CLOUD_ENABLED;
    else process.env.AI_CLOUD_ENABLED = previousCloudEnabled;
  }
});

test("cloud embedding providers fall back to heuristic when cloud is disabled", () => {
  const previousProvider = process.env.AI_EMBEDDING_PROVIDER;
  const previousModel = process.env.AI_EMBEDDING_MODEL;
  const previousDim = process.env.AI_EMBEDDING_DIM;
  const previousBatch = process.env.AI_EMBEDDING_BATCH_SIZE;
  const previousCloudEnabled = process.env.AI_CLOUD_ENABLED;

  process.env.AI_EMBEDDING_PROVIDER = "openai_compat";
  process.env.AI_EMBEDDING_MODEL = "openai-embedding";
  process.env.AI_EMBEDDING_DIM = "1536";
  process.env.AI_EMBEDDING_BATCH_SIZE = "16";
  process.env.AI_CLOUD_ENABLED = "false";

  try {
    const config = readEmbeddingConfig();
    assert.equal(config.provider, "heuristic");
    assert.equal(config.model, "openai-embedding");
    assert.equal(config.dimension, 1536);
    assert.equal(config.batchSize, 16);
    assert.equal(config.cloudEnabled, false);
  } finally {
    if (previousProvider === undefined) delete process.env.AI_EMBEDDING_PROVIDER;
    else process.env.AI_EMBEDDING_PROVIDER = previousProvider;
    if (previousModel === undefined) delete process.env.AI_EMBEDDING_MODEL;
    else process.env.AI_EMBEDDING_MODEL = previousModel;
    if (previousDim === undefined) delete process.env.AI_EMBEDDING_DIM;
    else process.env.AI_EMBEDDING_DIM = previousDim;
    if (previousBatch === undefined) delete process.env.AI_EMBEDDING_BATCH_SIZE;
    else process.env.AI_EMBEDDING_BATCH_SIZE = previousBatch;
    if (previousCloudEnabled === undefined) delete process.env.AI_CLOUD_ENABLED;
    else process.env.AI_CLOUD_ENABLED = previousCloudEnabled;
  }
});
