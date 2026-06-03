export type ProjectStatus = "new" | "indexing" | "ready" | "error";
export type SessionStatus = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
export type TaskStatus = "queued" | "running" | "completed" | "failed" | "blocked";
export type EventLevel = "debug" | "info" | "warn" | "error";
export type AskMode = "local" | "cloud" | "hybrid";

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  repoUrl: string | null;
  branch: string | null;
  language: string | null;
  framework: string | null;
  status: ProjectStatus;
  lastIndexedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummary extends ProjectRecord {
  fileCount: number;
  chunkCount: number;
  indexedFileCount: number;
  dirty: boolean;
  health: "healthy" | "warning" | "unknown";
}

export interface ProjectCreateInput {
  name?: string;
  path: string;
  repoUrl?: string | null;
  branch?: string | null;
}

export interface SessionRecord {
  id: string;
  projectId: string | null;
  title: string;
  userGoal: string;
  mode: AskMode | "index" | "plan" | "handoff" | "check" | "reflect";
  status: SessionStatus;
  source: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  activeTaskId: string | null;
  modelProfile: string | null;
  finalSummary: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRecord {
  id: string;
  sessionId: string;
  parentTaskId: string | null;
  title: string;
  description: string;
  type: string;
  status: TaskStatus;
  priority: number;
  risk: "low" | "medium" | "high";
  expectedFilesJson: string;
  actualFilesJson: string;
  checksJson: string;
  resultJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface RetrievalChunk {
  id: string;
  projectId: string;
  documentId: string;
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  tokenCount: number;
  score: number;
  metadata: Record<string, unknown>;
}

export interface AskRequest {
  project: string;
  question: string;
  mode?: AskMode;
  depth?: "shallow" | "standard" | "deep";
}

export interface AskResponse {
  sessionId: string;
  projectId: string;
  question: string;
  answer: string;
  confidence: number;
  citations: Array<{
    chunkId: string;
    path: string;
    startLine: number;
    endLine: number;
    excerpt: string;
    score: number;
  }>;
  retrievedChunks: RetrievalChunk[];
  insufficientReason: string | null;
}

export interface PlanRequest {
  project: string;
  goal: string;
  risk?: "low" | "medium" | "high";
}

export interface PlanResponse {
  sessionId: string;
  projectId: string;
  goal: string;
  risk: "low" | "medium" | "high";
  taskGraph: Array<{
    id: string;
    title: string;
    description: string;
    status: "queued" | "running" | "completed" | "failed" | "blocked";
    expectedFiles: string[];
    checks: string[];
  }>;
  likelyFiles: string[];
  checks: string[];
  modelRecommendation: string;
  researchDepth: "shallow" | "standard" | "deep";
}

export interface HandoffRequest {
  sessionId: string;
  project: string;
  target: "opencode" | "codex" | "manual" | "clipboard" | "file";
  subtask: string;
}

export interface HandoffResponse {
  id: string;
  sessionId: string;
  projectId: string;
  target: HandoffRequest["target"];
  prompt: string;
  selectedContext: {
    filesToInspect: string[];
    filesLikelyToEdit: string[];
    checksToRun: string[];
    constraints: string[];
  };
}

export interface CheckRunSummary {
  id: string;
  name: string;
  status: "queued" | "running" | "completed" | "failed" | "blocked";
  command: string | null;
  output: string | null;
  errorOutput: string | null;
  exitCode: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type JobStatus = "queued" | "running" | "completed" | "failed";

export interface JobRecord {
  id: string;
  type: string;
  status: JobStatus;
  payloadJson: string;
  availableAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewRecord {
  id: string;
  projectId: string | null;
  sessionId: string | null;
  title: string;
  summary: string;
  plannedFilesJson: string;
  editedFilesJson: string;
  checksJson: string;
  scopeCreepJson: string;
  missingTestsJson: string;
  riskyChangesJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewRequest {
  project: string;
  sessionId?: string | null;
  title?: string;
  plannedFiles?: string[];
  editedFiles?: string[];
  checks?: string[];
  notes?: string;
}

export interface ReviewResponse {
  id: string;
  projectId: string;
  sessionId: string | null;
  title: string;
  summary: string;
  scopeCreep: string[];
  missingTests: string[];
  riskyChanges: string[];
  nextStep: string;
}

export interface SettingsSnapshot {
  databasePath: string;
  runtimeDir: string;
  apiUrl: string;
  webPort: number;
  apiPort: number;
  cloudEnabled: boolean;
  qdrantEnabled: boolean;
  qdrantUrl: string | null;
  qdrantCollection: string;
  projectCount: number;
}

export interface ModelUsageEntry {
  day: string;
  modelName: string;
  promptTokens: number;
  completionTokens: number;
  requests: number;
}

export interface McpCallSummary {
  id: string;
  sessionId: string | null;
  projectId: string | null;
  toolName: string;
  inputJson: string;
  outputJson: string | null;
  blocked: boolean;
  createdAt: string;
}

export interface MemoryEntry {
  id: string;
  projectId: string | null;
  title: string;
  body: string;
  source: string;
  importance: number;
  createdAt: string;
}

export interface EventEnvelope<TPayload = Record<string, unknown>> {
  id: string;
  type: string;
  sessionId: string | null;
  taskId: string | null;
  projectId: string | null;
  agent: string | null;
  level: EventLevel;
  ts: string;
  payload: TPayload;
}

export type EventType =
  | "session.created"
  | "session.started"
  | "session.paused"
  | "session.resumed"
  | "session.cancelled"
  | "session.completed"
  | "session.failed"
  | "task.created"
  | "task.started"
  | "task.completed"
  | "task.failed"
  | "agent.started"
  | "agent.completed"
  | "agent.failed"
  | "retrieval.started"
  | "retrieval.completed"
  | "retrieval.low_confidence"
  | "tool.called"
  | "tool.completed"
  | "tool.failed"
  | "tool.blocked"
  | "model.called"
  | "model.completed"
  | "model.failed"
  | "check.started"
  | "check.completed"
  | "check.failed"
  | "handoff.created"
  | "lesson.created";

export interface ConfigSnapshot {
  databasePath: string;
  runtimeDir: string;
  apiUrl: string;
  webPort: number;
  apiPort: number;
  cloudEnabled: boolean;
  qdrantEnabled: boolean;
  qdrantUrl: string | null;
  qdrantCollection: string;
}

export interface DashboardSnapshot {
  projects: number;
  activeSessions: number;
  recentSessions: SessionRecord[];
  recentLessons: Array<{ id: string; projectId: string | null; title: string; body: string; createdAt: string }>;
  recentChecks: Array<{ id: string; name: string; status: string; createdAt: string }>;
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new TypeError("value must be a string or null");
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function slugifyName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "project";
}

export function createId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`;
}

export function createEvent<TPayload extends Record<string, unknown>>(
  type: EventType,
  payload: TPayload,
  details: {
    sessionId?: string | null;
    taskId?: string | null;
    projectId?: string | null;
    agent?: string | null;
    level?: EventLevel;
    id?: string;
    ts?: string;
  } = {},
): EventEnvelope<TPayload> {
  return {
    id: details.id ?? createId("evt"),
    type,
    sessionId: details.sessionId ?? null,
    taskId: details.taskId ?? null,
    projectId: details.projectId ?? null,
    agent: details.agent ?? null,
    level: details.level ?? "info",
    ts: details.ts ?? new Date().toISOString(),
    payload,
  };
}

export function parseProjectCreateInput(value: unknown): ProjectCreateInput {
  const input = requireObject(value, "project input");
  return {
    path: requireString(input.path, "path"),
    name: typeof input.name === "string" ? input.name.trim() : undefined,
    repoUrl: optionalString(input.repoUrl),
    branch: optionalString(input.branch),
  };
}

export function parseAskRequest(value: unknown): AskRequest {
  const input = requireObject(value, "ask request");
  return {
    project: requireString(input.project, "project"),
    question: requireString(input.question, "question"),
    mode:
      input.mode === "local" || input.mode === "cloud" || input.mode === "hybrid"
        ? input.mode
        : undefined,
    depth:
      input.depth === "shallow" || input.depth === "standard" || input.depth === "deep"
        ? input.depth
        : undefined,
  };
}

export function parseEventEnvelope(value: unknown): EventEnvelope {
  const input = requireObject(value, "event");
  return {
    id: requireString(input.id, "id"),
    type: requireString(input.type, "type"),
    sessionId: typeof input.sessionId === "string" ? input.sessionId : null,
    taskId: typeof input.taskId === "string" ? input.taskId : null,
    projectId: typeof input.projectId === "string" ? input.projectId : null,
    agent: typeof input.agent === "string" ? input.agent : null,
    level:
      input.level === "debug" || input.level === "info" || input.level === "warn" || input.level === "error"
        ? input.level
        : "info",
    ts: requireString(input.ts, "ts"),
    payload: requireObject(input.payload, "payload"),
  };
}
