import assert from "node:assert/strict";
import test from "node:test";
import { resolveConfig } from "../packages/config/src/index.ts";

test("uses separate web and api defaults", () => {
  const config = resolveConfig();
  assert.equal(config.webPort, 3000);
  assert.equal(config.apiPort, 4242);
  assert.equal(config.apiUrl, "http://127.0.0.1:4242");
});

test("derives the api url from a custom api port", () => {
  const config = resolveConfig({ apiPort: 4321 });
  assert.equal(config.webPort, 3000);
  assert.equal(config.apiPort, 4321);
  assert.equal(config.apiUrl, "http://127.0.0.1:4321");
});

test("honors runtime env overrides", () => {
  const previousDatabasePath = process.env.AI_DATABASE_PATH;
  const previousRuntimeDir = process.env.AI_RUNTIME_DIR;
  const previousApiPort = process.env.AI_API_PORT;
  const previousWebPort = process.env.AI_WEB_PORT;
  const previousApiUrl = process.env.AI_API_URL;

  process.env.AI_DATABASE_PATH = "/tmp/ai-test.db";
  process.env.AI_RUNTIME_DIR = "/tmp/ai-runtime";
  process.env.AI_API_PORT = "4999";
  process.env.AI_WEB_PORT = "3999";
  process.env.AI_API_URL = "http://127.0.0.1:4999";

  try {
    const config = resolveConfig();
    assert.equal(config.databasePath, "/tmp/ai-test.db");
    assert.equal(config.runtimeDir, "/tmp/ai-runtime");
    assert.equal(config.apiPort, 4999);
    assert.equal(config.webPort, 3999);
    assert.equal(config.apiUrl, "http://127.0.0.1:4999");
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
  }
});
