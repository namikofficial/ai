import { createHash } from "node:crypto";
import type {
  MutationClass,
  ProjectManifest,
  WorkflowDefinition,
  WorkflowStepDefinition,
} from "../../contracts/src/index.ts";
import {
  collectWorkflowApprovalContext,
  type PreparedManifestWorkflow,
  prepareManifestWorkflow,
  type WorkflowApprovalContext,
} from "./workflows.ts";

export interface PreparedWorkflowPlanStep {
  step: WorkflowStepDefinition;
  workflow: PreparedManifestWorkflow | null;
}

export interface PreparedWorkflowPlan {
  definition: WorkflowDefinition;
  projectId: string;
  steps: PreparedWorkflowPlanStep[];
  mutation: MutationClass;
  approvalRequired: boolean;
  backgroundRequired: boolean;
  isolationRequired: boolean;
}

export interface WorkflowPlanRejection {
  code:
    | "workflow_definition_not_found"
    | "workflow_definition_disabled"
    | "workflow_definition_project_mismatch"
    | "workflow_step_rejected"
    | "workflow_step_policy_mismatch"
    | "workflow_desktop_step_unsupported";
  summary: string;
}

const MUTATION_RANK: Record<MutationClass, number> = {
  read_only: 0,
  workspace_write: 1,
  project_write: 2,
  external: 3,
  destructive: 4,
};

function strongestMutation(values: MutationClass[]): MutationClass {
  return values.reduce<MutationClass>(
    (strongest, value) => (MUTATION_RANK[value] > MUTATION_RANK[strongest] ? value : strongest),
    "read_only"
  );
}

function topologicalSteps(definition: WorkflowDefinition): WorkflowStepDefinition[] {
  const steps = new Map(definition.steps.map((step) => [step.id, step]));
  const visited = new Set<string>();
  const ordered: WorkflowStepDefinition[] = [];
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    const step = steps.get(id);
    if (!step) throw new Error(`unknown workflow step: ${id}`);
    for (const dependency of step.dependsOn) visit(dependency);
    visited.add(id);
    ordered.push(step);
  };
  for (const step of definition.steps) visit(step.id);
  return ordered;
}

export async function prepareWorkflowPlan(
  manifest: ProjectManifest,
  definition: WorkflowDefinition | null,
  options: { allowMutating?: boolean; allowInteractive?: boolean } = {}
): Promise<{ ok: true; plan: PreparedWorkflowPlan } | { ok: false; rejection: WorkflowPlanRejection }> {
  if (!definition) {
    return {
      ok: false,
      rejection: { code: "workflow_definition_not_found", summary: "canonical workflow definition not found" },
    };
  }
  if (definition.projectId !== manifest.id) {
    return {
      ok: false,
      rejection: {
        code: "workflow_definition_project_mismatch",
        summary: `workflow ${definition.id} belongs to a different project`,
      },
    };
  }
  if (!definition.enabled) {
    return {
      ok: false,
      rejection: { code: "workflow_definition_disabled", summary: `workflow ${definition.id} is disabled` },
    };
  }
  if (definition.command) {
    const prepared = await prepareManifestWorkflow(
      { ...manifest, commands: { ...manifest.commands, [definition.id]: definition.command } },
      definition.id,
      options
    );
    if (!prepared.ok) {
      return {
        ok: false,
        rejection: { code: "workflow_step_rejected", summary: prepared.rejection.summary },
      };
    }
    return {
      ok: true,
      plan: {
        definition,
        projectId: manifest.id,
        steps: [
          {
            step: {
              id: "command",
              name: definition.name,
              workflowId: definition.id,
              dependsOn: [],
              executionMode: definition.command.executionMode,
              mutation: definition.command.mutation,
              approvalRequired: definition.approvalRequired,
              timeoutSeconds: definition.command.timeoutSeconds,
              retryLimit: definition.command.retryLimit,
              successCriteria: definition.command.successCriteria,
              recoveryWorkflowIds: definition.command.recoveryWorkflowIds,
            },
            workflow: prepared.workflow,
          },
        ],
        mutation: definition.command.mutation,
        approvalRequired: definition.approvalRequired || definition.command.mutation !== "read_only",
        backgroundRequired: definition.command.executionMode === "background",
        isolationRequired: definition.isolationRequired || definition.command.executionMode === "isolated",
      },
    };
  }

  const preparedSteps: PreparedWorkflowPlanStep[] = [];
  for (const step of topologicalSteps(definition)) {
    if (!step.workflowId) {
      preparedSteps.push({ step, workflow: null });
      continue;
    }
    const prepared = await prepareManifestWorkflow(manifest, step.workflowId, options);
    if (!prepared.ok) {
      return {
        ok: false,
        rejection: {
          code: "workflow_step_rejected",
          summary: `workflow ${definition.id} step ${step.id}: ${prepared.rejection.summary}`,
        },
      };
    }
    if (
      prepared.workflow.command.executionMode !== step.executionMode ||
      prepared.workflow.command.mutation !== step.mutation
    ) {
      return {
        ok: false,
        rejection: {
          code: "workflow_step_policy_mismatch",
          summary: `workflow ${definition.id} step ${step.id} does not match the referenced command policy`,
        },
      };
    }
    if (step.retryLimit > 0 && step.mutation !== "read_only") {
      return {
        ok: false,
        rejection: {
          code: "workflow_step_policy_mismatch",
          summary: `workflow ${definition.id} step ${step.id} cannot automatically retry a ${step.mutation} command`,
        },
      };
    }
    if (step.executionMode === "terminal" || step.executionMode === "tmux") {
      return {
        ok: false,
        rejection: {
          code: "workflow_desktop_step_unsupported",
          summary: `workflow ${definition.id} step ${step.id} requires an interactive desktop handoff`,
        },
      };
    }
    preparedSteps.push({
      step,
      workflow: {
        ...prepared.workflow,
        command: {
          ...prepared.workflow.command,
          timeoutSeconds: step.timeoutSeconds ?? prepared.workflow.command.timeoutSeconds,
          retryLimit: step.retryLimit,
          successCriteria: step.successCriteria,
          recoveryWorkflowIds: step.recoveryWorkflowIds,
        },
      },
    });
  }
  const mutations = preparedSteps.map((entry) => entry.step.mutation);
  return {
    ok: true,
    plan: {
      definition,
      projectId: manifest.id,
      steps: preparedSteps,
      mutation: strongestMutation(mutations),
      approvalRequired:
        definition.approvalRequired ||
        preparedSteps.some((entry) => entry.step.approvalRequired || entry.step.mutation !== "read_only"),
      backgroundRequired: preparedSteps.some((entry) => entry.step.executionMode === "background"),
      isolationRequired:
        definition.isolationRequired || preparedSteps.some((entry) => entry.step.executionMode === "isolated"),
    },
  };
}

export interface WorkflowPlanApprovalContext {
  projectId: string;
  workflowId: string;
  definition: WorkflowDefinition;
  steps: Array<{ step: WorkflowStepDefinition; context: WorkflowApprovalContext | null }>;
}

export async function collectWorkflowPlanApprovalContext(
  plan: PreparedWorkflowPlan
): Promise<WorkflowPlanApprovalContext> {
  return {
    projectId: plan.projectId,
    workflowId: plan.definition.id,
    definition: plan.definition,
    steps: await Promise.all(
      plan.steps.map(async (entry) => ({
        step: entry.step,
        context: entry.workflow ? await collectWorkflowApprovalContext(entry.workflow) : null,
      }))
    ),
  };
}

export function workflowPlanApprovalContextHash(context: WorkflowPlanApprovalContext): string {
  return createHash("sha256").update(JSON.stringify(context)).digest("hex");
}
