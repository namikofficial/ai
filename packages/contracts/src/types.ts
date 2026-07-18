export const CONTROL_PLANE_SCHEMA_VERSION = 1 as const;
export type ControlPlaneSchemaVersion = typeof CONTROL_PLANE_SCHEMA_VERSION;

export const UNIFIED_STATES = [
  "unknown",
  "offline",
  "starting",
  "loading",
  "ready",
  "running",
  "stale",
  "waiting",
  "blocked",
  "failed",
  "completed",
  "cancelled",
] as const;
export type UnifiedState = (typeof UNIFIED_STATES)[number];
export type ContractSource = "workbench" | "desktop" | "cli" | "mcp" | "import" | "legacy" | "detector";
export type PackageManager =
  | "pnpm"
  | "npm"
  | "yarn"
  | "bun"
  | "cargo"
  | "uv"
  | "poetry"
  | "gradle"
  | "maven"
  | "go"
  | "make"
  | "just"
  | "unknown";
export type ProjectKind = "repository" | "monorepo" | "workspace" | "dotfiles" | "unknown";
export type WorkflowCategory = "development" | "check" | "git" | "service" | "ai" | "utility";
export type MutationClass = "read_only" | "workspace_write" | "project_write" | "destructive" | "external";
export type ExecutionMode = "direct" | "terminal" | "tmux" | "isolated" | "background";

export interface ContractOrigin {
  source: ContractSource;
  instanceId: string | null;
  legacyRef: string | null;
}

export interface VersionedContract {
  schemaVersion: ControlPlaneSchemaVersion;
  id: string;
  createdAt: string;
  updatedAt: string;
  origin: ContractOrigin;
  capabilities: string[];
}

export interface CommandDefinition {
  id: string;
  name: string;
  description: string;
  category: WorkflowCategory;
  executable: string;
  arguments: string[];
  workingDirectory: string | null;
  environmentRefs: string[];
  interactive: boolean;
  mutation: MutationClass;
  timeoutSeconds: number | null;
  requiresCapabilities: string[];
  visibleWhen: string[];
}

export interface ServiceDefinition {
  id: string;
  name: string;
  kind: "process" | "compose" | "systemd" | "http" | "unknown";
  workflowId: string | null;
  healthCheck: {
    kind: "command" | "http" | "tcp" | "process";
    target: string;
    timeoutSeconds: number;
  } | null;
  composeProfiles: string[];
}

export interface ProjectManifest extends VersionedContract {
  name: string;
  path: string;
  kind: ProjectKind;
  repositoryRoot: string;
  workspaceRoots: string[];
  packageManager: PackageManager;
  applications: Array<{ id: string; name: string; path: string; kind: string }>;
  detection: { markers: string[]; remotes: string[]; aliases: string[] };
  commands: Record<string, CommandDefinition>;
  checks: string[];
  services: ServiceDefinition[];
  desktop: {
    tmuxSession: string | null;
    preferredEditor: string | null;
    scratchpads: string[];
    scene: string | null;
  };
  ai: {
    retrievalProfile: string | null;
    defaultModelRole: string | null;
    boostPaths: string[];
    include: string[];
    exclude: string[];
    checks: string[];
    mcpCapabilities: string[];
  };
  secretRefs: string[];
  approvedRoots: string[];
}

export type ActiveContextSource =
  | "explicit_override"
  | "manual_pin"
  | "workbench_selection"
  | "workbench_route"
  | "focused_editor"
  | "focused_terminal"
  | "focused_tmux"
  | "process_cwd"
  | "browser_route"
  | "recent_context"
  | "unresolved";

export interface ContextEvidence {
  kind: string;
  value: string;
  source: string;
  confidence: number;
  accepted: boolean;
  reason: string;
}

export interface GitStatus {
  branch: string | null;
  head: string | null;
  detached: boolean;
  unborn: boolean;
  modified: number;
  staged: number;
  untracked: number;
  deleted: number;
  renamed: number;
  conflicts: number;
  stashes: number;
  ahead: number;
  behind: number;
  dirty: boolean;
}

export interface ActiveContext extends VersionedContract {
  observedAt: string;
  expiresAt: string | null;
  state: UnifiedState;
  project: { id: string; name: string; path: string } | null;
  source: ActiveContextSource;
  confidence: number;
  pinned: boolean;
  pinScope: "workspace" | "session" | "persistent" | null;
  window: Record<string, unknown> | null;
  editor: Record<string, unknown> | null;
  terminal: Record<string, unknown> | null;
  tmux: Record<string, unknown> | null;
  git: GitStatus | null;
  activeFile: string | null;
  selectedSymbol: string | null;
  evidence: ContextEvidence[];
  rejectedCandidates: ContextEvidence[];
  fallbackUsed: string | null;
  confirmationRecommended: boolean;
}

export interface ActiveWork extends VersionedContract {
  projectId: string;
  state: UnifiedState;
  goalId: string | null;
  goal: string | null;
  planId: string | null;
  taskId: string | null;
  taskTitle: string | null;
  taskProgress: { completed: number; total: number } | null;
  runId: string | null;
  sessionId: string | null;
  approvalId: string | null;
  blocker: { code: string; summary: string } | null;
  branch: string | null;
  files: string[];
  modelRole: string | null;
  recommendedActionIds: string[];
  resumable: boolean;
}

export interface RuntimeComponentHealth {
  id: string;
  name: string;
  state: UnifiedState;
  processAlive: boolean | null;
  ready: boolean;
  latencyMs: number | null;
  detail: string | null;
  checkedAt: string;
  endpoint: string | null;
  capabilities: string[];
}

export interface RuntimeHealth extends VersionedContract {
  state: UnifiedState;
  ready: boolean;
  checkedAt: string;
  components: RuntimeComponentHealth[];
  blockers: Array<{ code: string; summary: string; componentId: string | null }>;
}

export interface RecommendedAction extends VersionedContract {
  projectId: string | null;
  label: string;
  description: string;
  category: WorkflowCategory;
  state: UnifiedState;
  workflowId: string | null;
  deepLink: string | null;
  disabledReason: string | null;
  priority: number;
  mutation: MutationClass;
  approvalRequired: boolean;
}

export interface ProjectStatus extends VersionedContract {
  project: { id: string; name: string; path: string } | null;
  state: UnifiedState;
  context: ActiveContext | null;
  git: GitStatus | null;
  services: Array<{ id: string; name: string; state: UnifiedState; detail: string | null }>;
  checks: { state: UnifiedState; passed: number; failed: number; running: number };
  index: { state: UnifiedState; lastIndexedAt: string | null; stale: boolean; progress: number | null };
  activeWork: ActiveWork | null;
  runtime: RuntimeHealth | null;
  blockers: Array<{ code: string; summary: string }>;
  recommendedActions: RecommendedAction[];
  generatedAt: string;
  staleAfter: string;
  workbenchAvailable: boolean;
}

export interface WorkflowStepDefinition {
  id: string;
  name: string;
  workflowId: string | null;
  dependsOn: string[];
  executionMode: ExecutionMode;
  mutation: MutationClass;
  approvalRequired: boolean;
  timeoutSeconds: number | null;
  retryLimit: number;
  successCriteria: string[];
  recoveryWorkflowIds: string[];
}

export interface WorkflowDefinition extends VersionedContract {
  projectId: string | null;
  name: string;
  description: string;
  category: WorkflowCategory;
  command: CommandDefinition | null;
  steps: WorkflowStepDefinition[];
  preconditions: string[];
  expectedArtifacts: string[];
  isolationRequired: boolean;
  approvalRequired: boolean;
  enabled: boolean;
}

export interface WorkflowExecution extends VersionedContract {
  workflowId: string;
  projectId: string;
  sessionId: string | null;
  taskId: string | null;
  runId: string | null;
  state: UnifiedState;
  currentStepId: string | null;
  stepStates: Record<string, UnifiedState>;
  startedAt: string | null;
  finishedAt: string | null;
  approvalId: string | null;
  exitCode: number | null;
  artifacts: string[];
  errorCode: string | null;
  errorSummary: string | null;
}

export type WorkbenchEventSeverity = "debug" | "info" | "warning" | "error" | "critical";
export interface WorkbenchEvent<TPayload extends Record<string, unknown> = Record<string, unknown>>
  extends VersionedContract {
  type: string;
  occurredAt: string;
  projectId: string | null;
  sessionId: string | null;
  taskId: string | null;
  runId: string | null;
  sourceService: string;
  severity: WorkbenchEventSeverity;
  summary: string;
  payload: TPayload;
  correlationId: string;
  causationId: string | null;
}

export interface DesktopObservation extends VersionedContract {
  observedAt: string;
  state: UnifiedState;
  compositor: "hyprland" | "unknown";
  workspaceId: string | null;
  window: {
    address: string | null;
    pid: number | null;
    className: string | null;
    title: string | null;
    role: string | null;
  } | null;
  process: { pid: number; parentPid: number | null; cwd: string | null; command: string | null } | null;
  editor: { file: string | null; workspace: string | null } | null;
  terminal: { cwd: string | null; shell: string | null } | null;
  tmux: {
    clientPid: number | null;
    session: string | null;
    paneId: string | null;
    cwd: string | null;
    associationVerified: boolean;
  } | null;
  browser: { url: string | null; projectId: string | null } | null;
  explicitProjectId: string | null;
  transientWindow: boolean;
}
