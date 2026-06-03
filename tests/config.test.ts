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
