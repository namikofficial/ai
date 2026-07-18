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
  mode: AskMode | "index" | "plan" | "handoff" | "check" | "reflect" | "dev";
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

export interface CompiledPromptRecord {
  id: string;
  sessionId: string | null;
  taskId: string | null;
  retrievalQueryId: string | null;
  contextPackId: string | null;
  mode: string;
  role: string;
  messagesJson: string;
  estimatedTokens: number;
  includedContextJson: string;
  omittedContextJson: string;
  safetyNotesJson: string;
  outputSchemaJson: string | null;
  createdAt: string;
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
  durationMs: number | null;
  parsedErrors: string[];
  affectedFiles: string[];
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

export interface StatusSnapshot {
  health: Record<string, unknown>;
  config: ConfigSnapshot & { projects: number; activeSessions: number };
  summary: {
    projects: number;
    activeSessions: number;
    sessions: number;
    lessons: number;
    checks: number;
  };
  projects: ProjectSummary[];
  sessions: SessionRecord[];
  checks: CheckRunSummary[];
  settings: SettingsSnapshot;
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

export type TimelineItemKind =
  | "event"
  | "message"
  | "agent_run"
  | "model_call"
  | "compiled_prompt"
  | "retrieval_query"
  | "retrieval_result"
  | "context_pack"
  | "memory_candidate"
  | "skill_candidate"
  | "eval"
  | "mcp_call"
  | "check"
  | "review"
  | "handoff";

export interface TimelineItem {
  id: string;
  ts: string;
  kind: TimelineItemKind;
  title: string;
  status?: string;
  durationMs?: number | null;
  summary: string;
  refs: Record<string, string | null>;
  payload: unknown;
  link?: string;
}

export interface SessionTimelineCounts {
  messages: number;
  events: number;
  agentRuns: number;
  modelCalls: number;
  compiledPrompts: number;
  retrievalQueries: number;
  contextPacks: number;
  outcomes: number;
}

export interface SessionTimelineResponse {
  session: SessionRecord;
  timeline: TimelineItem[];
  items: TimelineItem[];
  counts: SessionTimelineCounts;
  trace?: Record<string, unknown>;
}

export interface SessionReplayRequest {
  fromTimelineItemId?: string;
  editedUserRequest?: string;
  editedSystemPrompt?: string;
  editedContextPackId?: string;
  selectedPromptId?: string;
  modelProfileId?: string;
  mode?: "local" | "hybrid" | "cloud";
  dryRun?: boolean;
}

export interface SessionReplayResponse {
  parentSessionId: string;
  childSession: SessionRecord;
  replay: Record<string, unknown>;
}

export interface PromptLabRunRequest {
  projectId: string;
  promptId: string;
  modelProfileIds: string[];
  notes?: string | null;
  dryRun?: boolean;
}

export interface PromptLabResultRecord {
  id: string;
  runId: string;
  profileId: string;
  profileName: string;
  modelName: string;
  status: "ok" | "failed" | "blocked" | "fallback";
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  outputText: string | null;
  error: string | null;
  approxCost: number | null;
  createdAt: string;
}

export interface PromptLabRunRecord {
  id: string;
  sessionId: string | null;
  projectId: string;
  promptId: string;
  mode: string;
  selectedProfiles: string[];
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export type EventType =
  | "session.created"
  | "session.started"
  | "session.paused"
  | "session.resumed"
  | "session.cancelled"
  | "session.completed"
  | "session.failed"
  | "session.reflected"
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
  | "answer.fallback"
  | "check.started"
  | "check.completed"
  | "check.failed"
  | "validation.started"
  | "validation.passed"
  | "validation.failed"
  | "handoff.created"
  | "handoff.archived"
  | "review.reflected"
  | "plan.reviewed"
  | "lesson.created"
  | "project.manifest_proposed"
  | "project.manifest_approved"
  | "project.manifest_rejected"
  | "project.selected"
  | "project.pinned"
  | "project.unpinned"
  | "active_context.changed"
  | "context.confidence_reduced"
  | "desktop.observed";

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
  recentLessons: Array<{
    id: string;
    projectId: string | null;
    title: string;
    body: string;
    createdAt: string;
  }>;
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
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "project"
  );
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
  } = {}
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
    mode: input.mode === "local" || input.mode === "cloud" || input.mode === "hybrid" ? input.mode : undefined,
    depth: input.depth === "shallow" || input.depth === "standard" || input.depth === "deep" ? input.depth : undefined,
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

// ─── Observability types (Slice 1) ────────────────────────────────────────

export type ConversationMessageRole = "user" | "assistant" | "system" | "tool" | "agent";

export interface ConversationMessageRecord {
  id: string;
  sessionId: string;
  projectId: string | null;
  role: ConversationMessageRole;
  agent: string | null;
  content: string;
  contentHash: string;
  metaJson: string;
  tokenCount: number;
  parentMessageId: string | null;
  ts: string;
  createdAt: string;
}

export type RetrievalIntentKind = "lookup" | "explain" | "debug" | "plan" | "review" | "summary";
export type RetrievalDepth = "shallow" | "standard" | "deep";
export type RetrievalMode = AskMode | "index";

export interface QueryAnalysis {
  language: string | null;
  terms: string[];
  pathHints: string[];
  symbolHints: string[];
  isLikelyDefinition: boolean;
  isLikelyDebug: boolean;
  notes: string[];
}

export interface QueryRewriteRecord {
  id: string;
  retrievalQueryId: string;
  variant: string;
  terms: string[];
  pathHints: string[];
  symbolHints: string[];
  score: number;
  createdAt: string;
}

export interface RetrievalQueryRecord {
  id: string;
  sessionId: string | null;
  taskId: string | null;
  projectId: string;
  originalQuery: string;
  intent: RetrievalIntentKind;
  mode: RetrievalMode;
  depth: RetrievalDepth;
  rewrittenQuery: string | null;
  analysis: QueryAnalysis;
  createdAt: string;
}

export interface RetrievalResultRecord {
  id: string;
  retrievalQueryId: string;
  chunkId: string;
  path: string;
  startLine: number;
  endLine: number;
  source: "fts" | "vector" | "heuristic" | "reranked";
  baseScore: number;
  rerankScore: number;
  finalScore: number;
  included: boolean;
  reason: string | null;
  createdAt: string;
}

export interface RetrievalSelectedContextRecord {
  id: string;
  retrievalQueryId: string;
  chunkId: string;
  rank: number;
  tokenCount: number;
  excerpt: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  createdAt: string;
}

export type RetrievalFeedbackRating = "good" | "bad" | "missed";

export interface RetrievalFeedbackRecord {
  id: string;
  retrievalQueryId: string;
  chunkId: string | null;
  rating: RetrievalFeedbackRating;
  missedPath: string | null;
  notes: string | null;
  createdAt: string;
}

export interface RetrievalMissRecord {
  id: string;
  retrievalQueryId: string;
  missedPath: string;
  confidence: number;
  notes: string | null;
  createdAt: string;
}

export interface RetrievalPathFeedbackRecord {
  id: string;
  projectId: string;
  retrievalQueryId: string | null;
  path: string;
  rating: RetrievalFeedbackRating;
  weight: number;
  notes: string | null;
  createdAt: string;
}

export interface ChunkPathBoostRecord {
  id: string;
  projectId: string;
  path: string;
  weight: number;
  source: string;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ModelProviderKind = "local_openai_compat" | "cloud_openai_compat" | "heuristic" | "fastembed";

export interface ModelProviderRecord {
  id: string;
  kind: ModelProviderKind;
  displayName: string;
  baseUrl: string | null;
  apiKeyEnv: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ModelRole =
  | "intent"
  | "tool_select"
  | "file_read"
  | "file_write"
  | "file_edit"
  | "query_rewrite"
  | "retrieval_judge"
  | "answer"
  | "planner"
  | "coder_handoff"
  | "reviewer"
  | "reflection"
  | "summarizer"
  | "fact_extract"
  | "embedding"
  | "reranker";

export interface ModelProfileRecord {
  id: string;
  providerId: string;
  role: ModelRole;
  modelName: string;
  displayName: string | null;
  contextWindow: number;
  maxOutputTokens: number;
  localOnly: boolean;
  enabled: boolean;
  fallbackProfileId: string | null;
  qualityScore: number;
  latencyScore: number;
  costScore: number;
  meta: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ModelRouteRecord {
  id: string;
  taskPattern: string;
  mode: AskMode | "any";
  selectedProfileId: string;
  fallbackProfileId: string | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ModelHealthStatus = "healthy" | "degraded" | "unreachable" | "disabled";

export interface ModelHealthCheckRecord {
  id: string;
  providerId: string;
  profileId: string | null;
  status: ModelHealthStatus;
  latencyMs: number | null;
  detail: string | null;
  checkedAt: string;
}

export type ModelCallStatus = "ok" | "failed" | "fallback" | "blocked";

export interface ModelCallRecord {
  id: string;
  sessionId: string | null;
  taskId: string | null;
  retrievalQueryId: string | null;
  profileId: string;
  role: ModelRole;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  status: ModelCallStatus;
  error: string | null;
  request: Record<string, unknown>;
  response: Record<string, unknown>;
  ts: string;
  createdAt: string;
}

export interface ContextPackRecord {
  id: string;
  sessionId: string | null;
  taskId: string | null;
  projectId: string | null;
  retrievalQueryId: string | null;
  budgetTokens: number;
  usedTokens: number;
  reason: string | null;
  createdAt: string;
}

export type ContextPackItemKind =
  | "retrieval_chunk"
  | "code_symbol"
  | "memory_entry"
  | "fact"
  | "project_rule"
  | "previous_message"
  | "previous_session"
  | "system"
  | "git_state"
  | "check_failure"
  | "skill";

export interface ContextPackItemRecord {
  id: string;
  contextPackId: string;
  kind: ContextPackItemKind;
  sourceId: string | null;
  rank: number;
  tokenCount: number;
  excerpt: string;
  included: boolean;
  omissionReason: string | null;
  createdAt: string;
}

export interface CodeSymbolRecord {
  id: string;
  projectId: string;
  fileId: string;
  path: string;
  language: string | null;
  kind:
    | "function"
    | "class"
    | "method"
    | "interface"
    | "type"
    | "import"
    | "route"
    | "middleware"
    | "constant"
    | "unknown";
  name: string;
  qualifiedName: string;
  startLine: number;
  endLine: number;
  signature: string | null;
  doc: string | null;
  metadata: Record<string, unknown>;
}

export interface CodeEdgeRecord {
  id: string;
  projectId: string;
  fromSymbolId: string;
  toSymbolId: string;
  kind: "imports" | "calls" | "defines" | "uses" | "routes_to" | "middleware_for" | "tests" | "unknown";
  confidence: number;
  metadata: Record<string, unknown>;
}

export interface ContextBudgetEventRecord {
  id: string;
  contextPackId: string;
  deltaTokens: number;
  reason: string;
  createdAt: string;
}

export type MemoryCandidateKind =
  | "project_convention"
  | "architectural_fact"
  | "user_preference"
  | "command_worked"
  | "command_failed"
  | "error_fix"
  | "dependency_version"
  | "file_ownership"
  | "style_rule"
  | "anti_pattern"
  | "retrieval_miss"
  | "workflow_lesson";

export type MemoryCandidateStatus = "pending" | "accepted" | "rejected" | "edited";

export type MemoryScope = "global" | "project" | "repo" | "path";

export interface MemoryCandidateRecord {
  id: string;
  projectId: string | null;
  sessionId: string | null;
  kind: MemoryCandidateKind;
  title: string;
  body: string;
  evidence: Array<Record<string, unknown>>;
  confidence: number;
  scope: MemoryScope;
  status: MemoryCandidateStatus;
  reviewedAt: string | null;
  reviewerNotes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryEntryRecord {
  id: string;
  candidateId: string | null;
  projectId: string | null;
  scope: MemoryScope;
  kind: MemoryCandidateKind;
  title: string;
  body: string;
  evidence: Array<Record<string, unknown>>;
  confidence: number;
  pinned: boolean;
  archived: boolean;
  lastUsedAt: string | null;
  useCount: number;
  createdAt: string;
  updatedAt: string;
}

export type FactStatus = "fresh" | "stale" | "disputed" | "archived";

export interface FactRecord {
  id: string;
  projectId: string | null;
  key: string;
  value: string;
  kind: string;
  confidence: number;
  sourceKind: string;
  status: FactStatus;
  lastVerifiedAt: string | null;
  expiresAt: string | null;
  validAt: string | null;
  invalidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FactSourceRecord {
  id: string;
  factId: string;
  sourceKind: string;
  sourceRef: string;
  excerpt: string | null;
  createdAt: string;
}

export interface ProjectRuleRecord {
  id: string;
  projectId: string;
  title: string;
  body: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export type AgentStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type AgentRisk = "low" | "medium" | "high";

export interface AgentRunRecord {
  id: string;
  sessionId: string | null;
  taskId: string | null;
  projectId: string | null;
  agent: string;
  role: string;
  status: AgentStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  modelRole: ModelRole | null;
  risk: AgentRisk;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AgentMessageDirection = "in" | "out" | "internal";

export interface AgentMessageRecord {
  id: string;
  agentRunId: string;
  direction: AgentMessageDirection;
  role: string;
  content: string;
  meta: Record<string, unknown>;
  ts: string;
  createdAt: string;
}

export interface AgentHandoffRecord {
  id: string;
  fromAgentRunId: string | null;
  toAgent: string;
  payload: Record<string, unknown>;
  contextPackId: string | null;
  sessionId: string | null;
  taskId: string | null;
  createdAt: string;
}

export interface EvalCaseRecord {
  id: string;
  projectId: string | null;
  question: string;
  expectedFiles: string[];
  expectedAnswerContains: string | null;
  difficulty: "easy" | "standard" | "hard";
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface EvalRunRecord {
  id: string;
  caseId: string;
  sessionId: string | null;
  projectId: string | null;
  startedAt: string;
  finishedAt: string | null;
  passed: boolean;
  score: number;
  notes: string | null;
}

export interface AnswerEvaluationRecord {
  id: string;
  sessionId: string | null;
  retrievalQueryId: string | null;
  groundedness: number;
  citationCoverage: number;
  contradiction: number;
  notes: string | null;
  createdAt: string;
}

export interface RetrievalEvaluationRecord {
  id: string;
  retrievalQueryId: string;
  hitAtK: number;
  mrr: number;
  precision: number;
  recall: number;
  notes: string | null;
  createdAt: string;
}

export type SessionOutcomeKind = "success" | "partial" | "failed" | "abandoned";

export interface SessionOutcomeRecord {
  id: string;
  sessionId: string;
  outcome: SessionOutcomeKind;
  score: number;
  notes: string | null;
  createdAt: string;
}

export type SkillStatus = "pending" | "active" | "deprecated" | "rejected";
export type SkillSourceKind = "reflection" | "manual" | "imported";

export interface SkillCandidateRecord {
  id: string;
  projectId: string | null;
  title: string;
  triggerTerms: string[];
  applicableProjects: string[];
  steps: string[];
  requiredContext: string[];
  commands: string[];
  safetyNotes: string | null;
  validation: string[];
  exampleSessionId: string | null;
  sourceKind: SkillSourceKind;
  confidence: number;
  status: SkillStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SkillRecord {
  id: string;
  candidateId: string | null;
  title: string;
  triggerTerms: string[];
  applicableProjects: string[];
  steps: string[];
  requiredContext: string[];
  commands: string[];
  safetyNotes: string | null;
  validation: string[];
  status: SkillStatus;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SkillUsageRecord {
  id: string;
  skillId: string;
  sessionId: string | null;
  applied: boolean;
  notes: string | null;
  createdAt: string;
}

// ─── Local agentic dev pipeline (Slice 26) ────────────────────────────────

export type DevMode = AskMode;
export type ApprovalPolicy = "auto" | "manual" | "high_risk_only";
export type RiskLevel = "low" | "medium" | "high";
export type EditChangeType = "replace" | "create" | "append";
export type DevRunStatus =
  | "queued"
  | "planning"
  | "editing"
  | "checking"
  | "repairing"
  | "awaiting_approval"
  | "approved"
  | "applied"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked";
export type DevEditStatus = "proposed" | "applied" | "rejected" | "failed";
export type WorkspaceStrategy = "git_worktree" | "safe_copy";
export type ExecutionCommandStatus = "queued" | "running" | "completed" | "failed" | "blocked";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface DevRequest {
  project: string;
  goal: string;
  mode?: DevMode;
  approvalPolicy?: ApprovalPolicy;
  approveEdits?: boolean;
  checks?: string[];
  maxRepairs?: number;
  editorProfileId?: string;
  repairProfileId?: string;
  plannerProfileId?: string;
}

export interface DevEdit {
  path: string;
  reason: string;
  oldText?: string;
  newText: string;
  changeType: EditChangeType;
}

export interface DevPlan {
  summary: string;
  edits: DevEdit[];
  checks: string[];
  risk: RiskLevel;
  notes?: string;
  missingContextReason?: string;
}

export interface DevCheckResult {
  name: string;
  status: ExecutionCommandStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  parsedErrors: string[];
  affectedFiles: string[];
  startedAt: string;
  finishedAt: string;
}

export interface DevRun {
  id: string;
  sessionId: string;
  projectId: string;
  goal: string;
  mode: DevMode;
  approvalPolicy: ApprovalPolicy;
  approveEdits: boolean;
  risk: RiskLevel;
  status: DevRunStatus;
  plan: DevPlan | null;
  workspace: {
    id: string;
    strategy: WorkspaceStrategy;
    path: string;
    branch: string | null;
  } | null;
  checks: DevCheckResult[];
  repairAttempts: number;
  maxRepairs: number;
  errorMessage: string | null;
  summary: string;
  diffSummary: string;
  diffText: string;
  filesEdited: string[];
  filesCreated: string[];
  appliedAt: string | null;
  appliedFiles: string[];
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface DevResult {
  runId: string;
  sessionId: string;
  projectId: string;
  status: DevRunStatus;
  risk: RiskLevel;
  goal: string;
  summary: string;
  filesEdited: string[];
  filesCreated: string[];
  checks: DevCheckResult[];
  diffSummary: string;
  diff: string;
  applied: boolean;
  missingContextReason: string | null;
  errorMessage: string | null;
  workspacePath: string | null;
  repairAttempts: number;
  nextCommand: string;
  createdAt: string;
  finishedAt: string | null;
}

export type ExecutionEventKind =
  | "run.queued"
  | "run.started"
  | "plan.ready"
  | "workspace.ready"
  | "edit.proposed"
  | "edit.applied"
  | "edit.rejected"
  | "check.started"
  | "check.completed"
  | "check.failed"
  | "repair.attempted"
  | "approval.required"
  | "approval.granted"
  | "approval.rejected"
  | "patch.applied"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "review.rejected"
  | "review.passed";

export interface ExecutionEvent {
  id: string;
  runId: string;
  sessionId: string;
  projectId: string;
  kind: ExecutionEventKind;
  level: EventLevel;
  ts: string;
  message: string;
  data: Record<string, unknown>;
}

export {
  extractJsonFragment,
  isLikelyJsonOutput,
  parseJsonFragment,
} from "./model-output.ts";
