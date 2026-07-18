import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProjectManifest, WorkflowDefinition, WorkflowStepDefinition } from "../packages/contracts/src/index.ts";
import {
  collectWorkflowPlanApprovalContext,
  prepareWorkflowPlan,
  workflowPlanApprovalContextHash,
} from "../packages/execution-engine/src/workflow-plans.ts";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/contracts/v1-control-plane.json", import.meta.url), "utf8")
) as { ProjectManifest: ProjectManifest; WorkflowDefinition: WorkflowDefinition };

function step(
  id: string,
  workflowId: string,
  dependsOn: string[] = []
): WorkflowStepDefinition {
  return {
    id,
    name: id,
    workflowId,
    dependsOn,
    executionMode: "direct",
    mutation: "read_only",
    approvalRequired: false,
    timeoutSeconds: 30,
    retryLimit: 0,
    successCriteria: ["exit code is zero"],
    recoveryWorkflowIds: [],
  };
}

test("workflow plans topologically order canonical command references and bind complete approval context", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-workflow-plan-"));
  const first = { ...fixture.ProjectManifest.commands.verify, id: "first", executable: "true", arguments: [] };
  const second = { ...first, id: "second" };
  const manifest: ProjectManifest = {
    ...fixture.ProjectManifest,
    id: "workflow-plan-project",
    path: workspace,
    repositoryRoot: workspace,
    approvedRoots: [workspace],
    commands: { first, second },
  };
  const definition: WorkflowDefinition = {
    ...fixture.WorkflowDefinition,
    id: "pipeline",
    projectId: manifest.id,
    command: null,
    steps: [step("second-step", "second", ["first-step"]), step("first-step", "first")],
  };
  try {
    const prepared = await prepareWorkflowPlan(manifest, definition, { allowMutating: true });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    assert.deepEqual(prepared.plan.steps.map((entry) => entry.step.id), ["first-step", "second-step"]);
    assert.equal(prepared.plan.mutation, "read_only");
    assert.equal(prepared.plan.approvalRequired, false);
    const context = await collectWorkflowPlanApprovalContext(prepared.plan);
    const initialHash = workflowPlanApprovalContextHash(context);
    const secondContext = context.steps[1];
    assert.ok(secondContext);
    secondContext.step.successCriteria.push("report exists");
    assert.notEqual(workflowPlanApprovalContextHash(context), initialHash);

    const firstDefinitionStep = definition.steps[0];
    const secondDefinitionStep = definition.steps[1];
    assert.ok(firstDefinitionStep);
    assert.ok(secondDefinitionStep);
    const mismatch = await prepareWorkflowPlan(
      manifest,
      { ...definition, steps: [{ ...firstDefinitionStep, executionMode: "background" }, secondDefinitionStep] },
      { allowMutating: true }
    );
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.equal(mismatch.rejection.code, "workflow_step_policy_mismatch");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
