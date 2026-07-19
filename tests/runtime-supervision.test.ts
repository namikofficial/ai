import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("runtime supervision uses one combined web/API owner and a dependent worker", async () => {
  const [workbench, worker, target, cli] = await Promise.all([
    read("systemd/user/ai-workbench.service"),
    read("systemd/user/ai-workbench-worker.service"),
    read("systemd/user/ai-workbench.target"),
    read("cli/ai/src/main.ts"),
  ]);

  assert.match(workbench, /^ExecStart=\/usr\/bin\/node --experimental-strip-types cli\/ai\/src\/main\.ts web$/m);
  assert.doesNotMatch(workbench, / pnpm /);
  assert.match(workbench, /^ExecStartPost=\/usr\/bin\/env bash scripts\/wait-ready\.sh$/m);
  assert.match(workbench, /^EnvironmentFile=-%h\/\.config\/ai-workbench\/runtime\.env$/m);
  assert.match(workbench, /^Wants=ai-workbench-worker\.service$/m);
  assert.match(workbench, /^Before=ai-workbench-worker\.service$/m);
  assert.match(workbench, /^PartOf=ai-workbench\.target$/m);
  assert.match(worker, /^Requires=ai-workbench\.service$/m);
  assert.match(worker, /^After=ai-workbench\.service$/m);
  assert.match(worker, /^ExecStart=\/usr\/bin\/node --experimental-strip-types cli\/ai\/src\/main\.ts worker$/m);
  assert.match(target, /^Wants=ai-workbench\.service ai-workbench-worker\.service$/m);
  const webCommand = /if \(command === "web"\) \{([\s\S]*?)\n {2}\}\n\n {2}if \(command === "worker"\)/.exec(cli)?.[1];
  assert.ok(webCommand);
  assert.match(webCommand, /await startWorkbenchWeb\(/);
  assert.doesNotMatch(webCommand, /await startWorkbenchServer\(/);
  assert.doesNotMatch(webCommand, /apiHandle/);
});

test("runtime configuration keeps optional services optional and cloud disabled", async () => {
  const runtimeEnvironment = await read("systemd/runtime.env.example");
  assert.match(runtimeEnvironment, /^AI_API_PORT=4417$/m);
  assert.match(runtimeEnvironment, /^AI_WEB_PORT=4317$/m);
  assert.match(runtimeEnvironment, /^AI_QDRANT_ENABLED=false$/m);
  assert.match(runtimeEnvironment, /^AI_CLOUD_ENABLED=false$/m);
});
