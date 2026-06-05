import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
// @ts-ignore - this workspace's node type surface does not expose node:module, but the runtime does.
import { createRequire } from "node:module";
import { basename, extname, join, normalize, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "./migrate.ts";
import { seedDefaultModelCatalog } from "../../model-runtime/src/default-catalog.ts";
import { createModelRuntime, selectModelProfile } from "../../model-runtime/src/index.ts";
import type { ModelInvokeOptions, ModelInvokeRequest, ModelInvokeResult, ModelRuntime } from "../../model-runtime/src/index.ts";
import { buildContextPack } from "../../context-engine/src/index.ts";
import { runAskWorkflow } from "../../ask-engine/src/index.ts";
import { reflect as reflectEngine } from "../../reflection-engine/src/index.ts";
import { indexProject as runIndexerProject } from "../../indexer/src/index.ts";
import { readEmbeddingConfig } from "../../indexer/src/config.ts";
import { boostWeightForPath, resolveProjectConfig } from "../../config/src/index.ts";
import { compilePrompt } from "../../prompt-compiler/src/index.ts";
import type { CompiledPrompt, PromptMode } from "../../prompt-compiler/src/index.ts";
import type { RankedChunk } from "../../retrieval-engine/src/index.ts";
import {
  QdrantClient,
  embedQueryForQdrant,
  readQdrantRuntimeSettings,
  tryEnableSearchIndex,
} from "../../retrieval-engine/src/index.ts";
import { searchProjectChunks } from "../../retrieval-engine/src/search.ts";
import {
  createAgentsRepo,
  createCodeIntelligenceRepo,
  createContextRepo,
  createConversationRepo,
  createEvalRepo,
  createMemoryRepo,
  createModelsRepo,
  createPromptLabRepo,
  createPromptRepo,
  createRetrievalRepo,
  createSkillsRepo,
} from "./repositories/index.ts";
import type {
  AskMode,
  AskRequest,
  AskResponse,
  CheckRunSummary,
  ConfigSnapshot,
  CompiledPromptRecord,
  DashboardSnapshot,
  EventEnvelope,
  EventType,
  HandoffRequest,
  HandoffResponse,
  McpCallSummary,
  MemoryEntry,
  ModelProviderRecord,
  ModelProfileRecord,
  ModelUsageEntry,
  JobRecord,
  PlanRequest,
  PlanResponse,
  QueryAnalysis,
  RetrievalChunk,
  RetrievalIntentKind,
  ReviewRecord,
  ReviewRequest,
  ReviewResponse,
  SettingsSnapshot,
  ProjectCreateInput,
  ProjectRecord,
  ProjectStatus,
  ProjectSummary,
  SessionRecord,
  SessionStatus,
  TaskRecord,
  TaskStatus,
} from "../../shared/src/index.ts";
import {
  buildFtsQuery,
  rankChunk,
} from "../../retrieval-engine/src/index.ts";
import { createEvent, createId, slugifyName } from "../../shared/src/index.ts";
import { isLikelyJsonOutput, parseJsonFragment } from "../../shared/src/model-output.ts";

type Row = Record<string, unknown>;
const require = createRequire(import.meta.url);

const DEFAULT_IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".next",
  "runtime",
]);

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".mdx",
  ".txt",
  ".yaml",
  ".yml",
  ".toml",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".sh",
  ".sql",
  ".css",
  ".html",
]);

function now(): string {
  return new Date().toISOString();
}

function toBool(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.length > 0) return Number(value);
  return 0;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function rowToProject(row: Row): ProjectRecord {
  return {
    id: asString(row.id),
    name: asString(row.name),
    path: asString(row.path),
    repoUrl: row.repo_url == null ? null : asString(row.repo_url),
    branch: row.branch == null ? null : asString(row.branch),
    language: row.language == null ? null : asString(row.language),
    framework: row.framework == null ? null : asString(row.framework),
    status: asString(row.status) as ProjectStatus,
    lastIndexedAt: row.last_indexed_at == null ? null : asString(row.last_indexed_at),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function rowToSession(row: Row): SessionRecord {
  return {
    id: asString(row.id),
    projectId: row.project_id == null ? null : asString(row.project_id),
    title: asString(row.title),
    userGoal: asString(row.user_goal),
    mode: asString(row.mode) as AskMode | "index",
    status: asString(row.status) as SessionStatus,
    source: asString(row.source),
    startedAt: asString(row.started_at),
    finishedAt: row.finished_at == null ? null : asString(row.finished_at),
    durationMs: row.duration_ms == null ? null : toNumber(row.duration_ms),
    activeTaskId: row.active_task_id == null ? null : asString(row.active_task_id),
    modelProfile: row.model_profile == null ? null : asString(row.model_profile),
    finalSummary: row.final_summary == null ? null : asString(row.final_summary),
    errorMessage: row.error_message == null ? null : asString(row.error_message),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function rowToTask(row: Row): TaskRecord {
  return {
    id: asString(row.id),
    sessionId: asString(row.session_id),
    parentTaskId: row.parent_task_id == null ? null : asString(row.parent_task_id),
    title: asString(row.title),
    description: asString(row.description),
    type: asString(row.type),
    status: asString(row.status) as TaskStatus,
    priority: toNumber(row.priority),
    risk: asString(row.risk) as "low" | "medium" | "high",
    expectedFilesJson: asString(row.expected_files_json),
    actualFilesJson: asString(row.actual_files_json),
    checksJson: asString(row.checks_json),
    resultJson: asString(row.result_json),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function enqueueReflectionJob(
  storeRef: { enqueueJob: (input: { type: string; payload: Record<string, unknown>; availableAt?: string | null }) => JobRecord },
  sessionId: string,
  source: string,
  projectId?: string | null,
): JobRecord {
  return storeRef.enqueueJob({
    type: "session.reflect",
    payload: {
      sessionId,
      source,
      projectId: projectId ?? null,
    },
  });
}

function detectFrameworkFromPath(projectPath: string): string | null {
  const name = basename(projectPath).toLowerCase();
  if (name.includes("react")) return "react";
  if (name.includes("next")) return "next.js";
  if (name.includes("expo")) return "expo";
  return null;
}

export interface StoreOptions {
  databasePath: string;
}

export interface CreateSessionInput {
  projectId: string | null;
  title: string;
  userGoal: string;
  mode: AskMode | "index" | "plan" | "handoff" | "check" | "reflect";
  source: string;
  modelProfile?: string | null;
}

export interface CreateTaskInput {
  sessionId: string;
  parentTaskId?: string | null;
  title: string;
  description: string;
  type: string;
  risk?: "low" | "medium" | "high";
  priority?: number;
}

export interface SearchOptions {
  limit?: number;
}

export interface IndexResult {
  project: ProjectRecord;
  session: SessionRecord;
  events: EventEnvelope[];
  filesIndexed: number;
  chunksIndexed: number;
}

export function openStore(options: StoreOptions) {
  const db = new DatabaseSync(options.databasePath);
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

export function migrateStore(db: DatabaseSync): void {
  runMigrations(db);
  tryEnableSearchIndex(db);
}

export function initializeStore(dbPath: string): DatabaseSync {
  const db = openStore({ databasePath: dbPath });
  runMigrations(db);
  tryEnableSearchIndex(db);
  return db;
}

export function createStore(db: DatabaseSync) {
  const qdrantBaseSettings = readQdrantRuntimeSettings();
  let qdrantAvailable = qdrantBaseSettings.enabled && Boolean(qdrantBaseSettings.url);

  function getActiveQdrantSettings(): ReturnType<typeof readQdrantRuntimeSettings> | null {
    if (!qdrantBaseSettings.enabled || !qdrantAvailable || !qdrantBaseSettings.url) {
      return null;
    }
    return qdrantBaseSettings;
  }

  function disableQdrant(): void {
    qdrantAvailable = false;
  }

  let intelligenceStack: {
    runtime: ModelRuntime;
    providers: Array<Pick<ModelProviderRecord, "id" | "kind" | "displayName" | "baseUrl" | "apiKeyEnv" | "enabled">>;
    profiles: ModelProfileRecord[];
    runtimeOptions?: { sessionId?: string | null; taskId?: string | null; retrievalQueryId?: string | null };
  } | null = null;

  const conversationRepo = createConversationRepo(db);
  const codeIntelligenceRepo = createCodeIntelligenceRepo(db);
  const retrievalRepo = createRetrievalRepo(db);
  const modelsRepo = createModelsRepo(db);
  const agentsRepo = createAgentsRepo(db);
  const contextRepo = createContextRepo(db);
  const memoryRepo = createMemoryRepo(db);
  const skillsRepo = createSkillsRepo(db);
  const evalRepo = createEvalRepo(db);
  const promptLabRepo = createPromptLabRepo(db);
  const promptRepo = createPromptRepo(db);

  seedDefaultModelCatalog(modelsRepo);

  function listRuntimeProviders(): Array<Pick<ModelProviderRecord, "id" | "kind" | "displayName" | "baseUrl" | "apiKeyEnv" | "enabled">> {
    return modelsRepo.listProviders().map((provider) => ({
      id: provider.id,
      kind: provider.kind,
      displayName: provider.displayName,
      baseUrl: provider.baseUrl,
      apiKeyEnv: provider.apiKeyEnv,
      enabled: provider.enabled,
    }));
  }

  function getRuntime(): ModelRuntime {
    if (intelligenceStack) {
      return intelligenceStack.runtime;
    }
    const providers = listRuntimeProviders();
    const profiles = modelsRepo.listProfiles();
    const runtime = createModelRuntime({
      providers,
      profiles,
      cloudEnabled: process.env.AI_CLOUD_ENABLED === "true",
    });
    intelligenceStack = { runtime, providers, profiles };
    return runtime;
  }

  async function resolveModelProfile(
    routeInput: Parameters<ModelRuntime["route"]>[0],
    legacyProfileId: string,
  ): Promise<{ decision: Awaited<ReturnType<ModelRuntime["route"]>>; profileId: string }> {
    const decision = await getRuntime().route(routeInput);
    return {
      decision,
      profileId: decision.profileId ?? decision.fallbackProfileId ?? legacyProfileId,
    };
  }

  async function invokeModel(profileId: string, request: ModelInvokeRequest, options: ModelInvokeOptions = {}): Promise<ModelInvokeResult> {
    const runtime = getRuntime();
    return runtime.invoke(profileId, request, {
      ...options,
      recordCall: (call) => {
        modelsRepo.recordCall(call);
      },
    });
  }

  const store = {
    db,
    invokeModel,
    setIntelligenceStack(stack: typeof intelligenceStack): void {
      intelligenceStack = stack;
    },
    hasIntelligenceStack(): boolean {
      return intelligenceStack != null;
    },
    seedAndMigrate: () => {
      db.exec("PRAGMA foreign_keys = ON;");
    },
    getConfigSnapshot(config: ConfigSnapshot): ConfigSnapshot {
      return config;
    },
    ensureRuntimeDirs: async (runtimeDir: string) => {
      await mkdir(runtimeDir, { recursive: true });
      await mkdir(join(runtimeDir, "agent"), { recursive: true });
      await mkdir(join(runtimeDir, "cache"), { recursive: true });
      await mkdir(join(runtimeDir, "exports"), { recursive: true });
      await mkdir(join(runtimeDir, "logs"), { recursive: true });
    },
    listProjects(): ProjectSummary[] {
      const projects = db.prepare("SELECT * FROM projects ORDER BY updated_at DESC").all() as Row[];
      return projects.map((project) => {
        const counts = db
          .prepare(
            `SELECT
              (SELECT COUNT(*) FROM files WHERE project_id = p.id) AS file_count,
              (SELECT COUNT(*) FROM files WHERE project_id = p.id AND is_indexed = 1) AS indexed_file_count,
              (SELECT COUNT(*) FROM rag_chunks WHERE project_id = p.id) AS chunk_count
             FROM projects p WHERE p.id = ?`,
          )
          .get(project.id) as Row;
        return {
          ...rowToProject(project),
          fileCount: toNumber(counts.file_count),
          indexedFileCount: toNumber(counts.indexed_file_count),
          chunkCount: toNumber(counts.chunk_count),
          dirty: false,
          health: "healthy",
        };
      });
    },
    getProject(identifier: string): ProjectSummary | null {
      const project = db
        .prepare("SELECT * FROM projects WHERE id = ? OR name = ? ORDER BY updated_at DESC LIMIT 1")
        .get(identifier, identifier) as Row | undefined;
      if (!project) return null;
      const counts = db
        .prepare(
          `SELECT
            (SELECT COUNT(*) FROM files WHERE project_id = p.id) AS file_count,
            (SELECT COUNT(*) FROM files WHERE project_id = p.id AND is_indexed = 1) AS indexed_file_count,
            (SELECT COUNT(*) FROM rag_chunks WHERE project_id = p.id) AS chunk_count
           FROM projects p WHERE p.id = ?`,
        )
        .get(project.id) as Row;
      return {
        ...rowToProject(project),
        fileCount: toNumber(counts.file_count),
        indexedFileCount: toNumber(counts.indexed_file_count),
        chunkCount: toNumber(counts.chunk_count),
        dirty: false,
        health: "healthy",
      };
    },
    getProjectByPath(path: string): ProjectSummary | null {
      const project = db.prepare("SELECT * FROM projects WHERE path = ? LIMIT 1").get(path) as Row | undefined;
      return project ? store.getProject(asString(project.id)) : null;
    },
    createProject(input: ProjectCreateInput): ProjectSummary {
      const resolvedPath = normalize(resolve(input.path));
      const inferredName = input.name?.trim() || basename(resolvedPath) || slugifyName(resolvedPath);
      const existing = db.prepare("SELECT * FROM projects WHERE path = ? OR name = ? LIMIT 1").get(resolvedPath, inferredName) as Row | undefined;
      if (existing) {
        return store.getProject(asString(existing.id))!;
      }
      const id = createId("proj");
      const ts = now();
      const language = detectLanguageFromPath(resolvedPath);
      const framework = detectFrameworkFromPath(resolvedPath);
      db.prepare(
        `INSERT INTO projects (
          id, name, path, repo_url, branch, language, framework, status, last_indexed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        inferredName,
        resolvedPath,
        input.repoUrl ?? null,
        input.branch ?? null,
        language,
        framework,
        "new",
        null,
        ts,
        ts,
      );
      return store.getProject(id)!;
    },
    updateProjectStatus(projectId: string, status: ProjectStatus, lastIndexedAt: string | null = null): void {
      const ts = now();
      db.prepare("UPDATE projects SET status = ?, last_indexed_at = ?, updated_at = ? WHERE id = ?").run(
        status,
        lastIndexedAt,
        ts,
        projectId,
      );
    },
    listSessions(limit = 50): SessionRecord[] {
      return (db.prepare("SELECT * FROM agent_sessions ORDER BY started_at DESC LIMIT ?").all(limit) as Row[]).map(rowToSession);
    },
    getSession(sessionId: string): SessionRecord | null {
      const row = db.prepare("SELECT * FROM agent_sessions WHERE id = ? LIMIT 1").get(sessionId) as Row | undefined;
      return row ? rowToSession(row) : null;
    },
    createSession(input: CreateSessionInput): SessionRecord {
      const ts = now();
      const id = createId("sess");
      db.prepare(
        `INSERT INTO agent_sessions (
          id, project_id, title, user_goal, mode, status, source,
          started_at, finished_at, duration_ms, active_task_id, model_profile,
          final_summary, error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.projectId,
        input.title,
        input.userGoal,
        input.mode,
        "running",
        input.source,
        ts,
        null,
        null,
        null,
        input.modelProfile ?? null,
        null,
        null,
        ts,
        ts,
      );
      return store.getSession(id)!;
    },
    updateSession(sessionId: string, patch: Partial<SessionRecord>): SessionRecord {
      const current = store.getSession(sessionId);
      if (!current) {
        throw new Error(`unknown session: ${sessionId}`);
      }
      const next: SessionRecord = {
        ...current,
        ...patch,
        updatedAt: now(),
      };
      const finishedAt = next.finishedAt ?? null;
      db.prepare(
        `UPDATE agent_sessions
         SET project_id = ?, title = ?, user_goal = ?, mode = ?, status = ?, source = ?,
             started_at = ?, finished_at = ?, duration_ms = ?, active_task_id = ?, model_profile = ?,
             final_summary = ?, error_message = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        next.projectId,
        next.title,
        next.userGoal,
        next.mode,
        next.status,
        next.source,
        next.startedAt,
        finishedAt,
        next.durationMs,
        next.activeTaskId,
        next.modelProfile,
        next.finalSummary,
        next.errorMessage,
        next.updatedAt,
        sessionId,
      );
      return store.getSession(sessionId)!;
    },
    createTask(input: CreateTaskInput): TaskRecord {
      const id = createId("task");
      const ts = now();
      db.prepare(
        `INSERT INTO agent_tasks (
          id, session_id, parent_task_id, title, description, type, status, priority, risk,
          expected_files_json, actual_files_json, checks_json, result_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.sessionId,
        input.parentTaskId ?? null,
        input.title,
        input.description,
        input.type,
        "queued",
        input.priority ?? 0,
        input.risk ?? "medium",
        "[]",
        "[]",
        "[]",
        "{}",
        ts,
        ts,
      );
      return store.getTask(id)!;
    },
    getTask(taskId: string): TaskRecord | null {
      const row = db.prepare("SELECT * FROM agent_tasks WHERE id = ? LIMIT 1").get(taskId) as Row | undefined;
      return row ? rowToTask(row) : null;
    },
    updateTask(taskId: string, patch: Partial<TaskRecord>): TaskRecord {
      const current = store.getTask(taskId);
      if (!current) throw new Error(`unknown task: ${taskId}`);
      const next: TaskRecord = {
        ...current,
        ...patch,
        updatedAt: now(),
      };
      db.prepare(
        `UPDATE agent_tasks
         SET session_id = ?, parent_task_id = ?, title = ?, description = ?, type = ?, status = ?, priority = ?, risk = ?,
             expected_files_json = ?, actual_files_json = ?, checks_json = ?, result_json = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        next.sessionId,
        next.parentTaskId,
        next.title,
        next.description,
        next.type,
        next.status,
        next.priority,
        next.risk,
        next.expectedFilesJson,
        next.actualFilesJson,
        next.checksJson,
        next.resultJson,
        next.updatedAt,
        taskId,
      );
      return store.getTask(taskId)!;
    },
    appendEvent(event: EventEnvelope): EventEnvelope {
      db.prepare(
        `INSERT INTO agent_events (id, session_id, task_id, project_id, type, agent, level, ts, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        event.id,
        event.sessionId,
        event.taskId,
        event.projectId,
        event.type,
        event.agent,
        event.level,
        event.ts,
        JSON.stringify(event.payload),
      );
      return event;
    },
    listEvents(sessionId?: string, limit = 500): EventEnvelope[] {
      const rows = sessionId
        ? (db.prepare("SELECT * FROM agent_events WHERE session_id = ? ORDER BY ts ASC LIMIT ?").all(sessionId, limit) as Row[])
        : (db.prepare("SELECT * FROM agent_events ORDER BY ts ASC LIMIT ?").all(limit) as Row[]);
      return rows.map((row) => ({
        id: asString(row.id),
        type: asString(row.type),
        sessionId: row.session_id == null ? null : asString(row.session_id),
        taskId: row.task_id == null ? null : asString(row.task_id),
        projectId: row.project_id == null ? null : asString(row.project_id),
        agent: row.agent == null ? null : asString(row.agent),
        level: asString(row.level) as EventEnvelope["level"],
        ts: asString(row.ts),
        payload: JSON.parse(asString(row.payload_json)) as Record<string, unknown>,
      }));
    },
    listRecentLessons(limit = 20): Array<{ id: string; projectId: string | null; title: string; body: string; createdAt: string }> {
      return (db.prepare("SELECT id, project_id, title, body, created_at FROM lessons ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]).map(
        (row) => ({
          id: asString(row.id),
          projectId: row.project_id == null ? null : asString(row.project_id),
          title: asString(row.title),
          body: asString(row.body),
          createdAt: asString(row.created_at),
        }),
      );
    },
    listRecentChecks(limit = 20): Array<{ id: string; name: string; status: string; createdAt: string }> {
      return (db.prepare("SELECT id, name, status, created_at FROM check_runs ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]).map(
        (row) => ({
          id: asString(row.id),
          name: asString(row.name),
          status: asString(row.status),
          createdAt: asString(row.created_at),
        }),
      );
    },
    listProjectFiles(projectId: string, limit = 25): Array<{ id: string; path: string; language: string | null; sizeBytes: number; contentHash: string; isIndexed: boolean; lastSeenAt: string }> {
      return (db
        .prepare("SELECT id, path, language, size_bytes, content_hash, is_indexed, last_seen_at FROM files WHERE project_id = ? ORDER BY last_seen_at DESC LIMIT ?")
        .all(projectId, limit) as Row[]).map((row) => ({
        id: asString(row.id),
        path: asString(row.path),
        language: row.language == null ? null : asString(row.language),
        sizeBytes: toNumber(row.size_bytes),
        contentHash: asString(row.content_hash),
        isIndexed: toBool(row.is_indexed),
        lastSeenAt: asString(row.last_seen_at),
      }));
    },
    listProjectChunks(projectId: string, limit = 20): RetrievalChunk[] {
      return store.searchChunks(projectId, "", { limit });
    },
    listProjectSessions(projectId: string, limit = 10): SessionRecord[] {
      return (db
        .prepare("SELECT * FROM agent_sessions WHERE project_id = ? ORDER BY started_at DESC LIMIT ?")
        .all(projectId, limit) as Row[]).map(rowToSession);
    },
    listTasks(sessionId: string, limit = 20): TaskRecord[] {
      return (db
        .prepare("SELECT * FROM agent_tasks WHERE session_id = ? ORDER BY created_at ASC LIMIT ?")
        .all(sessionId, limit) as Row[]).map(rowToTask);
    },
    listRecentTasks(limit = 20): TaskRecord[] {
      return (db.prepare("SELECT * FROM agent_tasks ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]).map(rowToTask);
    },
    listProjectLessons(projectId: string, limit = 10): Array<{ id: string; title: string; body: string; createdAt: string }> {
      return (db
        .prepare("SELECT id, title, body, created_at FROM lessons WHERE project_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(projectId, limit) as Row[]).map((row) => ({
        id: asString(row.id),
        title: asString(row.title),
        body: asString(row.body),
        createdAt: asString(row.created_at),
      }));
    },
    listProjectRules(projectId: string, limit = 20): Array<{ id: string; title: string; body: string; pinned: boolean; createdAt: string }> {
      return (db
        .prepare("SELECT id, title, body, pinned, created_at FROM project_rules WHERE project_id = ? ORDER BY pinned DESC, created_at DESC LIMIT ?")
        .all(projectId, limit) as Row[]).map((row) => ({
        id: asString(row.id),
        title: asString(row.title),
        body: asString(row.body),
        pinned: toBool(row.pinned),
        createdAt: asString(row.created_at),
      }));
    },
    listProjectMemory(projectId: string, limit = 20): MemoryEntry[] {
      const memoryRows = db
        .prepare("SELECT id, project_id, title, body, source, importance, created_at FROM project_memory WHERE project_id = ? ORDER BY importance DESC, created_at DESC LIMIT ?")
        .all(projectId, limit) as Row[];
      return memoryRows.map((row) => ({
        id: asString(row.id),
        projectId: row.project_id == null ? null : asString(row.project_id),
        title: asString(row.title),
        body: asString(row.body),
        source: asString(row.source),
        importance: toNumber(row.importance),
        createdAt: asString(row.created_at),
      }));
    },
    listHandoffs(sessionId?: string, limit = 20): HandoffResponse[] {
      const rows = sessionId
        ? (db.prepare("SELECT * FROM handoffs WHERE session_id = ? ORDER BY created_at DESC LIMIT ?").all(sessionId, limit) as Row[])
        : (db.prepare("SELECT * FROM handoffs ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]);
      return rows.map((row) => ({
        id: asString(row.id),
        sessionId: asString(row.session_id),
        projectId: asString(row.project_id),
        target: asString(row.target) as HandoffRequest["target"],
        prompt: asString(row.prompt),
        selectedContext: safeParseJson(asString(row.selected_context_json)) as HandoffResponse["selectedContext"],
      }));
    },
    listCheckRuns(limit = 20): CheckRunSummary[] {
      return (db
        .prepare("SELECT * FROM check_runs ORDER BY created_at DESC LIMIT ?")
        .all(limit) as Row[]).map((row) => ({
        id: asString(row.id),
        name: asString(row.name),
        status: asString(row.status) as CheckRunSummary["status"],
        command: row.command == null ? null : asString(row.command),
        output: row.output == null ? null : asString(row.output),
        errorOutput: row.error_output == null ? null : asString(row.error_output),
        exitCode: row.exit_code == null ? null : toNumber(row.exit_code),
        startedAt: row.started_at == null ? null : asString(row.started_at),
        finishedAt: row.finished_at == null ? null : asString(row.finished_at),
        createdAt: asString(row.created_at),
        updatedAt: asString(row.updated_at),
      }));
    },
    listReviews(projectId?: string | null, limit = 20): ReviewRecord[] {
      const rows = projectId
        ? (db
            .prepare("SELECT * FROM reviews WHERE project_id = ? ORDER BY created_at DESC LIMIT ?")
            .all(projectId, limit) as Row[])
        : (db.prepare("SELECT * FROM reviews ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]);
      return rows.map((row) => ({
        id: asString(row.id),
        projectId: row.project_id == null ? null : asString(row.project_id),
        sessionId: row.session_id == null ? null : asString(row.session_id),
        title: asString(row.title),
        summary: asString(row.summary),
        plannedFilesJson: asString(row.planned_files_json),
        editedFilesJson: asString(row.edited_files_json),
        checksJson: asString(row.checks_json),
        scopeCreepJson: asString(row.scope_creep_json),
        missingTestsJson: asString(row.missing_tests_json),
        riskyChangesJson: asString(row.risky_changes_json),
        createdAt: asString(row.created_at),
        updatedAt: asString(row.updated_at),
      }));
    },
    getReview(reviewId: string): ReviewRecord | null {
      const row = db.prepare("SELECT * FROM reviews WHERE id = ? LIMIT 1").get(reviewId) as Row | undefined;
      if (!row) return null;
      return {
        id: asString(row.id),
        projectId: row.project_id == null ? null : asString(row.project_id),
        sessionId: row.session_id == null ? null : asString(row.session_id),
        title: asString(row.title),
        summary: asString(row.summary),
        plannedFilesJson: asString(row.planned_files_json),
        editedFilesJson: asString(row.edited_files_json),
        checksJson: asString(row.checks_json),
        scopeCreepJson: asString(row.scope_creep_json),
        missingTestsJson: asString(row.missing_tests_json),
        riskyChangesJson: asString(row.risky_changes_json),
        createdAt: asString(row.created_at),
        updatedAt: asString(row.updated_at),
      };
    },
    createReview(input: ReviewRequest): ReviewResponse {
      const project = store.getProject(input.project);
      if (!project) {
        throw new Error(`Unknown project: ${input.project}`);
      }
      const session = input.sessionId ? store.getSession(input.sessionId) : null;
      const plannedFiles = input.plannedFiles ?? [];
      const editedFiles = input.editedFiles ?? [];
      const checks = input.checks ?? [];
      const scopeCreep = editedFiles.filter((file) => !plannedFiles.includes(file));
      const missingTests = checks.some((check) => /tests?|coverage|verify/i.test(check)) ? [] : ["tests"];
      const riskyChanges = editedFiles.filter((file) => /package\.json|migration|schema|auth|session|db/i.test(file));
      const summaryParts = [
        input.title ?? `Review for ${input.project}`,
        input.notes ? `Notes: ${input.notes}` : null,
        scopeCreep.length > 0 ? `Scope creep: ${scopeCreep.join(", ")}` : "No obvious scope creep.",
        missingTests.length > 0 ? `Missing tests: ${missingTests.join(", ")}` : "Checks appear adequate.",
        riskyChanges.length > 0 ? `Risky changes: ${riskyChanges.join(", ")}` : "No high-risk files detected.",
      ].filter(Boolean);
      const summary = summaryParts.join("\n");
      const id = createId("review");
      const ts = now();
      db.prepare(
        `INSERT INTO reviews (
          id, project_id, session_id, title, summary, planned_files_json, edited_files_json, checks_json,
          scope_creep_json, missing_tests_json, risky_changes_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        project.id,
        session?.id ?? null,
        input.title ?? `Review: ${project.name}`,
        summary,
        JSON.stringify(plannedFiles),
        JSON.stringify(editedFiles),
        JSON.stringify(checks),
        JSON.stringify(scopeCreep),
        JSON.stringify(missingTests),
        JSON.stringify(riskyChanges),
        ts,
        ts,
      );
      const response: ReviewResponse = {
        id,
        projectId: project.id,
        sessionId: session?.id ?? null,
        title: input.title ?? `Review: ${project.name}`,
        summary,
        scopeCreep,
        missingTests,
        riskyChanges,
        nextStep:
          scopeCreep.length > 0
            ? `Trim the scope to ${plannedFiles.slice(0, 3).join(", ") || "the planned files"}`
            : missingTests.length > 0
              ? "Add or run the missing checks before merging."
              : "Proceed with the current scope and capture learnings.",
      };
      store.createLesson({
        projectId: project.id,
        sessionId: session?.id ?? null,
        title: response.title,
        body: summary,
        tags: ["review", "learning"],
        importance: scopeCreep.length > 0 || missingTests.length > 0 ? 3 : 2,
      });
      store.enqueueJob({
        type: "review.reflect",
        payload: {
          reviewId: id,
          projectId: project.id,
          sessionId: session?.id ?? null,
        },
      });
      return response;
    },
    getCheckRun(checkId: string): CheckRunSummary | null {
      const row = db.prepare("SELECT * FROM check_runs WHERE id = ? LIMIT 1").get(checkId) as Row | undefined;
      if (!row) return null;
      return {
        id: asString(row.id),
        name: asString(row.name),
        status: asString(row.status) as CheckRunSummary["status"],
        command: row.command == null ? null : asString(row.command),
        output: row.output == null ? null : asString(row.output),
        errorOutput: row.error_output == null ? null : asString(row.error_output),
        exitCode: row.exit_code == null ? null : toNumber(row.exit_code),
        startedAt: row.started_at == null ? null : asString(row.started_at),
        finishedAt: row.finished_at == null ? null : asString(row.finished_at),
        createdAt: asString(row.created_at),
        updatedAt: asString(row.updated_at),
      };
    },
    createCheckRun(input: {
      sessionId?: string | null;
      projectId?: string | null;
      name: string;
      command?: string | null;
      status?: CheckRunSummary["status"];
      output?: string | null;
      errorOutput?: string | null;
      exitCode?: number | null;
      startedAt?: string | null;
      finishedAt?: string | null;
    }): CheckRunSummary {
      const id = createId("check");
      const ts = now();
      db.prepare(
        `INSERT INTO check_runs (
          id, session_id, project_id, name, status, command, output, error_output, exit_code, started_at, finished_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.sessionId ?? null,
        input.projectId ?? null,
        input.name,
        input.status ?? "queued",
        input.command ?? null,
        input.output ?? null,
        input.errorOutput ?? null,
        input.exitCode ?? null,
        input.startedAt ?? null,
        input.finishedAt ?? null,
        ts,
        ts,
      );
      return store.getCheckRun(id)!;
    },
    updateCheckRun(checkId: string, patch: Partial<CheckRunSummary>): CheckRunSummary {
      const current = store.getCheckRun(checkId);
      if (!current) throw new Error(`unknown check: ${checkId}`);
      const next: CheckRunSummary = {
        ...current,
        ...patch,
        updatedAt: now(),
      };
      db.prepare(
        `UPDATE check_runs
         SET name = ?, status = ?, command = ?, output = ?, error_output = ?, exit_code = ?, started_at = ?, finished_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        next.name,
        next.status,
        next.command,
        next.output,
        next.errorOutput,
        next.exitCode,
        next.startedAt,
        next.finishedAt,
        next.updatedAt,
        checkId,
      );
      return store.getCheckRun(checkId)!;
    },
    getCurrentTask(sessionId: string): TaskRecord | null {
      const session = store.getSession(sessionId);
      if (!session) return null;
      if (session.activeTaskId) {
        const active = store.getTask(session.activeTaskId);
        if (active) return active;
      }
      const tasks = store.listTasks(sessionId, 100);
      return tasks.find((task) => task.status === "running" || task.status === "queued") ?? tasks.at(-1) ?? null;
    },
    getNextSubtask(sessionId: string): TaskRecord | null {
      const tasks = store.listTasks(sessionId, 100);
      return tasks.find((task) => task.status === "queued") ?? null;
    },
    getSubtaskContext(sessionId: string, taskId?: string | null): {
      session: SessionRecord | null;
      task: TaskRecord | null;
      project: ProjectSummary | null;
      recentFiles: Array<{ id: string; path: string; language: string | null; sizeBytes: number; contentHash: string; isIndexed: boolean; lastSeenAt: string }>;
      recentChunks: RetrievalChunk[];
      recentLessons: Array<{ id: string; title: string; body: string; createdAt: string }>;
    } {
      const session = store.getSession(sessionId);
      const task = taskId ? store.getTask(taskId) : store.getCurrentTask(sessionId);
      const project = session?.projectId ? store.getProject(session.projectId) : null;
      return {
        session,
        task,
        project,
        recentFiles: project ? store.listProjectFiles(project.id, 10) : [],
        recentChunks: project ? store.listProjectChunks(project.id, 10) : [],
        recentLessons: project ? store.listProjectLessons(project.id, 10) : [],
      };
    },
    listModelUsage(limit = 20): ModelUsageEntry[] {
      return (db
        .prepare("SELECT day, model_name, prompt_tokens, completion_tokens, requests FROM model_usage_daily ORDER BY day DESC LIMIT ?")
        .all(limit) as Row[]).map((row) => ({
        day: asString(row.day),
        modelName: asString(row.model_name),
        promptTokens: toNumber(row.prompt_tokens),
        completionTokens: toNumber(row.completion_tokens),
        requests: toNumber(row.requests),
      }));
    },
    listMcpCalls(limit = 20): McpCallSummary[] {
      return (db
        .prepare("SELECT * FROM mcp_calls ORDER BY created_at DESC LIMIT ?")
        .all(limit) as Row[]).map((row) => ({
        id: asString(row.id),
        sessionId: row.session_id == null ? null : asString(row.session_id),
        projectId: row.project_id == null ? null : asString(row.project_id),
        toolName: asString(row.tool_name),
        inputJson: asString(row.input_json),
        outputJson: row.output_json == null ? null : asString(row.output_json),
        blocked: toBool(row.blocked),
        createdAt: asString(row.created_at),
      }));
    },
    getMcpCall(callId: string): McpCallSummary | null {
      const row = db.prepare("SELECT * FROM mcp_calls WHERE id = ? LIMIT 1").get(callId) as Row | undefined;
      if (!row) return null;
      return {
        id: asString(row.id),
        sessionId: row.session_id == null ? null : asString(row.session_id),
        projectId: row.project_id == null ? null : asString(row.project_id),
        toolName: asString(row.tool_name),
        inputJson: asString(row.input_json),
        outputJson: row.output_json == null ? null : asString(row.output_json),
        blocked: toBool(row.blocked),
        createdAt: asString(row.created_at),
      };
    },
    listJobs(limit = 20): JobRecord[] {
      return (db
        .prepare("SELECT id, type, status, payload_json, available_at, created_at, updated_at FROM jobs ORDER BY created_at DESC LIMIT ?")
        .all(limit) as Row[]).map((row) => ({
        id: asString(row.id),
        type: asString(row.type),
        status: asString(row.status) as JobRecord["status"],
        payloadJson: asString(row.payload_json),
        availableAt: asString(row.available_at),
        createdAt: asString(row.created_at),
        updatedAt: asString(row.updated_at),
      }));
    },
    enqueueJob(input: {
      type: string;
      payload: Record<string, unknown>;
      availableAt?: string | null;
    }): JobRecord {
      const id = createId("job");
      const ts = now();
      const availableAt = input.availableAt ?? ts;
      db.prepare(
        `INSERT INTO jobs (id, type, status, payload_json, available_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, input.type, "queued", JSON.stringify(input.payload), availableAt, ts, ts);
      return {
        id,
        type: input.type,
        status: "queued",
        payloadJson: JSON.stringify(input.payload),
        availableAt,
        createdAt: ts,
        updatedAt: ts,
      };
    },
    claimNextJob(): JobRecord | null {
      const row = db
        .prepare(
          `SELECT id, type, status, payload_json, available_at, created_at, updated_at
           FROM jobs
           WHERE status = 'queued' AND available_at <= ?
           ORDER BY available_at ASC, created_at ASC
           LIMIT 1`,
        )
        .get(now()) as Row | undefined;
      if (!row) return null;
      db.prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?").run("running", now(), row.id);
      return {
        id: asString(row.id),
        type: asString(row.type),
        status: "running",
        payloadJson: asString(row.payload_json),
        availableAt: asString(row.available_at),
        createdAt: asString(row.created_at),
        updatedAt: now(),
      };
    },
    completeJob(jobId: string, output: unknown): JobRecord {
      const current = db.prepare("SELECT * FROM jobs WHERE id = ? LIMIT 1").get(jobId) as Row | undefined;
      if (!current) {
        throw new Error(`unknown job: ${jobId}`);
      }
      const ts = now();
      db.prepare("UPDATE jobs SET status = ?, payload_json = ?, updated_at = ? WHERE id = ?").run(
        "completed",
        JSON.stringify({ input: safeParseJson(asString(current.payload_json)), output }),
        ts,
        jobId,
      );
      return {
        id: asString(current.id),
        type: asString(current.type),
        status: "completed",
        payloadJson: JSON.stringify({ input: safeParseJson(asString(current.payload_json)), output }),
        availableAt: asString(current.available_at),
        createdAt: asString(current.created_at),
        updatedAt: ts,
      };
    },
    failJob(jobId: string, error: string): JobRecord {
      const current = db.prepare("SELECT * FROM jobs WHERE id = ? LIMIT 1").get(jobId) as Row | undefined;
      if (!current) {
        throw new Error(`unknown job: ${jobId}`);
      }
      const ts = now();
      db.prepare("UPDATE jobs SET status = ?, payload_json = ?, updated_at = ? WHERE id = ?").run(
        "failed",
        JSON.stringify({ input: safeParseJson(asString(current.payload_json)), error }),
        ts,
        jobId,
      );
      return {
        id: asString(current.id),
        type: asString(current.type),
        status: "failed",
        payloadJson: JSON.stringify({ input: safeParseJson(asString(current.payload_json)), error }),
        availableAt: asString(current.available_at),
        createdAt: asString(current.created_at),
        updatedAt: ts,
      };
    },
    createMcpCall(input: {
      sessionId?: string | null;
      projectId?: string | null;
      toolName: string;
      inputJson: string;
      outputJson?: string | null;
      blocked?: boolean;
    }): McpCallSummary {
      const id = createId("mcp");
      const ts = now();
      db.prepare(
        `INSERT INTO mcp_calls (id, session_id, project_id, tool_name, input_json, output_json, blocked, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.sessionId ?? null,
        input.projectId ?? null,
        input.toolName,
        input.inputJson,
        input.outputJson ?? null,
        input.blocked ? 1 : 0,
        ts,
      );
      return {
        id,
        sessionId: input.sessionId ?? null,
        projectId: input.projectId ?? null,
        toolName: input.toolName,
        inputJson: input.inputJson,
        outputJson: input.outputJson ?? null,
        blocked: input.blocked ?? false,
        createdAt: ts,
      };
    },
    getSettings(config: ConfigSnapshot): SettingsSnapshot {
      const cloudEnabled = /^(1|true|yes)$/i.test(process.env.AI_CLOUD_ENABLED ?? "");
      const qdrantEnabled = /^(1|true|yes)$/i.test(process.env.AI_QDRANT_ENABLED ?? "");
      return {
        ...config,
        cloudEnabled,
        qdrantEnabled,
        projectCount: store.listProjects().length,
      };
    },
    async createPlan(input: PlanRequest): Promise<{
      session: SessionRecord;
      response: PlanResponse;
    }> {
      const project = store.getProject(input.project);
      if (!project) throw new Error(`Unknown project: ${input.project}`);
      const risk = input.risk ?? "medium";
      const { decision: routeDecision, profileId: selectedPlannerProfile } = await resolveModelProfile(
        {
          role: "planner",
          mode: "local",
          cloudEnabled: process.env.AI_CLOUD_ENABLED === "true",
          details: { risk, goal: input.goal, contextTokens: Math.max(2048, Math.min(32_768, input.goal.length * 64)) },
          fallbackProfileId: "planner-balanced-local",
        },
        selectModelProfile("plan", { risk, goal: input.goal }),
      );
      const session = store.createSession({
        projectId: project.id,
        title: `Plan: ${input.goal.slice(0, 60)}`,
        userGoal: input.goal,
        mode: "plan",
        modelProfile: selectedPlannerProfile,
        source: "cli",
      });
      modelsRepo.recordRoute({
        taskPattern: "plan",
        mode: "any",
        selectedProfileId: selectedPlannerProfile,
        fallbackProfileId: routeDecision.fallbackProfileId,
        reason: `${routeDecision.reason}; risk=${risk}; blocked=${routeDecision.blocked}`,
      });
      const files = store.listProjectFiles(project.id, 12).map((file) => file.path);
      const defaultTaskGraph: PlannerTaskDraft[] = [
        {
          title: "Inspect current implementation",
          description: `Read the relevant files for ${input.goal}.`,
          expectedFiles: files.slice(0, 4),
          checks: ["typecheck"],
        },
        {
          title: "Make the smallest correct change",
          description: `Implement the change while keeping the edit scope narrow.`,
          expectedFiles: files.slice(0, 3),
          checks: ["typecheck", "tests"],
        },
        {
          title: "Validate and hand off",
          description: "Run the relevant checks and package the result.",
          expectedFiles: files.slice(0, 2),
          checks: ["typecheck", "tests"],
        },
      ];
      const plannerProfileId = session.modelProfile ?? "planner-balanced-local";
      const compiledPlanner = compilePrompt({
        mode: "planner",
        role: "planner",
        userRequest: input.goal,
        taskConstraints: [
          `Project: ${project.name}`,
          `Risk: ${risk}`,
          "Return a small task graph with files and checks.",
          "Do not propose destructive actions.",
        ],
        outputSchema: {
          type: "object",
          properties: {
            taskGraph: { type: "array" },
            likelyFiles: { type: "array", items: { type: "string" } },
            checks: { type: "array", items: { type: "string" } },
          },
          required: ["taskGraph", "likelyFiles", "checks"],
        },
        metadata: { sessionId: session.id, projectId: project.id, files },
      });
      store.recordCompiledPrompt({
        compiledPrompt: compiledPlanner,
        sessionId: session.id,
        taskId: null,
      });
      let plannerParseStatus: "parsed" | "repaired" | "deterministic_fallback" = "deterministic_fallback";
      let taskGraphDraft = defaultTaskGraph;
      let likelyFiles = files.slice(0, 8);
      let checks = ["typecheck", "tests"];
      let modelRecommendation =
        risk === "high" ? "planner-deep-local" : risk === "medium" ? "planner-balanced-local" : "planner-fast-local";
      let plannerModelCallId: string | null = null;
      try {
        store.appendEvent(createEvent("model.called", { role: "planner", profileId: plannerProfileId, compiledId: compiledPlanner.id }, { sessionId: session.id, projectId: project.id, agent: "planner" }));
        const plannerResult = await invokeModel(
          plannerProfileId,
          {
            role: "planner",
            messages: compiledPlanner.messages,
            temperature: 0,
            maxOutputTokens: modelsRepo.getProfile(plannerProfileId)?.maxOutputTokens ?? 1024,
            metadata: {
              compiledPrompt: compiledPlanner,
              responseTrace: { taskGraph: taskGraphDraft, likelyFiles, checks },
            },
          },
          {
            sessionId: session.id,
            taskId: null,
          },
        );
        const parsePlannerResult = (text: string): ReturnType<typeof parsePlannerOutput> => {
          try {
            return parsePlannerOutput(parseJsonFragment(text));
          } catch {
            return null;
          }
        };
        let parsedPlanner = parsePlannerResult(plannerResult.text);
        if (parsedPlanner) {
          plannerParseStatus = "parsed";
        } else if (isLikelyJsonOutput(plannerResult.text)) {
          const repaired = await invokeModel(
            plannerProfileId,
            {
              role: "planner",
              messages: [
                ...compiledPlanner.messages,
                { role: "assistant", content: plannerResult.text },
                { role: "user", content: "Return ONLY valid JSON matching the output schema. No markdown fences." },
              ],
              temperature: 0,
              maxOutputTokens: modelsRepo.getProfile(plannerProfileId)?.maxOutputTokens ?? 1024,
              metadata: {
                compiledPrompt: compiledPlanner,
                repairAttempt: true,
              },
            },
            {
              sessionId: session.id,
              taskId: null,
            },
          );
          parsedPlanner = parsePlannerResult(repaired.text);
          if (parsedPlanner) {
            plannerParseStatus = "repaired";
          }
        }
        if (parsedPlanner) {
          taskGraphDraft = parsedPlanner.taskGraph;
          likelyFiles = parsedPlanner.likelyFiles.length > 0 ? parsedPlanner.likelyFiles.slice(0, 8) : likelyFiles;
          checks = parsedPlanner.checks.length > 0 ? parsedPlanner.checks : checks;
          modelRecommendation = parsedPlanner.modelRecommendation ?? modelRecommendation;
        }
        plannerModelCallId = modelsRepo.listCalls(session.id, 200)
          .filter((call) => call.role === "planner" && call.profileId === plannerProfileId)
          .at(-1)?.id ?? null;
        store.appendEvent(createEvent("model.completed", { role: "planner", profileId: plannerProfileId, requestId: plannerModelCallId, compiledId: compiledPlanner.id, parseStatus: plannerParseStatus }, { sessionId: session.id, projectId: project.id, agent: "planner" }));
      } catch (error) {
        store.appendEvent(
          createEvent(
            "model.failed",
            { role: "planner", error: error instanceof Error ? error.message : String(error), compiledId: compiledPlanner.id },
            { sessionId: session.id, projectId: project.id, agent: "planner", level: "warn" },
          ),
        );
      }
      const persistedTaskGraph = taskGraphDraft.map((task, index) => {
        const record = store.createTask({
          sessionId: session.id,
          title: task.title,
          description: task.description,
          type: `plan.${index + 1}`,
          risk,
          priority: index + 1,
        });
        store.updateTask(record.id, {
          expectedFilesJson: JSON.stringify(task.expectedFiles),
          checksJson: JSON.stringify(task.checks),
        });
        store.appendEvent(
          createEvent(
            "task.created",
            { title: task.title, description: task.description, expectedFiles: task.expectedFiles, checks: task.checks },
            { sessionId: session.id, projectId: project.id, taskId: record.id, agent: "planner" },
          ),
        );
        return {
          id: record.id,
          title: task.title,
          description: task.description,
          status: "queued" as const,
          expectedFiles: task.expectedFiles,
          checks: task.checks,
        };
      });
      const response: PlanResponse = {
        sessionId: session.id,
        projectId: project.id,
        goal: input.goal,
        risk,
        taskGraph: persistedTaskGraph,
        likelyFiles,
        checks,
        modelRecommendation,
        researchDepth: risk === "low" ? "shallow" : risk === "high" ? "deep" : "standard",
      };
      store.appendEvent(
        createEvent("task.created", { title: "Plan generated", goal: input.goal }, { sessionId: session.id, projectId: project.id, agent: "planner" }),
      );
      store.updateSession(session.id, {
        status: "completed",
        finishedAt: now(),
        finalSummary: `Generated plan for ${input.goal}.`,
      });
      store.enqueueJob({
        type: "plan.review",
        payload: {
          projectId: project.id,
          sessionId: session.id,
          goal: input.goal,
          risk: response.risk,
          taskGraph: persistedTaskGraph.map((task) => ({ id: task.id, title: task.title, description: task.description })),
        },
      });
      enqueueReflectionJob(store, session.id, "plan", project.id);
      return { session, response };
    },
    async createHandoff(input: HandoffRequest): Promise<HandoffResponse> {
      const project = store.getProject(input.project);
      if (!project) throw new Error(`Unknown project: ${input.project}`);
      const session = store.getSession(input.sessionId);
      if (!session) throw new Error(`Unknown session: ${input.sessionId}`);
      modelsRepo.recordRoute({
        taskPattern: "handoff",
        mode: "any",
        selectedProfileId: session.modelProfile ?? "handoff-local",
        reason: `target=${input.target}`,
      });
      const files = store.listProjectFiles(project.id, 10).map((file) => file.path);
      const recentQueries = retrievalRepo.listQueriesForSession(session.id, 5);
      const lastQuery = recentQueries.at(-1) ?? null;
      const lastContext = lastQuery ? retrievalRepo.listSelectedContext(lastQuery.id) : [];
      const lastResults = lastQuery ? retrievalRepo.listResults(lastQuery.id, 10) : [];
      const memoryEntries = memoryRepo.listEntries(project.id, undefined, 5);
      const facts = memoryRepo.listFacts(project.id, 5);
      const rules = memoryRepo.listProjectRules(project.id, 5);
      const previousMessages = conversationRepo.listMessages(session.id).slice(-6);
      const ranked: RankedChunk[] = [];
      for (const item of lastContext) {
        const result = lastResults.find((r) => r.chunkId === item.chunkId);
        if (!result) continue;
        ranked.push({
          chunk: {
            id: item.chunkId,
            projectId: project.id,
            documentId: result.path,
            path: result.path,
            content: item.excerpt,
            startLine: result.startLine,
            endLine: result.endLine,
            tokenCount: item.tokenCount,
            score: result.finalScore,
            metadata: { retrievalQueryId: lastQuery?.id ?? null },
          },
          baseScore: result.baseScore,
          rerankScore: result.rerankScore,
          finalScore: result.finalScore,
          rerankReason: result.reason ?? "no-boost",
          boosters: [],
        });
      }
      const packedContext = buildContextPack({
        sessionId: session.id,
        taskId: session.activeTaskId,
        projectId: project.id,
        retrievalQueryId: lastQuery?.id ?? null,
        budgetTokens: 4096,
        ranked,
        memoryEntries,
        facts,
        rules,
        previousMessages,
        systemInstructions: [
          `Target: ${input.target}`,
          `Project: ${project.name}`,
          input.subtask,
          "No arbitrary shell execution from the assistant output.",
          "Keep edits within the project root.",
          "Destructive actions require human approval.",
        ],
      });
      const contextPack = contextRepo.recordPack({
        sessionId: session.id,
        taskId: session.activeTaskId,
        projectId: project.id,
        retrievalQueryId: lastQuery?.id ?? null,
        budgetTokens: packedContext.pack.budgetTokens,
        usedTokens: packedContext.pack.usedTokens,
        reason: packedContext.pack.reason ?? `handoff:${input.target}`,
        items: packedContext.items.map((item, index) => ({
          kind: item.kind,
          sourceId: item.sourceId,
          rank: item.rank ?? index,
          tokenCount: item.tokenCount,
          excerpt: item.excerpt,
          included: item.included,
          omissionReason: item.omissionReason,
        })),
        budgetEvents: packedContext.budgetEvents.map((event) => ({
          deltaTokens: event.deltaTokens,
          reason: event.reason,
        })),
      });
      const compiled = compilePrompt({
        mode: "handoff",
        role: "coder_handoff",
        contextPackId: contextPack.id,
        userRequest: input.subtask,
        projectRules: rules,
        memoryEntries,
        facts,
        retrievalChunks: ranked.map((r) => r.chunk),
        previousMessages,
        taskConstraints: [
          `Target: ${input.target}`,
          `Project: ${project.name}`,
          input.subtask,
          "No arbitrary shell execution from the assistant output.",
          "Keep edits within the project root.",
          "Destructive actions require human approval.",
        ],
        outputSchema: {
          type: "object",
          properties: { prompt: { type: "string" } },
          required: ["prompt"],
        },
        metadata: { target: input.target, sessionId: session.id, contextPackId: contextPack.id },
        tokenBudget: 4096,
      });
      store.recordCompiledPrompt({
        compiledPrompt: compiled,
        sessionId: session.id,
        taskId: session.activeTaskId,
        contextPackId: contextPack.id,
      });
      const prompt = compiled.messages.map((m) => `${m.role}: ${m.content}`).join("\n\n");
      const selectedContext = {
        filesToInspect: files.slice(0, 4),
        filesLikelyToEdit: files.slice(0, 3),
        checksToRun: ["typecheck", "tests"],
        constraints: [
          "No arbitrary shell execution",
          "Keep edits within the project root",
          "Do not delete files without approval",
          `Context pack: ${contextPack.id} (${packedContext.pack.usedTokens}/${packedContext.pack.budgetTokens} tokens)`,
        ],
      };
      const id = createId("handoff");
      const ts = now();
      db.prepare(
        `INSERT INTO handoffs (id, session_id, task_id, project_id, target, prompt, selected_context_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, session.id, session.activeTaskId, project.id, input.target, prompt, JSON.stringify(selectedContext), ts, ts);
      const handoffProfileId = modelsRepo.getProfile("handoff-local")?.id ?? "handoff-local";
      let handoffModelCallId: string | null = null;
      try {
        store.appendEvent(createEvent("model.called", { role: "coder_handoff", profileId: handoffProfileId, compiledId: compiled.id }, { sessionId: session.id, projectId: project.id, agent: "handoff_agent" }));
        await invokeModel(
          handoffProfileId,
          {
            role: "coder_handoff",
            messages: compiled.messages,
            temperature: 0,
            maxOutputTokens: modelsRepo.getProfile(handoffProfileId)?.maxOutputTokens ?? 1024,
            metadata: {
              compiledPrompt: compiled,
              contextPackId: contextPack.id,
              target: input.target,
              responseTrace: { handoffId: id, prompt, selectedContext, promptCompiled: true },
            },
          },
          {
            sessionId: session.id,
            taskId: session.activeTaskId,
          },
        );
        handoffModelCallId = modelsRepo.listCalls(session.id, 200)
          .filter((call) => call.role === "coder_handoff" && call.profileId === handoffProfileId)
          .at(-1)?.id ?? null;
        store.appendEvent(createEvent("model.completed", { role: "coder_handoff", profileId: handoffProfileId, requestId: handoffModelCallId, compiledId: compiled.id }, { sessionId: session.id, projectId: project.id, agent: "handoff_agent" }));
      } catch (error) {
        store.appendEvent(
          createEvent(
            "model.failed",
            { role: "coder_handoff", error: error instanceof Error ? error.message : String(error), compiledId: compiled.id },
            { sessionId: session.id, projectId: project.id, agent: "handoff_agent", level: "warn" },
          ),
        );
      }
      const handoffAgentRun = agentsRepo.createRun({
        sessionId: session.id,
        taskId: session.activeTaskId,
        projectId: project.id,
        agent: "handoff_agent",
        role: "target-handoff",
        modelRole: "coder_handoff",
        risk: "low",
        input: { target: input.target, subtask: input.subtask, contextPackId: contextPack.id, compiledId: compiled.id },
      });
      agentsRepo.appendMessage({
        agentRunId: handoffAgentRun.id,
        direction: "out",
        role: "prompt",
        content: prompt,
        meta: { target: input.target, subtask: input.subtask, compiledId: compiled.id, modelCallId: handoffModelCallId, safetyNotes: compiled.safetyNotes.length },
      });
      agentsRepo.updateRun(handoffAgentRun.id, {
        status: "completed",
        finishedAt: now(),
        durationMs: 0,
        output: { handoffId: id, contextPackId: contextPack.id, target: input.target, compiledId: compiled.id, modelCallId: handoffModelCallId },
      });
      agentsRepo.recordHandoff({
        fromAgentRunId: handoffAgentRun.id,
        toAgent: input.target,
        payload: { subtask: input.subtask, filesToInspect: selectedContext.filesToInspect, checks: selectedContext.checksToRun, compiledId: compiled.id },
        contextPackId: contextPack.id,
        sessionId: session.id,
        taskId: session.activeTaskId,
      });
      store.appendEvent(createEvent("handoff.created", { target: input.target, prompt, contextPackId: contextPack.id, compiledId: compiled.id }, { sessionId: session.id, projectId: project.id, agent: "handoff" }));
      store.enqueueJob({
        type: "handoff.archive",
        payload: {
          handoffId: id,
          sessionId: session.id,
          projectId: project.id,
          target: input.target,
          prompt,
        },
      });
      return { id, sessionId: session.id, projectId: project.id, target: input.target, prompt, selectedContext };
    },
    dashboardSnapshot(): DashboardSnapshot {
      const projects = db.prepare("SELECT COUNT(*) AS count FROM projects").get() as Row;
      const activeSessions = db
        .prepare("SELECT COUNT(*) AS count FROM agent_sessions WHERE status IN ('queued','running','paused')")
        .get() as Row;
      return {
        projects: toNumber(projects.count),
        activeSessions: toNumber(activeSessions.count),
        recentSessions: store.listSessions(10),
        recentLessons: store.listRecentLessons(8),
        recentChecks: store.listRecentChecks(8),
      };
    },
    searchChunks(projectId: string, query: string, options: SearchOptions = {}): RetrievalChunk[] {
      const project = store.getProject(projectId);
      const projectConfig = project ? resolveProjectConfig(project.path) : null;
      const embeddingConfig = readEmbeddingConfig({ cloudEnabled: process.env.AI_CLOUD_ENABLED === "true" });
      const queryVector = query.trim().length > 0
        ? embedQueryForQdrant({ text: query.trim(), dimension: embeddingConfig.dimension })
        : null;
      const chunks = searchProjectChunks({
        db,
        projectId,
        query,
        limit: options.limit ?? 8,
        qdrantSettings: getActiveQdrantSettings(),
        queryVectorDimension: embeddingConfig.dimension,
        queryVector,
      });
      if (!projectConfig || projectConfig.retrieval.boostPaths.length === 0) {
        return chunks;
      }
      const boosted = chunks.map((chunk) => {
        const pathBoost = boostWeightForPath(chunk.path, projectConfig);
        const authBoost = projectConfig.retrieval.authHints.some((hint) => `${chunk.path}\n${chunk.content}`.toLowerCase().includes(hint.toLowerCase())) ? 0.5 : 0;
        return pathBoost > 0 || authBoost > 0
          ? { ...chunk, score: chunk.score + pathBoost + authBoost }
          : chunk;
      });
      boosted.sort((left, right) => right.score - left.score);
      return boosted;
    },
    searchChunksWithVector(projectId: string, query: string, queryVector: number[], options: SearchOptions = {}): RetrievalChunk[] {
      return searchProjectChunks({
        db,
        projectId,
        query,
        limit: options.limit ?? 8,
        qdrantSettings: getActiveQdrantSettings(),
        queryVectorDimension: queryVector.length,
        queryVector,
      });
    },
    async addOrUpdateProject(input: ProjectCreateInput): Promise<ProjectSummary> {
      return store.createProject(input);
    },
    async indexProject(projectIdentifier: string): Promise<IndexResult> {
      const project = store.getProject(projectIdentifier);
      if (!project) {
        throw new Error(`Unknown project: ${projectIdentifier}`);
      }
      const projectConfig = resolveProjectConfig(project.path);
      const { decision: routeDecision, profileId: selectedEmbeddingProfile } = await resolveModelProfile(
        {
          role: "embedding",
          mode: "local",
          cloudEnabled: process.env.AI_CLOUD_ENABLED === "true",
          details: { goal: project.path, contextTokens: 1024 },
          fallbackProfileId: projectConfig.models.embedding ?? "embedding-local",
        },
        selectModelProfile("index", { goal: project.path }),
      );

      const session = store.createSession({
        projectId: project.id,
        title: `Index ${project.name}`,
        userGoal: `Index project ${project.path}`,
        mode: "index",
        modelProfile: selectedEmbeddingProfile,
        source: "cli",
      });
      modelsRepo.recordRoute({
        taskPattern: "index",
        mode: "any",
        selectedProfileId: selectedEmbeddingProfile,
        fallbackProfileId: routeDecision.fallbackProfileId,
        reason: `${routeDecision.reason}; project=${project.name}; blocked=${routeDecision.blocked}`,
      });

      const events: EventEnvelope[] = [];
      const push = (type: EventType, payload: Record<string, unknown>, details: Partial<Pick<EventEnvelope, "taskId" | "agent" | "level">> = {}) => {
        const event = createEvent(type, payload, {
          sessionId: session.id,
          projectId: project.id,
          taskId: details.taskId ?? null,
          agent: details.agent ?? "indexer",
          level: details.level ?? "info",
        });
        store.appendEvent(event);
        events.push(event);
        return event;
      };

      const task = store.createTask({
        sessionId: session.id,
        title: "Index project files",
        description: `Scan ${project.path} and update the local retrieval store.`,
        type: "index",
        risk: "low",
        priority: 1,
      });

      store.updateSession(session.id, {
        activeTaskId: task.id,
      });
      store.updateTask(task.id, { status: "running" });
      store.updateProjectStatus(project.id, "indexing");
      push("session.created", { title: session.title, source: session.source }, { agent: "orchestrator" });
      push("session.started", { mode: session.mode }, { agent: "orchestrator" });
      push("task.created", { title: task.title, description: task.description }, { taskId: task.id, agent: "orchestrator" });
      push("task.started", { title: task.title }, { taskId: task.id, agent: "orchestrator" });

      const embeddingProfileId = session.modelProfile ?? "embedding-local";
      const embeddingConfig = readEmbeddingConfig({ cloudEnabled: process.env.AI_CLOUD_ENABLED === "true" });
      const qdrantSettings = getActiveQdrantSettings();
      const embeddingProfile = modelsRepo.getProfile(embeddingProfileId);
      const qdrantClient = qdrantSettings ? new QdrantClient({ settings: qdrantSettings, initialDimension: embeddingConfig.dimension }) : null;
      qdrantClient?.setDimension(embeddingConfig.dimension);
      const qdrantDimensionState = qdrantClient?.probe() ?? null;
      if (qdrantDimensionState && qdrantDimensionState.status === "mismatch") {
        disableQdrant();
      }
      const indexSummary = await runIndexerProject({
        db,
        projectId: project.id,
        projectPath: project.path,
        projectConfig,
        qdrant: qdrantClient,
        embedBatch: async (inputs) => {
          return getRuntime().embed(
            embeddingProfileId,
            { input: inputs, modelName: embeddingConfig.model },
            {
              sessionId: session.id,
              taskId: task.id,
              recordCall: (call) => {
                modelsRepo.recordCall(call);
              },
            },
          );
        },
        embeddingModel: embeddingProfile?.modelName ?? embeddingConfig.model,
        embeddingProvider: embeddingProfile?.providerId ?? "provider_heuristic_local",
        embeddingDimension: embeddingConfig.dimension,
      });
      if (indexSummary.qdrantFailed) {
        disableQdrant();
      }
      const completedSession = store.updateSession(session.id, {
        status: "completed",
        finishedAt: now(),
        durationMs: Date.parse(now()) - Date.parse(session.startedAt),
        activeTaskId: null,
        finalSummary: `Indexed ${indexSummary.filesIndexed} files and ${indexSummary.chunksIndexed} chunks.`,
      });
      store.updateTask(task.id, { status: "completed", resultJson: JSON.stringify(indexSummary) });
      store.updateProjectStatus(project.id, "ready", now());
      const indexerRun = agentsRepo.createRun({
        sessionId: session.id,
        taskId: task.id,
        projectId: project.id,
        agent: "indexer",
        role: "indexer",
        modelRole: "embedding",
        risk: "low",
        input: { projectPath: project.path, mode: "index" },
      });
      agentsRepo.appendMessage({
        agentRunId: indexerRun.id,
        direction: "out",
        role: "summary",
        content: `Indexed ${indexSummary.filesIndexed} files and ${indexSummary.chunksIndexed} chunks.`,
        meta: { qdrantFailed: indexSummary.qdrantFailed },
      });
      agentsRepo.updateRun(indexerRun.id, {
        status: "completed",
        finishedAt: now(),
        durationMs: Date.parse(now()) - Date.parse(indexerRun.startedAt),
        output: { filesIndexed: indexSummary.filesIndexed, chunksIndexed: indexSummary.chunksIndexed, qdrantFailed: indexSummary.qdrantFailed },
      });
      const embeddingCalls = modelsRepo.listCalls(session.id, 200).filter((call) => call.role === "embedding");
      const lastEmbeddingCall = embeddingCalls.at(-1) ?? null;
      store.appendEvent(createEvent("model.called", { role: "embedding", profileId: embeddingProfileId, batchCalls: embeddingCalls.length }, { sessionId: session.id, projectId: project.id, taskId: task.id, agent: "indexer" }));
      store.appendEvent(createEvent("model.completed", { role: "embedding", profileId: embeddingProfileId, requestId: lastEmbeddingCall?.id ?? null, batchCalls: embeddingCalls.length }, { sessionId: session.id, projectId: project.id, taskId: task.id, agent: "indexer" }));

      push("task.completed", { filesIndexed: indexSummary.filesIndexed, chunksIndexed: indexSummary.chunksIndexed }, { taskId: task.id, agent: "indexer" });
      push("session.completed", { summary: completedSession.finalSummary }, { agent: "orchestrator" });
      const lesson = store.createLesson({
        projectId: project.id,
        sessionId: session.id,
        title: `Indexed ${project.name}`,
        body: `Indexed ${indexSummary.filesIndexed} files and ${indexSummary.chunksIndexed} chunks from ${project.path}.`,
        tags: ["indexing", "bootstrap"],
        importance: 1,
      });
      push("lesson.created", { id: lesson.id, title: lesson.title, body: lesson.body, tags: ["indexing", "bootstrap"], importance: 1 }, { agent: "learning" });
      enqueueReflectionJob(store, session.id, "index", project.id);

      return {
        project: store.getProject(project.id)!,
        session: completedSession,
        events,
        filesIndexed: indexSummary.filesIndexed,
        chunksIndexed: indexSummary.chunksIndexed,
      };
    },
    createLesson(input: {
      projectId: string | null;
      sessionId: string | null;
      title: string;
      body: string;
      tags: string[];
      importance: number;
    }) {
      const id = createId("lesson");
      const ts = now();
      db.prepare(
        `INSERT INTO lessons (id, project_id, session_id, title, body, tags_json, importance, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, input.projectId, input.sessionId, input.title, input.body, JSON.stringify(input.tags), input.importance, ts, ts);
      memoryRepo.createCandidate({
        projectId: input.projectId,
        sessionId: input.sessionId,
        kind: "workflow_lesson",
        title: input.title,
        body: input.body,
        evidence: [{ kind: "lesson", tags: input.tags, importance: input.importance }],
        confidence: Math.min(1, Math.max(0, input.importance / 5)),
        scope: input.projectId ? "project" : "global",
      });
      return { id, ...input, createdAt: ts, updatedAt: ts };
    },
    recordCompiledPrompt(input: {
      compiledPrompt: CompiledPrompt;
      sessionId?: string | null;
      taskId?: string | null;
      retrievalQueryId?: string | null;
      contextPackId?: string | null;
    }): CompiledPromptRecord {
      return promptRepo.recordCompiledPrompt({
        id: input.compiledPrompt.id,
        sessionId: input.sessionId ?? null,
        taskId: input.taskId ?? null,
        retrievalQueryId: input.retrievalQueryId ?? null,
        contextPackId: input.contextPackId ?? input.compiledPrompt.contextPackId ?? null,
        mode: input.compiledPrompt.mode,
        role: input.compiledPrompt.role,
        messagesJson: JSON.stringify(input.compiledPrompt.messages),
        estimatedTokens: input.compiledPrompt.estimatedTokens,
        includedContextJson: JSON.stringify(input.compiledPrompt.includedContext),
        omittedContextJson: JSON.stringify(input.compiledPrompt.omittedContext),
        safetyNotesJson: JSON.stringify(input.compiledPrompt.safetyNotes),
        outputSchemaJson: input.compiledPrompt.outputSchema == null ? null : JSON.stringify(input.compiledPrompt.outputSchema),
      });
    },
    listCompiledPrompts(sessionId?: string | null, limit = 50): CompiledPromptRecord[] {
      return promptRepo.listCompiledPrompts(sessionId ?? null, limit);
    },
    getCompiledPrompt(promptId: string): CompiledPromptRecord | null {
      return promptRepo.getCompiledPrompt(promptId);
    },
    async ask(input: AskRequest): Promise<AskResponse> {
      const project = store.getProject(input.project);
      const projectConfig = project ? resolveProjectConfig(project.path) : null;
      return runAskWorkflow({
        store,
        runtime: getRuntime(),
        cloudEnabled: process.env.AI_CLOUD_ENABLED === "true",
        input,
        preferredAnswerProfileId: projectConfig?.models.answer ?? null,
      });
    },
    getConfig(config: ConfigSnapshot): ConfigSnapshot {
      return config;
    },
    recommendModelProfile(
      mode: AskMode | "ask" | "any" | "index" | "plan" | "handoff" | "check" | "reflect",
      details: { risk?: "low" | "medium" | "high"; depth?: "shallow" | "standard" | "deep"; question?: string; goal?: string } = {},
    ): string {
      return selectModelProfile(mode, details);
    },
    recordModelRoute(input: {
      taskPattern: string;
      mode: "local" | "cloud" | "hybrid" | "any";
      selectedProfileId: string;
      fallbackProfileId?: string | null;
      reason?: string | null;
    }) {
      return modelsRepo.recordRoute(input);
    },
    listModelRoutes(limit = 50) {
      return modelsRepo.listRoutes(limit);
    },
    listStatefulSessions(): SessionRecord[] {
      return store.listSessions(100);
    },
    conversation: conversationRepo,
    codeIntelligence: codeIntelligenceRepo,
    retrieval: retrievalRepo,
    models: modelsRepo,
    agents: agentsRepo,
    context: contextRepo,
    memory: memoryRepo,
    skills: skillsRepo,
    evals: evalRepo,
    promptLab: promptLabRepo,
  };
  return store;
}

function safeParseJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

interface PlannerTaskDraft {
  title: string;
  description: string;
  expectedFiles: string[];
  checks: string[];
}

function parsePlannerOutput(value: unknown): {
  taskGraph: PlannerTaskDraft[];
  likelyFiles: string[];
  checks: string[];
  modelRecommendation: string | null;
} | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.taskGraph) || !Array.isArray(record.likelyFiles) || !Array.isArray(record.checks)) {
    return null;
  }
  const likelyFiles = record.likelyFiles.filter((entry): entry is string => typeof entry === "string");
  const checks = record.checks.filter((entry): entry is string => typeof entry === "string");
  const taskGraph = record.taskGraph
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry))
    .map((entry) => {
      const expectedFiles = Array.isArray(entry.expectedFiles)
        ? entry.expectedFiles.filter((file): file is string => typeof file === "string")
        : [];
      const taskChecks = Array.isArray(entry.checks)
        ? entry.checks.filter((check): check is string => typeof check === "string")
        : [];
      return {
        title: typeof entry.title === "string" ? entry.title : "",
        description: typeof entry.description === "string" ? entry.description : "",
        expectedFiles,
        checks: taskChecks,
      };
    })
    .filter((entry) => entry.title.length > 0 && entry.description.length > 0);
  if (taskGraph.length === 0) {
    return null;
  }
  return {
    taskGraph,
    likelyFiles,
    checks,
    modelRecommendation: typeof record.modelRecommendation === "string" ? record.modelRecommendation : null,
  };
}

function detectLanguageFromPath(projectPath: string): string | null {
  const name = basename(projectPath).toLowerCase();
  if (name.includes("python") || name.includes("py")) return "python";
  if (name.includes("web") || name.includes("frontend")) return "typescript";
  return null;
}

export function createDatabaseBootstrap(dbPath: string) {
  const db = new DatabaseSync(dbPath);
  return { db };
}
