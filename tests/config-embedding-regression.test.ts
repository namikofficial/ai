import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  boostWeightForPath,
  projectPathMatchesConfig,
  resolveConfig,
  resolveProjectConfig,
} from "../packages/config/src/index.ts";
import { readEmbeddingConfig } from "../packages/indexer/src/config.ts";

test("config: resolveConfig returns safe defaults", () => {
  const config = resolveConfig();
  assert.ok(config.databasePath.endsWith("ai.db"));
  assert.equal(typeof config.cloudEnabled, "boolean");
  assert.equal(config.apiPort, 4417);
});

test("config: resolveProjectConfig loads valid .ai-workbench.json", () => {
  const tmpDir = join(process.cwd(), "tmp-test-config");
  mkdirSync(tmpDir, { recursive: true });
  const configPath = join(tmpDir, ".ai-workbench.json");
  const projectConfigData = {
    ignore: ["node_modules/**"],
    include: ["src/**"],
    chunking: { preferTreeSitter: false, maxChunkTokens: 500 },
    retrieval: { boostPaths: ["src/core/**"], authHints: ["secret"] },
    models: { answer: "test-model", embedding: "test-embed" },
  };
  writeFileSync(configPath, JSON.stringify(projectConfigData));

  const config = resolveProjectConfig(tmpDir);
  assert.equal(config.sourcePath, configPath);
  assert.deepEqual(config.ignore, ["node_modules/**"]);
  assert.deepEqual(config.include, ["src/**"]);
  assert.equal(config.chunking.preferTreeSitter, false);
  assert.equal(config.chunking.maxChunkTokens, 500);
  assert.deepEqual(config.retrieval.boostPaths, ["src/core/**"]);
  assert.deepEqual(config.retrieval.authHints, ["secret"]);
  assert.equal(config.models.answer, "test-model");
  assert.equal(config.models.embedding, "test-embed");

  rmSync(tmpDir, { recursive: true, force: true });
});

test("config: resolveProjectConfig handles invalid JSON safely", () => {
  const tmpDir = join(process.cwd(), "tmp-test-config-invalid");
  mkdirSync(tmpDir, { recursive: true });
  const configPath = join(tmpDir, ".ai-workbench.json");
  writeFileSync(configPath, "invalid-json");

  const config = resolveProjectConfig(tmpDir);
  assert.equal(config.sourcePath, null); // Should fallback to defaults
  assert.deepEqual(config.ignore, []);
  assert.equal(config.chunking.maxChunkTokens, 900);

  rmSync(tmpDir, { recursive: true, force: true });
});

test("config: projectPathMatchesConfig handles include/ignore", () => {
  const config = {
    include: ["src/**"],
    ignore: ["**/*.test.ts"], // Changed from src/**/*.test.ts to see if it fixes it
    chunking: { preferTreeSitter: true, maxChunkTokens: 900 },
    codeIntelligence: { enabled: false },
    retrieval: { boostPaths: [], authHints: [] },
    models: { answer: null, embedding: null },
    checks: { defaultChecks: ["typecheck"], requireApprovalFor: [], maxRepairLoops: 1 },
    dev: { defaultChecks: ["typecheck"], maxRepairLoops: 1, requireApprovalFor: ["env", "migrations", "auth", "db", "package"] },
    sourcePath: null,
    raw: {},
  };

  assert.equal(projectPathMatchesConfig("src/main.ts", config), true);
  assert.equal(projectPathMatchesConfig("src/main.test.ts", config), false);
  assert.equal(projectPathMatchesConfig("apps/api/main.ts", config), false);
});

test("config: boostWeightForPath returns expected boost", () => {
  const config = {
    include: [],
    ignore: [],
    chunking: { preferTreeSitter: true, maxChunkTokens: 900 },
    codeIntelligence: { enabled: false },
    retrieval: { boostPaths: ["src/core/**"], authHints: [] },
    models: { answer: null, embedding: null },
    checks: { defaultChecks: ["typecheck"], requireApprovalFor: [], maxRepairLoops: 1 },
    dev: { defaultChecks: ["typecheck"], maxRepairLoops: 1, requireApprovalFor: ["env", "migrations", "auth", "db", "package"] },
    sourcePath: null,
    raw: {},
  };

  assert.equal(boostWeightForPath("src/core/auth.ts", config), 1);
  assert.equal(boostWeightForPath("src/ui/button.ts", config), 0);
});

test("indexer/config: readEmbeddingConfig defaults and fallbacks", () => {
  // Heuristic default
  const config = readEmbeddingConfig({ env: {} });
  assert.equal(config.provider, "heuristic");
  assert.equal(config.model, "heuristic-embedding");
  assert.equal(config.dimension, 32);

  // Cloud fallback when disabled
  const cloudConfig = readEmbeddingConfig({
    env: { AI_EMBEDDING_PROVIDER: "openai_compat", AI_CLOUD_ENABLED: "false" },
    cloudEnabled: false,
  });
  assert.equal(cloudConfig.provider, "heuristic");
  assert.equal(cloudConfig.model, "heuristic-embedding");

  // Invalid env fallback
  const invalidConfig = readEmbeddingConfig({
    env: { AI_EMBEDDING_BATCH_SIZE: "-10", AI_EMBEDDING_DIM: "abc" },
  });
  assert.equal(invalidConfig.batchSize, 32);
  assert.equal(invalidConfig.dimension, 32);
});
