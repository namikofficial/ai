import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ProjectManifest } from "../packages/contracts/src/index.ts";
import {
  activeContextSchema,
  activeWorkSchema,
  contractJsonSchemas,
  desktopObservationSchema,
  projectManifestSchema,
  projectStatusSchema,
  recommendedActionSchema,
  runtimeHealthSchema,
  workbenchEventSchema,
  workflowDefinitionSchema,
  workflowExecutionSchema,
  workflowLaunchSchema,
} from "../packages/contracts/src/index.ts";

const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures/contracts/v1-control-plane.json", import.meta.url), "utf8")
) as Record<string, unknown>;

const schemas = {
  ProjectManifest: projectManifestSchema,
  ActiveContext: activeContextSchema,
  ActiveWork: activeWorkSchema,
  RuntimeHealth: runtimeHealthSchema,
  ProjectStatus: projectStatusSchema,
  RecommendedAction: recommendedActionSchema,
  WorkbenchEvent: workbenchEventSchema,
  WorkflowDefinition: workflowDefinitionSchema,
  WorkflowExecution: workflowExecutionSchema,
  WorkflowLaunch: workflowLaunchSchema,
  DesktopObservation: desktopObservationSchema,
};

test("parses all representative v1 control-plane fixtures", () => {
  for (const [name, schema] of Object.entries(schemas)) {
    const parsed = schema.parse(fixtures[name], name);
    assert.equal(parsed.schemaVersion, 1, name);
    assert.equal(typeof parsed.id, "string", name);
    assert.equal(parsed.origin.source.length > 0, true, name);
  }
});

test("publishes generated JSON schema for every public contract", () => {
  assert.deepEqual(Object.keys(contractJsonSchemas), Object.keys(schemas));
  for (const [name, schema] of Object.entries(contractJsonSchemas)) {
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema", name);
    assert.equal((schema.properties as Record<string, { const?: number }>).schemaVersion?.const, 1, name);
  }
});

test("accepts a legacy unversioned payload and normalizes it to v1", () => {
  const legacy = structuredClone(fixtures.ActiveContext) as Record<string, unknown>;
  delete legacy.schemaVersion;
  const parsed = activeContextSchema.parse(legacy);
  assert.equal(parsed.schemaVersion, 1);

  const legacyWork = structuredClone(fixtures.ActiveWork) as Record<string, unknown>;
  delete legacyWork.workflowExecutionId;
  delete legacyWork.workflowId;
  delete legacyWork.recoveryWorkflowIds;
  const normalizedWork = activeWorkSchema.parse(legacyWork);
  assert.equal(normalizedWork.workflowExecutionId, null);
  assert.equal(normalizedWork.workflowId, null);
  assert.deepEqual(normalizedWork.recoveryWorkflowIds, []);
});

test("rejects unsupported contract versions", () => {
  const future = { ...(fixtures.ActiveContext as Record<string, unknown>), schemaVersion: 2 };
  assert.throws(() => activeContextSchema.parse(future), /schemaVersion must equal 1/);
});

test("rejects invalid unified states and confidence scores", () => {
  assert.throws(
    () => activeContextSchema.parse({ ...(fixtures.ActiveContext as Record<string, unknown>), state: "healthy" }),
    /must be one of/
  );
  assert.throws(
    () => activeContextSchema.parse({ ...(fixtures.ActiveContext as Record<string, unknown>), confidence: 1.1 }),
    /must be <= 1/
  );
});

test("requires structured workflow commands instead of shell command strings", () => {
  const manifest = structuredClone(fixtures.ProjectManifest) as Record<string, unknown>;
  manifest.commands = { verify: "pnpm verify" };
  assert.throws(() => projectManifestSchema.parse(manifest), /commands.verify must be an object/);
});

test("normalizes legacy command execution modes without allowing an interactive direct process", () => {
  const legacy = structuredClone(fixtures.ProjectManifest) as Record<string, unknown>;
  const commands = legacy.commands as Record<string, Record<string, unknown>>;
  delete commands.verify?.executionMode;
  delete commands.verify?.retryLimit;
  delete commands.verify?.retryDelaySeconds;
  delete commands.verify?.expectedArtifacts;
  delete commands.verify?.successCriteria;
  delete commands.verify?.recoveryWorkflowIds;
  commands.verify.interactive = true;
  const normalized = projectManifestSchema.parse(legacy).commands.verify;
  assert.equal(normalized?.executionMode, "terminal");
  assert.equal(normalized?.retryLimit, 0);
  assert.equal(normalized?.retryDelaySeconds, 0);
  assert.deepEqual(normalized?.expectedArtifacts, []);
  commands.verify.executionMode = "direct";
  assert.throws(() => projectManifestSchema.parse(legacy), /must be terminal or tmux/);
});

test("validates bounded retry and typed expected-artifact policy", () => {
  const manifest = structuredClone(fixtures.ProjectManifest) as Record<string, unknown>;
  const verify = (manifest.commands as Record<string, Record<string, unknown>>).verify;
  verify.retryLimit = 6;
  assert.throws(() => projectManifestSchema.parse(manifest), /retryLimit must be <= 5/);
  verify.retryLimit = 1;
  verify.expectedArtifacts = [{ id: "report", path: "report.json", kind: "socket", required: true }];
  assert.throws(() => projectManifestSchema.parse(manifest), /kind must be one of/);
});

test("workflow definitions reject ambiguous and cyclic task graphs", () => {
  const ambiguous = structuredClone(fixtures.WorkflowDefinition) as Record<string, unknown>;
  ambiguous.command = (fixtures.ProjectManifest as ProjectManifest).commands.verify;
  assert.throws(() => workflowDefinitionSchema.parse(ambiguous), /either command or steps/);

  const cyclic = structuredClone(fixtures.WorkflowDefinition) as Record<string, unknown>;
  const first = ((cyclic.steps as Array<Record<string, unknown>>)[0] ?? {}) as Record<string, unknown>;
  first.dependsOn = ["second"];
  (cyclic.steps as Array<Record<string, unknown>>).push({
    ...first,
    id: "second",
    name: "Second",
    dependsOn: [first.id],
  });
  assert.throws(() => workflowDefinitionSchema.parse(cyclic), /dependency cycle/);
});

test("represents an untracked-only repository as dirty", () => {
  const parsed = projectStatusSchema.parse(fixtures.ProjectStatus);
  assert.equal(parsed.git?.untracked, 1);
  assert.equal(parsed.git?.dirty, true);
});

test("desktop observations require tmux association data to be explicit", () => {
  const observation = structuredClone(fixtures.DesktopObservation) as Record<string, unknown>;
  observation.tmux = { session: "unrelated" };
  assert.throws(() => desktopObservationSchema.parse(observation), /tmux.clientPid/);
  observation.tmux = { clientPid: 4, session: null, paneId: null, cwd: null, associationVerified: false };
  assert.doesNotThrow(() => desktopObservationSchema.parse(observation));
});
