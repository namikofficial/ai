import {
  type ActiveContext,
  type ActiveWork,
  CONTROL_PLANE_SCHEMA_VERSION,
  type CommandDefinition,
  type DesktopObservation,
  type ProjectManifest,
  type ProjectStatus,
  type RecommendedAction,
  type RuntimeHealth,
  UNIFIED_STATES,
  type UnifiedState,
  type WorkbenchEvent,
  type WorkflowDefinition,
  type WorkflowExecution,
  type WorkflowLaunch,
} from "./types.ts";

export interface ContractSchema<T> {
  parse(value: unknown, path?: string): T;
  jsonSchema: Record<string, unknown>;
  optional?: boolean;
}

type Shape = Record<string, ContractSchema<unknown>>;
type InferShape<T extends Shape> = { [K in keyof T]: T[K] extends ContractSchema<infer V> ? V : never };

function fail(path: string, message: string): never {
  throw new TypeError(`${path} ${message}`);
}

function scalar<T>(jsonSchema: Record<string, unknown>, parse: (value: unknown, path: string) => T): ContractSchema<T> {
  return { jsonSchema, parse };
}

const nonEmptyString = scalar<string>({ type: "string", minLength: 1 }, (value, path) => {
  if (typeof value !== "string" || value.trim() === "") fail(path, "must be a non-empty string");
  return value.trim();
});

const isoTimestamp = scalar<string>({ type: "string", format: "date-time" }, (value, path) => {
  const parsed = nonEmptyString.parse(value, path);
  if (!Number.isFinite(Date.parse(parsed))) fail(path, "must be an ISO-compatible timestamp");
  return parsed;
});

const booleanSchema = scalar<boolean>({ type: "boolean" }, (value, path) => {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
});

function numberSchema(options: { minimum?: number; maximum?: number; integer?: boolean } = {}): ContractSchema<number> {
  return scalar({ type: options.integer ? "integer" : "number", ...options }, (value, path) => {
    if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "must be a finite number");
    if (options.integer && !Number.isInteger(value)) fail(path, "must be an integer");
    if (options.minimum !== undefined && value < options.minimum) fail(path, `must be >= ${options.minimum}`);
    if (options.maximum !== undefined && value > options.maximum) fail(path, `must be <= ${options.maximum}`);
    return value;
  });
}

function literalSchema<T extends string | number>(literal: T): ContractSchema<T> {
  return scalar({ const: literal }, (value, path) =>
    value === literal ? literal : fail(path, `must equal ${literal}`)
  );
}

function enumSchema<const T extends readonly string[]>(values: T): ContractSchema<T[number]> {
  return scalar({ type: "string", enum: values }, (value, path) => {
    if (typeof value !== "string" || !values.includes(value)) fail(path, `must be one of: ${values.join(", ")}`);
    return value;
  });
}

function nullable<T>(schema: ContractSchema<T>): ContractSchema<T | null> {
  return {
    jsonSchema: { anyOf: [schema.jsonSchema, { type: "null" }] },
    parse: (value, path = "value") => (value === null ? null : schema.parse(value, path)),
  };
}

function defaulted<T>(schema: ContractSchema<T>, fallback: T): ContractSchema<T> {
  return {
    jsonSchema: { ...schema.jsonSchema, default: fallback },
    optional: true,
    parse: (value, path = "value") => (value === undefined ? fallback : schema.parse(value, path)),
  };
}

function arraySchema<T>(schema: ContractSchema<T>): ContractSchema<T[]> {
  return {
    jsonSchema: { type: "array", items: schema.jsonSchema },
    parse: (value, path = "value") => {
      if (!Array.isArray(value)) fail(path, "must be an array");
      return value.map((item, index) => schema.parse(item, `${path}[${index}]`));
    },
  };
}

function objectSchema<T extends Shape>(shape: T): ContractSchema<InferShape<T>> {
  return {
    jsonSchema: {
      type: "object",
      additionalProperties: true,
      required: Object.entries(shape)
        .filter(([, schema]) => !schema.optional)
        .map(([key]) => key),
      properties: Object.fromEntries(Object.entries(shape).map(([key, schema]) => [key, schema.jsonSchema])),
    },
    parse: (value, path = "value") => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "must be an object");
      const input = value as Record<string, unknown>;
      const output: Record<string, unknown> = {};
      for (const [key, schema] of Object.entries(shape)) output[key] = schema.parse(input[key], `${path}.${key}`);
      return output as InferShape<T>;
    },
  };
}

function recordSchema<T>(schema: ContractSchema<T>): ContractSchema<Record<string, T>> {
  return {
    jsonSchema: { type: "object", additionalProperties: schema.jsonSchema },
    parse: (value, path = "value") => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "must be an object");
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          key,
          schema.parse(item, `${path}.${key}`),
        ])
      );
    },
  };
}

const unknownRecord = scalar<Record<string, unknown>>({ type: "object" }, (value, path) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "must be an object");
  return value as Record<string, unknown>;
});

const strings = arraySchema(nonEmptyString);
const count = numberSchema({ minimum: 0, integer: true });
const confidence = numberSchema({ minimum: 0, maximum: 1 });
const stateSchema: ContractSchema<UnifiedState> = enumSchema(UNIFIED_STATES);
const originSchema = objectSchema({
  source: enumSchema(["workbench", "desktop", "cli", "mcp", "import", "legacy", "detector"] as const),
  instanceId: nullable(nonEmptyString),
  legacyRef: nullable(nonEmptyString),
});
const baseShape = {
  schemaVersion: literalSchema(CONTROL_PLANE_SCHEMA_VERSION),
  id: nonEmptyString,
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
  origin: originSchema,
  capabilities: strings,
};
const projectRefSchema = objectSchema({ id: nonEmptyString, name: nonEmptyString, path: nonEmptyString });
const blockerSchema = objectSchema({ code: nonEmptyString, summary: nonEmptyString });
const expectedArtifactSchema = objectSchema({
  id: nonEmptyString,
  path: nonEmptyString,
  kind: enumSchema(["file", "directory", "either"] as const),
  required: booleanSchema,
});

const gitStatusSchema = objectSchema({
  branch: nullable(nonEmptyString),
  head: nullable(nonEmptyString),
  detached: booleanSchema,
  unborn: booleanSchema,
  modified: count,
  staged: count,
  untracked: count,
  deleted: count,
  renamed: count,
  conflicts: count,
  stashes: count,
  ahead: count,
  behind: count,
  dirty: booleanSchema,
});

const commandRaw = objectSchema({
  id: nonEmptyString,
  name: nonEmptyString,
  description: nonEmptyString,
  category: enumSchema(["development", "check", "git", "service", "ai", "utility"] as const),
  executable: nonEmptyString,
  arguments: strings,
  workingDirectory: nullable(nonEmptyString),
  environmentRefs: strings,
  interactive: booleanSchema,
  executionMode: defaulted(enumSchema(["direct", "terminal", "tmux", "isolated", "background"] as const), "direct"),
  mutation: enumSchema(["read_only", "workspace_write", "project_write", "destructive", "external"] as const),
  timeoutSeconds: nullable(numberSchema({ minimum: 1, integer: true })),
  retryLimit: defaulted(numberSchema({ minimum: 0, maximum: 5, integer: true }), 0),
  retryDelaySeconds: defaulted(numberSchema({ minimum: 0, maximum: 300, integer: true }), 0),
  expectedArtifacts: defaulted(arraySchema(expectedArtifactSchema), []),
  successCriteria: defaulted(strings, []),
  recoveryWorkflowIds: defaulted(strings, []),
  requiresCapabilities: strings,
  visibleWhen: strings,
});
const commandSchema: ContractSchema<CommandDefinition> = {
  jsonSchema: commandRaw.jsonSchema,
  parse: (value, path = "value") => {
    const parsed = commandRaw.parse(value, path);
    const input = value as Record<string, unknown>;
    const normalized: CommandDefinition = {
      ...parsed,
      executionMode:
        typeof input.executionMode === "string" ? parsed.executionMode : parsed.interactive ? "terminal" : "direct",
    };
    if (normalized.interactive && !["terminal", "tmux"].includes(normalized.executionMode)) {
      fail(`${path}.executionMode`, "must be terminal or tmux when interactive is true");
    }
    return normalized;
  },
};

const serviceSchema = objectSchema({
  id: nonEmptyString,
  name: nonEmptyString,
  kind: enumSchema(["process", "compose", "systemd", "http", "unknown"] as const),
  workflowId: nullable(nonEmptyString),
  healthCheck: nullable(
    objectSchema({
      kind: enumSchema(["command", "http", "tcp", "process"] as const),
      target: nonEmptyString,
      timeoutSeconds: numberSchema({ minimum: 1, integer: true }),
    })
  ),
  composeProfiles: strings,
});

const projectManifestRaw = objectSchema({
  ...baseShape,
  name: nonEmptyString,
  path: nonEmptyString,
  kind: enumSchema(["repository", "monorepo", "workspace", "dotfiles", "unknown"] as const),
  repositoryRoot: nonEmptyString,
  workspaceRoots: strings,
  packageManager: enumSchema([
    "pnpm",
    "npm",
    "yarn",
    "bun",
    "cargo",
    "uv",
    "poetry",
    "gradle",
    "maven",
    "go",
    "make",
    "just",
    "unknown",
  ] as const),
  applications: arraySchema(
    objectSchema({ id: nonEmptyString, name: nonEmptyString, path: nonEmptyString, kind: nonEmptyString })
  ),
  detection: objectSchema({ markers: strings, remotes: strings, aliases: strings }),
  commands: recordSchema(commandSchema),
  checks: strings,
  services: arraySchema(serviceSchema),
  desktop: objectSchema({
    tmuxSession: nullable(nonEmptyString),
    preferredEditor: nullable(nonEmptyString),
    scratchpads: strings,
    scene: nullable(nonEmptyString),
  }),
  ai: objectSchema({
    retrievalProfile: nullable(nonEmptyString),
    defaultModelRole: nullable(nonEmptyString),
    boostPaths: strings,
    include: strings,
    exclude: strings,
    checks: strings,
    mcpCapabilities: strings,
  }),
  secretRefs: strings,
  approvedRoots: strings,
});

const evidenceSchema = objectSchema({
  kind: nonEmptyString,
  value: nonEmptyString,
  source: nonEmptyString,
  confidence,
  accepted: booleanSchema,
  reason: nonEmptyString,
});
const activeContextRaw = objectSchema({
  ...baseShape,
  observedAt: isoTimestamp,
  expiresAt: nullable(isoTimestamp),
  state: stateSchema,
  project: nullable(projectRefSchema),
  source: enumSchema([
    "explicit_override",
    "manual_pin",
    "workbench_selection",
    "workbench_route",
    "focused_editor",
    "focused_terminal",
    "focused_tmux",
    "process_cwd",
    "browser_route",
    "recent_context",
    "unresolved",
  ] as const),
  confidence,
  pinned: booleanSchema,
  pinScope: nullable(enumSchema(["workspace", "session", "persistent"] as const)),
  window: nullable(unknownRecord),
  editor: nullable(unknownRecord),
  terminal: nullable(unknownRecord),
  tmux: nullable(unknownRecord),
  git: nullable(gitStatusSchema),
  activeFile: nullable(nonEmptyString),
  selectedSymbol: nullable(nonEmptyString),
  evidence: arraySchema(evidenceSchema),
  rejectedCandidates: arraySchema(evidenceSchema),
  fallbackUsed: nullable(nonEmptyString),
  confirmationRecommended: booleanSchema,
});

const activeWorkRaw = objectSchema({
  ...baseShape,
  projectId: nonEmptyString,
  state: stateSchema,
  goalId: nullable(nonEmptyString),
  goal: nullable(nonEmptyString),
  planId: nullable(nonEmptyString),
  taskId: nullable(nonEmptyString),
  taskTitle: nullable(nonEmptyString),
  taskProgress: nullable(objectSchema({ completed: count, total: count })),
  runId: nullable(nonEmptyString),
  workflowExecutionId: defaulted(nullable(nonEmptyString), null),
  workflowId: defaulted(nullable(nonEmptyString), null),
  recoveryWorkflowIds: defaulted(strings, []),
  sessionId: nullable(nonEmptyString),
  approvalId: nullable(nonEmptyString),
  blocker: nullable(blockerSchema),
  branch: nullable(nonEmptyString),
  files: strings,
  modelRole: nullable(nonEmptyString),
  recommendedActionIds: strings,
  resumable: booleanSchema,
});

const runtimeComponentSchema = objectSchema({
  id: nonEmptyString,
  name: nonEmptyString,
  state: stateSchema,
  processAlive: nullable(booleanSchema),
  ready: booleanSchema,
  latencyMs: nullable(numberSchema({ minimum: 0 })),
  detail: nullable(nonEmptyString),
  checkedAt: isoTimestamp,
  endpoint: nullable(nonEmptyString),
  capabilities: strings,
});
const runtimeHealthRaw = objectSchema({
  ...baseShape,
  state: stateSchema,
  ready: booleanSchema,
  checkedAt: isoTimestamp,
  components: arraySchema(runtimeComponentSchema),
  blockers: arraySchema(
    objectSchema({ code: nonEmptyString, summary: nonEmptyString, componentId: nullable(nonEmptyString) })
  ),
});

const recommendedActionRaw = objectSchema({
  ...baseShape,
  projectId: nullable(nonEmptyString),
  label: nonEmptyString,
  description: nonEmptyString,
  category: enumSchema(["development", "check", "git", "service", "ai", "utility"] as const),
  state: stateSchema,
  workflowId: nullable(nonEmptyString),
  deepLink: nullable(nonEmptyString),
  disabledReason: nullable(nonEmptyString),
  priority: numberSchema({ minimum: 0, integer: true }),
  mutation: enumSchema(["read_only", "workspace_write", "project_write", "destructive", "external"] as const),
  approvalRequired: booleanSchema,
});

const projectStatusRaw = objectSchema({
  ...baseShape,
  project: nullable(projectRefSchema),
  state: stateSchema,
  context: nullable(activeContextRaw),
  git: nullable(gitStatusSchema),
  services: arraySchema(
    objectSchema({ id: nonEmptyString, name: nonEmptyString, state: stateSchema, detail: nullable(nonEmptyString) })
  ),
  checks: objectSchema({ state: stateSchema, passed: count, failed: count, running: count }),
  index: objectSchema({
    state: stateSchema,
    lastIndexedAt: nullable(isoTimestamp),
    stale: booleanSchema,
    progress: nullable(confidence),
  }),
  activeWork: nullable(activeWorkRaw),
  runtime: nullable(runtimeHealthRaw),
  blockers: arraySchema(blockerSchema),
  recommendedActions: arraySchema(recommendedActionRaw),
  generatedAt: isoTimestamp,
  staleAfter: isoTimestamp,
  workbenchAvailable: booleanSchema,
});

const workflowStepSchema = objectSchema({
  id: nonEmptyString,
  name: nonEmptyString,
  workflowId: nullable(nonEmptyString),
  dependsOn: strings,
  executionMode: enumSchema(["direct", "terminal", "tmux", "isolated", "background"] as const),
  mutation: enumSchema(["read_only", "workspace_write", "project_write", "destructive", "external"] as const),
  approvalRequired: booleanSchema,
  timeoutSeconds: nullable(numberSchema({ minimum: 1, integer: true })),
  retryLimit: count,
  successCriteria: strings,
  recoveryWorkflowIds: strings,
});
const workflowDefinitionRaw = objectSchema({
  ...baseShape,
  projectId: nullable(nonEmptyString),
  name: nonEmptyString,
  description: nonEmptyString,
  category: enumSchema(["development", "check", "git", "service", "ai", "utility"] as const),
  command: nullable(commandSchema),
  steps: arraySchema(workflowStepSchema),
  preconditions: strings,
  expectedArtifacts: strings,
  isolationRequired: booleanSchema,
  approvalRequired: booleanSchema,
  enabled: booleanSchema,
});
const workflowDefinitionValidated: ContractSchema<WorkflowDefinition> = {
  jsonSchema: workflowDefinitionRaw.jsonSchema,
  parse: (value, path = "value") => {
    const parsed = workflowDefinitionRaw.parse(value, path) as WorkflowDefinition;
    if (parsed.command !== null && parsed.steps.length > 0) {
      fail(path, "must use either command or steps, not both");
    }
    if (parsed.command === null && parsed.steps.length === 0) {
      fail(path, "must define a command or at least one step");
    }
    const stepIds = new Set<string>();
    for (const step of parsed.steps) {
      if (stepIds.has(step.id)) fail(`${path}.steps`, `contains duplicate step id: ${step.id}`);
      stepIds.add(step.id);
      if (step.workflowId === null && !step.approvalRequired) {
        fail(`${path}.steps.${step.id}`, "must reference a workflow or be an approval step");
      }
    }
    for (const step of parsed.steps) {
      for (const dependency of step.dependsOn) {
        if (!stepIds.has(dependency))
          fail(`${path}.steps.${step.id}.dependsOn`, `references unknown step: ${dependency}`);
        if (dependency === step.id) fail(`${path}.steps.${step.id}.dependsOn`, "cannot depend on itself");
      }
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const stepsById = new Map(parsed.steps.map((step) => [step.id, step]));
    const visit = (stepId: string): void => {
      if (visited.has(stepId)) return;
      if (visiting.has(stepId)) fail(`${path}.steps`, `contains a dependency cycle at: ${stepId}`);
      visiting.add(stepId);
      for (const dependency of stepsById.get(stepId)?.dependsOn ?? []) visit(dependency);
      visiting.delete(stepId);
      visited.add(stepId);
    };
    for (const step of parsed.steps) visit(step.id);
    return parsed;
  },
};
const workflowExecutionRaw = objectSchema({
  ...baseShape,
  workflowId: nonEmptyString,
  projectId: nonEmptyString,
  sessionId: nullable(nonEmptyString),
  taskId: nullable(nonEmptyString),
  runId: nullable(nonEmptyString),
  state: stateSchema,
  currentStepId: nullable(nonEmptyString),
  stepStates: recordSchema(stateSchema),
  startedAt: nullable(isoTimestamp),
  finishedAt: nullable(isoTimestamp),
  approvalId: nullable(nonEmptyString),
  exitCode: nullable(numberSchema({ integer: true })),
  artifacts: strings,
  errorCode: nullable(nonEmptyString),
  errorSummary: nullable(nonEmptyString),
  recoveryWorkflowIds: defaulted(strings, []),
  recoveryOfExecutionId: defaulted(nullable(nonEmptyString), null),
});
const workflowLaunchRaw = objectSchema({
  ...baseShape,
  executionId: nonEmptyString,
  projectId: nonEmptyString,
  sessionId: nullable(nonEmptyString),
  taskId: nullable(nonEmptyString),
  mode: enumSchema(["terminal", "tmux"] as const),
  state: stateSchema,
  command: objectSchema({ executable: nonEmptyString, arguments: strings, workingDirectory: nonEmptyString }),
  environment: recordSchema(nonEmptyString),
  tmuxSession: nullable(nonEmptyString),
  authorizationExpiresAt: nullable(isoTimestamp),
  launcherInstanceId: nullable(nonEmptyString),
  launcherPid: nullable(numberSchema({ minimum: 1, integer: true })),
  startedAt: nullable(isoTimestamp),
  finishedAt: nullable(isoTimestamp),
  exitCode: nullable(numberSchema({ integer: true })),
});

const workbenchEventRaw = objectSchema({
  ...baseShape,
  type: nonEmptyString,
  occurredAt: isoTimestamp,
  projectId: nullable(nonEmptyString),
  sessionId: nullable(nonEmptyString),
  taskId: nullable(nonEmptyString),
  runId: nullable(nonEmptyString),
  sourceService: nonEmptyString,
  severity: enumSchema(["debug", "info", "warning", "error", "critical"] as const),
  summary: nonEmptyString,
  payload: unknownRecord,
  correlationId: nonEmptyString,
  causationId: nullable(nonEmptyString),
});

const desktopObservationRaw = objectSchema({
  ...baseShape,
  observedAt: isoTimestamp,
  state: stateSchema,
  compositor: enumSchema(["hyprland", "unknown"] as const),
  workspaceId: nullable(nonEmptyString),
  window: nullable(
    objectSchema({
      address: nullable(nonEmptyString),
      pid: nullable(numberSchema({ minimum: 1, integer: true })),
      className: nullable(nonEmptyString),
      title: nullable(nonEmptyString),
      role: nullable(nonEmptyString),
    })
  ),
  process: nullable(
    objectSchema({
      pid: numberSchema({ minimum: 1, integer: true }),
      parentPid: nullable(numberSchema({ minimum: 1, integer: true })),
      cwd: nullable(nonEmptyString),
      command: nullable(nonEmptyString),
    })
  ),
  editor: nullable(objectSchema({ file: nullable(nonEmptyString), workspace: nullable(nonEmptyString) })),
  terminal: nullable(objectSchema({ cwd: nullable(nonEmptyString), shell: nullable(nonEmptyString) })),
  tmux: nullable(
    objectSchema({
      clientPid: nullable(numberSchema({ minimum: 1, integer: true })),
      session: nullable(nonEmptyString),
      paneId: nullable(nonEmptyString),
      cwd: nullable(nonEmptyString),
      associationVerified: booleanSchema,
    })
  ),
  browser: nullable(objectSchema({ url: nullable(nonEmptyString), projectId: nullable(nonEmptyString) })),
  explicitProjectId: nullable(nonEmptyString),
  transientWindow: booleanSchema,
});

function publicSchema<T>(schema: ContractSchema<T>): ContractSchema<T> {
  return {
    jsonSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", ...schema.jsonSchema },
    parse: (value, path) => {
      if (typeof value === "object" && value !== null && !Array.isArray(value) && !("schemaVersion" in value)) {
        return schema.parse({ ...value, schemaVersion: CONTROL_PLANE_SCHEMA_VERSION }, path);
      }
      return schema.parse(value, path);
    },
  };
}

export const projectManifestSchema = publicSchema(projectManifestRaw) as ContractSchema<ProjectManifest>;
export const activeContextSchema = publicSchema(activeContextRaw) as ContractSchema<ActiveContext>;
export const activeWorkSchema = publicSchema(activeWorkRaw) as ContractSchema<ActiveWork>;
export const runtimeHealthSchema = publicSchema(runtimeHealthRaw) as ContractSchema<RuntimeHealth>;
export const projectStatusSchema = publicSchema(projectStatusRaw) as ContractSchema<ProjectStatus>;
export const recommendedActionSchema = publicSchema(recommendedActionRaw) as ContractSchema<RecommendedAction>;
export const workbenchEventSchema = publicSchema(workbenchEventRaw) as ContractSchema<WorkbenchEvent>;
export const workflowDefinitionSchema = publicSchema(workflowDefinitionValidated);
export const workflowExecutionSchema = publicSchema(workflowExecutionRaw) as ContractSchema<WorkflowExecution>;
export const workflowLaunchSchema = publicSchema(workflowLaunchRaw) as ContractSchema<WorkflowLaunch>;
export const desktopObservationSchema = publicSchema(desktopObservationRaw) as ContractSchema<DesktopObservation>;

export const contractJsonSchemas = Object.freeze({
  ProjectManifest: projectManifestSchema.jsonSchema,
  ActiveContext: activeContextSchema.jsonSchema,
  ActiveWork: activeWorkSchema.jsonSchema,
  RuntimeHealth: runtimeHealthSchema.jsonSchema,
  ProjectStatus: projectStatusSchema.jsonSchema,
  RecommendedAction: recommendedActionSchema.jsonSchema,
  WorkbenchEvent: workbenchEventSchema.jsonSchema,
  WorkflowDefinition: workflowDefinitionSchema.jsonSchema,
  WorkflowExecution: workflowExecutionSchema.jsonSchema,
  WorkflowLaunch: workflowLaunchSchema.jsonSchema,
  DesktopObservation: desktopObservationSchema.jsonSchema,
});
