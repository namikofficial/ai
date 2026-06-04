import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
// @ts-ignore - this workspace's node type surface does not expose node:module, but the runtime does.
import { createRequire } from "node:module";
import { basename, extname, join, normalize, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "./migrate.ts";
import { buildAnswer, selectModelProfile } from "../../model-runtime/src/index.ts";
import {
  createAgentsRepo,
  createContextRepo,
  createConversationRepo,
  createEvalRepo,
  createMemoryRepo,
  createModelsRepo,
  createRetrievalRepo,
  createSkillsRepo,
} from "./repositories/index.ts";
import type {
  AskMode,
  AskRequest,
  AskResponse,
  CheckRunSummary,
  ConfigSnapshot,
  DashboardSnapshot,
  EventEnvelope,
  EventType,
  HandoffRequest,
  HandoffResponse,
  McpCallSummary,
  MemoryEntry,
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
  analyzeQuery,
  buildFtsQuery,
  classifyIntent,
  rankChunk,
  rewriteQuery,
} from "../../retrieval-engine/src/index.ts";
import { createEvent, createId, slugifyName } from "../../shared/src/index.ts";

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

const DEFAULT_MODEL_PROVIDER_ROWS = [
  {
    id: "provider_heuristic_local",
    kind: "heuristic" as const,
    displayName: "Heuristic local router",
    baseUrl: null,
    apiKeyEnv: null,
    enabled: true,
  },
  {
    id: "provider_cloud_openai_compat",
    kind: "cloud_openai_compat" as const,
    displayName: "Cloud OpenAI-compatible",
    baseUrl: null,
    apiKeyEnv: "AI_CLOUD_API_KEY",
    enabled: false,
  },
];

const DEFAULT_MODEL_PROFILE_ROWS = [
  { id: "intent-local", providerId: "provider_heuristic_local", role: "intent" as const, modelName: "intent-local", displayName: "Intent classifier" },
  { id: "query-rewrite-local", providerId: "provider_heuristic_local", role: "query_rewrite" as const, modelName: "query-rewrite-local", displayName: "Query rewriter" },
  { id: "retrieval-judge-local", providerId: "provider_heuristic_local", role: "retrieval_judge" as const, modelName: "retrieval-judge-local", displayName: "Retrieval judge" },
  { id: "reranker-local", providerId: "provider_heuristic_local", role: "reranker" as const, modelName: "reranker-local", displayName: "Reranker" },
  { id: "embedding-local", providerId: "provider_heuristic_local", role: "embedding" as const, modelName: "embedding-local", displayName: "Embedding model" },
  { id: "summarizer-local", providerId: "provider_heuristic_local", role: "summarizer" as const, modelName: "summarizer-local", displayName: "Summarizer" },
  { id: "reviewer-local", providerId: "provider_heuristic_local", role: "reviewer" as const, modelName: "reviewer-local", displayName: "Reviewer" },
  { id: "reflection-local", providerId: "provider_heuristic_local", role: "reflection" as const, modelName: "reflection-local", displayName: "Reflection model" },
  { id: "indexer-local", providerId: "provider_heuristic_local", role: "embedding" as const, modelName: "indexer-local", displayName: "Indexer" },
  { id: "ask-fast-local", providerId: "provider_heuristic_local", role: "answer" as const, modelName: "ask-fast-local", displayName: "Fast answer" },
  { id: "ask-extended-local", providerId: "provider_heuristic_local", role: "answer" as const, modelName: "ask-extended-local", displayName: "Extended answer" },
  { id: "ask-deep-local", providerId: "provider_heuristic_local", role: "answer" as const, modelName: "ask-deep-local", displayName: "Deep answer" },
  { id: "ask-hybrid-router", providerId: "provider_heuristic_local", role: "answer" as const, modelName: "ask-hybrid-router", displayName: "Hybrid answer router" },
  { id: "ask-cloud-router", providerId: "provider_cloud_openai_compat", role: "answer" as const, modelName: "ask-cloud-router", displayName: "Cloud answer router", localOnly: false, enabled: false },
  { id: "planner-fast-local", providerId: "provider_heuristic_local", role: "planner" as const, modelName: "planner-fast-local", displayName: "Fast planner" },
  { id: "planner-balanced-local", providerId: "provider_heuristic_local", role: "planner" as const, modelName: "planner-balanced-local", displayName: "Balanced planner" },
  { id: "planner-deep-local", providerId: "provider_heuristic_local", role: "planner" as const, modelName: "planner-deep-local", displayName: "Deep planner" },
  { id: "handoff-local", providerId: "provider_heuristic_local", role: "coder_handoff" as const, modelName: "handoff-local", displayName: "Handoff compiler" },
  { id: "checker-local", providerId: "provider_heuristic_local", role: "reviewer" as const, modelName: "checker-local", displayName: "Check summarizer" },
];

function seedDefaultModelCatalog(modelsRepo: ReturnType<typeof createModelsRepo>): void {
  const profiles = modelsRepo.listProfiles();
  if (profiles.length > 0) {
    return;
  }
  for (const provider of DEFAULT_MODEL_PROVIDER_ROWS) {
    modelsRepo.upsertProvider(provider);
  }
  for (const profile of DEFAULT_MODEL_PROFILE_ROWS) {
    modelsRepo.upsertProfile({
      id: profile.id,
      providerId: profile.providerId,
      role: profile.role,
      modelName: profile.modelName,
      displayName: profile.displayName,
      contextWindow: profile.id.includes("deep") ? 32_768 : profile.id.includes("extended") ? 16_384 : 8_192,
      maxOutputTokens: profile.id.includes("deep") ? 4_096 : 2_048,
      localOnly: profile.localOnly !== false,
      enabled: profile.enabled !== false,
      qualityScore: profile.role === "planner" ? 0.7 : profile.role === "answer" ? 0.65 : 0.6,
      latencyScore: profile.role === "embedding" ? 0.8 : 0.7,
      costScore: profile.localOnly === false ? 0.2 : 0.9,
    });
  }
}

interface QdrantRuntimeSettings {
  enabled: boolean;
  url: string | null;
  collection: string;
}

interface QdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

function getQdrantRuntimeSettings(): QdrantRuntimeSettings {
  const enabled = /^(1|true|yes)$/i.test(process.env.AI_QDRANT_ENABLED ?? "");
  const collection = process.env.AI_QDRANT_COLLECTION ?? "ai_chunks";
  const url = process.env.AI_QDRANT_URL ?? (enabled ? "http://127.0.0.1:6333" : null);
  return { enabled, url, collection };
}

function embedText(text: string): number[] {
  const dim = 32;
  const vector = Array.from({ length: dim }, () => 0);
  const terms = text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((term) => term.length >= 2);
  for (const term of terms) {
    let hash = 2166136261;
    for (let index = 0; index < term.length; index += 1) {
      hash ^= term.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    const bucket = hash >>> 0;
    vector[bucket % dim] += 1;
    vector[(bucket >>> 5) % dim] += term.length / 8;
    vector[(bucket >>> 11) % dim] += term.includes("auth") ? 1.5 : 0.25;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return magnitude > 0 ? vector.map((value) => value / magnitude) : vector;
}

function qdrantRequestSync(
  baseUrl: string,
  path: string,
  init?: { method: string; body?: unknown },
): { ok: boolean; status: number; body: string } | null {
  const method = init?.method ?? "GET";
  const encodedBody = init?.body === undefined ? "" : encodeURIComponent(JSON.stringify(init.body));
  const script = `
    const [url, method, bodyB64] = process.argv.slice(1);
    const body = bodyB64 ? JSON.parse(decodeURIComponent(bodyB64)) : undefined;
    const response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    process.stdout.write(JSON.stringify({ ok: response.ok, status: response.status, body: text }));
  `;
  const { spawnSync } = require("node:child_process") as {
    spawnSync: (
      command: string,
      args: string[],
      options: { encoding: "utf8"; timeout: number; maxBuffer: number },
    ) => { status: number | null; stdout: string };
  };
  let stdout = "";
  try {
    stdout = spawnSync(process.argv[0], ["--input-type=module", "-e", script, new URL(path, baseUrl).toString(), method, encodedBody], {
      encoding: "utf8",
      timeout: 2500,
      maxBuffer: 10_000_000,
    }).stdout;
  } catch {
    return null;
  }
  try {
    return JSON.parse(stdout) as { ok: boolean; status: number; body: string };
  } catch {
    return null;
  }
}

function ensureQdrantCollectionSync(settings: QdrantRuntimeSettings): boolean {
  if (!settings.enabled || !settings.url) {
    return false;
  }
  const existing = qdrantRequestSync(settings.url, `/collections/${encodeURIComponent(settings.collection)}`, { method: "GET" });
  if (existing?.ok) {
    return true;
  }
  const created = qdrantRequestSync(settings.url, `/collections/${encodeURIComponent(settings.collection)}`, {
    method: "PUT",
    body: {
      vectors: {
        size: 32,
        distance: "Cosine",
      },
    },
  });
  return Boolean(created?.ok);
}

function qdrantPointForChunk(projectId: string, documentId: string, path: string, chunk: { id: string; content: string; startLine: number; endLine: number; tokenCount: number }, language: string | null): QdrantPoint {
  return {
    id: chunk.id,
    vector: embedText(`${path}\n${chunk.content}`),
    payload: {
      chunkId: chunk.id,
      projectId,
      documentId,
      path,
      content: chunk.content,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      tokenCount: chunk.tokenCount,
      metadata: {
        path,
        language,
      },
    },
  };
}

function upsertQdrantChunksSync(settings: QdrantRuntimeSettings, points: QdrantPoint[]): boolean {
  if (!settings.enabled || !settings.url || points.length === 0) {
    return false;
  }
  if (!ensureQdrantCollectionSync(settings)) {
    return false;
  }
  const response = qdrantRequestSync(settings.url, `/collections/${encodeURIComponent(settings.collection)}/points?wait=true`, {
    method: "PUT",
    body: { points },
  });
  return Boolean(response?.ok);
}

function searchQdrantChunksSync(settings: QdrantRuntimeSettings, projectId: string, query: string, limit: number): RetrievalChunk[] | null {
  if (!settings.enabled || !settings.url || query.trim().length === 0) {
    return null;
  }
  if (!ensureQdrantCollectionSync(settings)) {
    return null;
  }
  const response = qdrantRequestSync(settings.url, `/collections/${encodeURIComponent(settings.collection)}/points/search`, {
    method: "POST",
    body: {
      vector: embedText(query),
      limit: limit * 3,
      with_payload: true,
      filter: {
        must: [
          {
            key: "projectId",
            match: {
              value: projectId,
            },
          },
        ],
      },
    },
  });
  if (!response?.ok) {
    return null;
  }
  try {
    const parsed = JSON.parse(response.body) as {
      result?: Array<{
        id: string | number;
        score: number;
        payload?: Record<string, unknown>;
      }>;
    };
    return (parsed.result ?? [])
      .map((result) => {
        const payload = result.payload ?? {};
        const metadata = payload.metadata && typeof payload.metadata === "object" ? (payload.metadata as Record<string, unknown>) : {};
        return {
          id: asString(payload.chunkId ?? result.id),
          projectId: asString(payload.projectId),
          documentId: asString(payload.documentId),
          path: asString(payload.path),
          content: asString(payload.content),
          startLine: toNumber(payload.startLine),
          endLine: toNumber(payload.endLine),
          tokenCount: toNumber(payload.tokenCount),
          score: result.score * 10,
          metadata,
        } satisfies RetrievalChunk;
      })
      .filter((chunk) => chunk.id.length > 0 && chunk.path.length > 0 && chunk.content.length > 0);
  } catch {
    return null;
  }
}

function tryEnableSearchIndex(db: DatabaseSync): boolean {
  try {
    db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunks_fts USING fts5(chunk_id UNINDEXED, project_id UNINDEXED, path, content)",
    );
    return true;
  } catch {
    return false;
  }
}

function syncSearchIndexForFile(db: DatabaseSync, projectId: string, path: string, chunks: Array<{ id: string; content: string }>): void {
  try {
    db.prepare("DELETE FROM rag_chunks_fts WHERE project_id = ? AND path = ?").run(projectId, path);
    const insertSearchRow = db.prepare(
      "INSERT INTO rag_chunks_fts (chunk_id, project_id, path, content) VALUES (?, ?, ?, ?)",
    );
    for (const chunk of chunks) {
      insertSearchRow.run(chunk.id, projectId, path, chunk.content);
    }
  } catch {
    // FTS is optional. When unavailable, the heuristic search path remains active.
  }
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

function lineCount(text: string): number {
  if (text.length === 0) return 1;
  return text.split("\n").length;
}

function chunkContent(content: string, linesPerChunk = 80): Array<{ content: string; startLine: number; endLine: number; tokenCount: number }> {
  const lines = content.split("\n");
  const chunks: Array<{ content: string; startLine: number; endLine: number; tokenCount: number }> = [];
  for (let index = 0; index < lines.length; index += linesPerChunk) {
    const slice = lines.slice(index, index + linesPerChunk);
    const startLine = index + 1;
    const endLine = index + slice.length;
    const chunkText = slice.join("\n").trim();
    if (chunkText.length === 0) {
      continue;
    }
    chunks.push({
      content: chunkText,
      startLine,
      endLine,
      tokenCount: Math.max(1, Math.ceil(chunkText.length / 4)),
    });
  }
  return chunks;
}

function isProbablyTextFile(path: string): boolean {
  return TEXT_EXTENSIONS.has(extname(path).toLowerCase()) || basename(path) === "package.json" || basename(path) === "Dockerfile";
}

async function safeReadText(path: string): Promise<string | null> {
  try {
    const content = await readFile(path, "utf8");
    return content;
  } catch {
    return null;
  }
}

async function isReadableFile(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function countMatches(haystack: string, needle: string): number {
  let count = 0;
  let position = 0;
  while (true) {
    const found = haystack.indexOf(needle, position);
    if (found === -1) break;
    count += 1;
    position = found + needle.length;
  }
  return count;
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
  const qdrantBaseSettings = getQdrantRuntimeSettings();
  let qdrantAvailable = qdrantBaseSettings.enabled && Boolean(qdrantBaseSettings.url);

  function getActiveQdrantSettings(): QdrantRuntimeSettings | null {
    if (!qdrantBaseSettings.enabled || !qdrantAvailable || !qdrantBaseSettings.url) {
      return null;
    }
    return qdrantBaseSettings;
  }

  function disableQdrant(): void {
    qdrantAvailable = false;
  }

  const conversationRepo = createConversationRepo(db);
  const retrievalRepo = createRetrievalRepo(db);
  const modelsRepo = createModelsRepo(db);
  const agentsRepo = createAgentsRepo(db);
  const contextRepo = createContextRepo(db);
  const memoryRepo = createMemoryRepo(db);
  const skillsRepo = createSkillsRepo(db);
  const evalRepo = createEvalRepo(db);

  seedDefaultModelCatalog(modelsRepo);

  const store = {
    db,
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
    createPlan(input: PlanRequest): {
      session: SessionRecord;
      response: PlanResponse;
    } {
      const project = store.getProject(input.project);
      if (!project) throw new Error(`Unknown project: ${input.project}`);
      const session = store.createSession({
        projectId: project.id,
        title: `Plan: ${input.goal.slice(0, 60)}`,
        userGoal: input.goal,
        mode: "plan",
        modelProfile: selectModelProfile("plan", { risk: input.risk, goal: input.goal }),
        source: "cli",
      });
      modelsRepo.recordRoute({
        taskPattern: "plan",
        mode: "any",
        selectedProfileId: session.modelProfile ?? "planner-balanced-local",
        reason: `risk=${input.risk ?? "medium"}`,
      });
      const files = store.listProjectFiles(project.id, 12).map((file) => file.path);
      const taskGraph = [
        {
          id: createId("task"),
          title: "Inspect current implementation",
          description: `Read the relevant files for ${input.goal}.`,
          status: "queued" as const,
          expectedFiles: files.slice(0, 4),
          checks: ["typecheck"],
        },
        {
          id: createId("task"),
          title: "Make the smallest correct change",
          description: `Implement the change while keeping the edit scope narrow.`,
          status: "queued" as const,
          expectedFiles: files.slice(0, 3),
          checks: ["typecheck", "tests"],
        },
        {
          id: createId("task"),
          title: "Validate and hand off",
          description: "Run the relevant checks and package the result.",
          status: "queued" as const,
          expectedFiles: files.slice(0, 2),
          checks: ["typecheck", "tests"],
        },
      ];
      const persistedTaskGraph = taskGraph.map((task, index) => {
        const record = store.createTask({
          sessionId: session.id,
          title: task.title,
          description: task.description,
          type: `plan.${index + 1}`,
          risk: input.risk ?? "medium",
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
        return { ...task, id: record.id };
      });
      const plannerProfileId = session.modelProfile ?? "planner-balanced-local";
      const plannerModelCall = modelsRepo.recordCall({
        sessionId: session.id,
        taskId: persistedTaskGraph[0]?.id ?? null,
        profileId: plannerProfileId,
        role: "planner",
        promptTokens: Math.ceil(input.goal.length / 4),
        completionTokens: Math.ceil(JSON.stringify(taskGraph).length / 4),
        latencyMs: 0,
        status: "ok",
        request: { goal: input.goal, risk: input.risk ?? "medium", files },
        response: { taskGraph: persistedTaskGraph, likelyFiles: files.slice(0, 8) },
      });
      store.appendEvent(createEvent("model.called", { role: "planner", profileId: plannerModelCall.profileId }, { sessionId: session.id, projectId: project.id, agent: "planner" }));
      store.appendEvent(createEvent("model.completed", { role: "planner", profileId: plannerModelCall.profileId, requestId: plannerModelCall.id }, { sessionId: session.id, projectId: project.id, agent: "planner" }));
      const response: PlanResponse = {
        sessionId: session.id,
        projectId: project.id,
        goal: input.goal,
        risk: input.risk ?? "medium",
        taskGraph: persistedTaskGraph,
        likelyFiles: files.slice(0, 8),
        checks: ["typecheck", "tests"],
        modelRecommendation:
          input.risk === "high" ? "planner-deep-local" : input.risk === "medium" ? "planner-balanced-local" : "planner-fast-local",
        researchDepth: input.risk === "low" ? "shallow" : input.risk === "high" ? "deep" : "standard",
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
    createHandoff(input: HandoffRequest): HandoffResponse {
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
      const prompt = [
        `Target: ${input.target}`,
        `Project: ${project.name}`,
        `Subtask: ${input.subtask}`,
        "",
        "Inspect:",
        ...files.slice(0, 4).map((file) => `- ${file}`),
        "",
        "Checks:",
        "- typecheck",
        "- focused tests",
      ].join("\n");
      const selectedContext = {
        filesToInspect: files.slice(0, 4),
        filesLikelyToEdit: files.slice(0, 3),
        checksToRun: ["typecheck", "tests"],
        constraints: ["No arbitrary shell execution", "Keep edits within the project root", "Do not delete files without approval"],
      };
      const id = createId("handoff");
      const ts = now();
      db.prepare(
        `INSERT INTO handoffs (id, session_id, task_id, project_id, target, prompt, selected_context_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, session.id, session.activeTaskId, project.id, input.target, prompt, JSON.stringify(selectedContext), ts, ts);
      const contextPack = contextRepo.recordPack({
        sessionId: session.id,
        taskId: session.activeTaskId,
        projectId: project.id,
        budgetTokens: 2048,
        usedTokens: files.slice(0, 4).reduce((sum, file) => sum + file.length / 4, 0),
        reason: `handoff:${input.target}`,
        items: files.slice(0, 4).map((file, index) => ({
          kind: "previous_session",
          sourceId: file,
          rank: index,
          tokenCount: Math.ceil(file.length / 4),
          excerpt: file,
        })),
      });
      const handoffModelCall = modelsRepo.recordCall({
        sessionId: session.id,
        taskId: session.activeTaskId,
        profileId: modelsRepo.getProfile("handoff-local")?.id ?? "handoff-local",
        role: "coder_handoff",
        promptTokens: Math.ceil((input.subtask.length + files.join("\n").length) / 4),
        completionTokens: Math.ceil(prompt.length / 4),
        latencyMs: 0,
        status: "ok",
        request: { target: input.target, subtask: input.subtask, files, contextPackId: contextPack.id },
        response: { handoffId: id, prompt, selectedContext },
      });
      store.appendEvent(createEvent("model.called", { role: "coder_handoff", profileId: handoffModelCall.profileId }, { sessionId: session.id, projectId: project.id, agent: "handoff_agent" }));
      store.appendEvent(createEvent("model.completed", { role: "coder_handoff", profileId: handoffModelCall.profileId, requestId: handoffModelCall.id }, { sessionId: session.id, projectId: project.id, agent: "handoff_agent" }));
      const handoffAgentRun = agentsRepo.createRun({
        sessionId: session.id,
        taskId: session.activeTaskId,
        projectId: project.id,
        agent: "handoff_agent",
        role: "target-handoff",
        modelRole: "coder_handoff",
        risk: "low",
        input: { target: input.target, subtask: input.subtask, contextPackId: contextPack.id },
      });
      agentsRepo.appendMessage({
        agentRunId: handoffAgentRun.id,
        direction: "out",
        role: "prompt",
        content: prompt,
        meta: { target: input.target, subtask: input.subtask },
      });
      agentsRepo.updateRun(handoffAgentRun.id, {
        status: "completed",
        finishedAt: now(),
        durationMs: 0,
        output: { handoffId: id, contextPackId: contextPack.id, target: input.target },
      });
      agentsRepo.recordHandoff({
        fromAgentRunId: handoffAgentRun.id,
        toAgent: input.target,
        payload: { subtask: input.subtask, filesToInspect: selectedContext.filesToInspect, checks: selectedContext.checksToRun },
        contextPackId: contextPack.id,
        sessionId: session.id,
        taskId: session.activeTaskId,
      });
      store.appendEvent(createEvent("handoff.created", { target: input.target, prompt }, { sessionId: session.id, projectId: project.id, agent: "handoff" }));
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
      const normalizedQuery = query.trim();
      const limit = options.limit ?? 8;
      const candidates = new Map<string, RetrievalChunk>();
      const addCandidates = (chunks: RetrievalChunk[]) => {
        for (const chunk of chunks) {
          const existing = candidates.get(chunk.id);
          if (!existing || chunk.score > existing.score) {
            candidates.set(chunk.id, chunk);
          }
        }
      };

      const qdrantSettings = getActiveQdrantSettings();
      if (normalizedQuery.length > 0 && qdrantSettings) {
        const qdrantChunks = searchQdrantChunksSync(qdrantSettings, projectId, normalizedQuery, limit);
        if (qdrantChunks === null) {
          disableQdrant();
        } else {
          addCandidates(qdrantChunks);
        }
      }

      const ftsQuery = normalizedQuery.length > 0 ? buildFtsQuery(normalizedQuery) : null;
      if (ftsQuery) {
        try {
          const rows = db
            .prepare(
              `SELECT
                c.*,
                (100 - bm25(rag_chunks_fts)) AS fts_score
               FROM rag_chunks_fts
               JOIN rag_chunks c ON c.id = rag_chunks_fts.chunk_id
               WHERE rag_chunks_fts MATCH ? AND c.project_id = ?
               ORDER BY bm25(rag_chunks_fts) ASC
               LIMIT ?`,
            )
            .all(ftsQuery, projectId, limit * 3) as Row[];
          const scored = rows
            .map((row) => {
              const content = asString(row.content);
              const metadata = safeParseJson(asString(row.metadata_json));
              const path = asString(row.path) || asString(metadata.path);
              const heuristicScore = rankChunk(normalizedQuery, path, content, toNumber(row.start_line), toNumber(row.end_line));
              const ftsScore = toNumber(row.fts_score);
              return {
                id: asString(row.id),
                projectId: asString(row.project_id),
                documentId: asString(row.document_id),
                path,
                content,
                startLine: toNumber(row.start_line),
                endLine: toNumber(row.end_line),
                tokenCount: toNumber(row.token_count),
                score: ftsScore + heuristicScore,
                metadata,
              } satisfies RetrievalChunk;
            })
            .filter((chunk) => chunk.score > 0)
            .sort((left, right) => right.score - left.score);
          addCandidates(scored);
        } catch {
          // Fall back to the heuristic scorer if FTS isn't available or the query is unsupported.
        }
      }

      const rows = db
        .prepare("SELECT * FROM rag_chunks WHERE project_id = ? ORDER BY created_at DESC LIMIT 500")
        .all(projectId) as Row[];
      const scored = rows
        .map((row) => {
          const content = asString(row.content);
          const metadata = safeParseJson(asString(row.metadata_json));
          const path = asString(row.path) || asString(metadata.path);
          const score = normalizedQuery.length === 0 ? 1 : rankChunk(normalizedQuery, path, content, toNumber(row.start_line), toNumber(row.end_line));
          return {
            id: asString(row.id),
            projectId: asString(row.project_id),
            documentId: asString(row.document_id),
            path,
            content,
            startLine: toNumber(row.start_line),
            endLine: toNumber(row.end_line),
            tokenCount: toNumber(row.token_count),
            score,
            metadata,
          } satisfies RetrievalChunk;
        })
        .filter((chunk) => normalizedQuery.length === 0 || chunk.score > 0)
        .sort((left, right) => right.score - left.score);
      addCandidates(scored);
      return Array.from(candidates.values())
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);
    },
    async addOrUpdateProject(input: ProjectCreateInput): Promise<ProjectSummary> {
      return store.createProject(input);
    },
    async indexProject(projectIdentifier: string): Promise<IndexResult> {
      const project = store.getProject(projectIdentifier);
      if (!project) {
        throw new Error(`Unknown project: ${projectIdentifier}`);
      }

      const session = store.createSession({
        projectId: project.id,
        title: `Index ${project.name}`,
        userGoal: `Index project ${project.path}`,
        mode: "index",
        modelProfile: selectModelProfile("index", { goal: project.path }),
        source: "cli",
      });
      modelsRepo.recordRoute({
        taskPattern: "index",
        mode: "any",
        selectedProfileId: session.modelProfile ?? "indexer-local",
        reason: `project=${project.name}`,
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

      const indexSummary = await indexProjectFiles(db, project.id, project.path, getActiveQdrantSettings());
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
      const indexModelCall = modelsRepo.recordCall({
        sessionId: session.id,
        taskId: task.id,
        profileId: session.modelProfile ?? "indexer-local",
        role: "embedding",
        promptTokens: Math.ceil(project.path.length / 4),
        completionTokens: Math.ceil(`${indexSummary.filesIndexed}:${indexSummary.chunksIndexed}`.length / 2),
        latencyMs: 0,
        status: "ok",
        request: { projectPath: project.path, fileCount: indexSummary.filesIndexed, chunkCount: indexSummary.chunksIndexed },
        response: { qdrantFailed: indexSummary.qdrantFailed, filesIndexed: indexSummary.filesIndexed, chunksIndexed: indexSummary.chunksIndexed },
      });
      store.appendEvent(createEvent("model.called", { role: "embedding", profileId: indexModelCall.profileId }, { sessionId: session.id, projectId: project.id, taskId: task.id, agent: "indexer" }));
      store.appendEvent(createEvent("model.completed", { role: "embedding", profileId: indexModelCall.profileId, requestId: indexModelCall.id }, { sessionId: session.id, projectId: project.id, taskId: task.id, agent: "indexer" }));

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
    async ask(input: AskRequest): Promise<AskResponse> {
      const project = store.getProject(input.project);
      if (!project) {
        throw new Error(`Unknown project: ${input.project}`);
      }

      const session = store.createSession({
        projectId: project.id,
        title: `Ask: ${input.question.slice(0, 60)}`,
        userGoal: input.question,
        mode: input.mode ?? "local",
        modelProfile: selectModelProfile(input.mode ?? "local", { depth: input.depth, question: input.question }),
        source: "cli",
      });
      modelsRepo.recordRoute({
        taskPattern: "ask",
        mode: input.mode ?? "local",
        selectedProfileId: session.modelProfile ?? "ask-fast-local",
        reason: `depth=${input.depth ?? "standard"}`,
      });

      const userMessage = conversationRepo.appendMessage({
        sessionId: session.id,
        projectId: project.id,
        role: "user",
        agent: "user",
        content: input.question,
        meta: { mode: input.mode ?? "local", depth: input.depth ?? "standard" },
      });

      const retrievalAgentRun = agentsRepo.createRun({
        sessionId: session.id,
        projectId: project.id,
        agent: "retrieval_agent",
        role: "retrieval-pipeline",
        modelRole: "retrieval_judge",
        risk: "low",
        input: { question: input.question, projectId: project.id, mode: input.mode ?? "local", depth: input.depth ?? "standard" },
      });

      const analysis = analyzeQuery(input.question);
      const rewritten = rewriteQuery(input.question, analysis);
      const retrievalQuery = retrievalRepo.createQuery({
        sessionId: session.id,
        projectId: project.id,
        originalQuery: input.question,
        intent: classifyIntent(input.question, input.mode ?? "local"),
        mode: input.mode ?? "local",
        depth: input.depth ?? "standard",
        rewrittenQuery: rewritten.variant,
        analysis,
      });
      if (rewritten.variant !== input.question.trim()) {
        retrievalRepo.updateRewrittenQuery(retrievalQuery.id, rewritten.variant);
      }
      if (rewritten.terms.length > 0) {
        retrievalRepo.createRewrite({
          retrievalQueryId: retrievalQuery.id,
          variant: rewritten.variant,
          terms: rewritten.terms,
          pathHints: rewritten.pathHints,
          symbolHints: rewritten.symbolHints,
          score: 1.0,
        });
      }
      const queryRewriteProfileId = modelsRepo.getProfile("query-rewrite-local")?.id ?? "query-rewrite-local";
      const queryRewriteCall = modelsRepo.recordCall({
        sessionId: session.id,
        retrievalQueryId: retrievalQuery.id,
        profileId: queryRewriteProfileId,
        role: "query_rewrite",
        promptTokens: Math.ceil(input.question.length / 4),
        completionTokens: Math.ceil(rewritten.variant.length / 4),
        latencyMs: 0,
        status: "ok",
        request: { question: input.question, analysis },
        response: { rewritten: rewritten.variant, terms: rewritten.terms, pathHints: rewritten.pathHints, symbolHints: rewritten.symbolHints },
      });
      store.appendEvent(createEvent("model.called", { role: "query_rewrite", profileId: queryRewriteCall.profileId }, { sessionId: session.id, projectId: project.id, agent: "retriever" }));
      store.appendEvent(createEvent("model.completed", { role: "query_rewrite", profileId: queryRewriteCall.profileId, requestId: queryRewriteCall.id }, { sessionId: session.id, projectId: project.id, agent: "retriever" }));
      agentsRepo.appendMessage({
        agentRunId: retrievalAgentRun.id,
        direction: "internal",
        role: "intent",
        content: JSON.stringify({ intent: retrievalQuery.intent, analysis }),
        meta: { retrievalQueryId: retrievalQuery.id },
      });

      const retrievalStarted = createEvent("retrieval.started", { question: input.question }, { sessionId: session.id, projectId: project.id, agent: "retriever" });
      store.appendEvent(retrievalStarted);

      const chunks = store.searchChunks(project.id, rewritten.variant, { limit: input.depth === "deep" ? 12 : input.depth === "shallow" ? 4 : 8 });
      const citations = chunks.map((chunk) => ({
        chunkId: chunk.id,
        path: chunk.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        excerpt: chunk.content.split("\n").slice(0, 4).join("\n"),
        score: chunk.score,
      }));

      const recordedResults = retrievalRepo.recordResults(
        retrievalQuery.id,
        chunks.map((chunk) => ({
          chunkId: chunk.id,
          path: chunk.path,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          source: "heuristic",
          baseScore: chunk.score,
          finalScore: chunk.score,
          included: true,
        })),
      );
      retrievalRepo.recordSelectedContext(
        retrievalQuery.id,
        chunks.map((chunk, index) => ({
          chunkId: chunk.id,
          rank: index,
          tokenCount: chunk.tokenCount,
          excerpt: chunk.content.split("\n").slice(0, 4).join("\n"),
        })),
      );
      const contextPack = contextRepo.recordPack({
        sessionId: session.id,
        projectId: project.id,
        retrievalQueryId: retrievalQuery.id,
        budgetTokens: 4096,
        usedTokens: chunks.reduce((sum, c) => sum + c.tokenCount, 0),
        reason: "ask",
        items: chunks.map((chunk, index) => ({
          kind: "retrieval_chunk",
          sourceId: chunk.id,
          rank: index,
          tokenCount: chunk.tokenCount,
          excerpt: chunk.content.split("\n").slice(0, 4).join("\n"),
          })),
      });

      const confidence = chunks.length === 0 ? 0 : Math.min(0.95, Math.max(0.25, chunks[0].score / 8));
      const insufficientReason = chunks.length === 0 ? "No matching chunks were found in the selected project." : null;
      const retrievalJudgeCall = modelsRepo.recordCall({
        sessionId: session.id,
        taskId: retrievalAgentRun.id,
        retrievalQueryId: retrievalQuery.id,
        profileId: modelsRepo.getProfile("retrieval-judge-local")?.id ?? "retrieval-judge-local",
        role: "retrieval_judge",
        promptTokens: Math.ceil((input.question.length + rewritten.variant.length) / 4),
        completionTokens: Math.ceil(String(chunks.length).length / 2),
        latencyMs: 0,
        status: "ok",
        request: {
          question: input.question,
          rewritten: rewritten.variant,
          chunkCount: chunks.length,
          mode: input.mode ?? "local",
        },
        response: {
          confidence,
          insufficientReason,
          citations: citations.slice(0, 3),
        },
      });
      store.appendEvent(createEvent("model.called", { role: "retrieval_judge", profileId: retrievalJudgeCall.profileId }, { sessionId: session.id, projectId: project.id, agent: "retriever" }));
      store.appendEvent(createEvent("model.completed", { role: "retrieval_judge", profileId: retrievalJudgeCall.profileId, requestId: retrievalJudgeCall.id }, { sessionId: session.id, projectId: project.id, agent: "retriever" }));
      if (chunks.length === 0) {
        retrievalRepo.recordMiss({
          retrievalQueryId: retrievalQuery.id,
          missedPath: project.path,
          confidence: 0,
          notes: "no chunks returned from hybrid retrieval",
        });
      }
      const answer =
        chunks.length === 0
          ? `I could not find enough local context in ${project.name} to answer "${input.question}".`
          : buildAnswer(input.question, project, chunks, citations, confidence);

      agentsRepo.updateRun(retrievalAgentRun.id, {
        status: "completed",
        finishedAt: now(),
        durationMs: Date.parse(now()) - Date.parse(retrievalAgentRun.startedAt),
        output: { chunkCount: chunks.length, confidence, retrievalQueryId: retrievalQuery.id },
      });

      const answerAgentRun = agentsRepo.createRun({
        sessionId: session.id,
        projectId: project.id,
        agent: "answer_agent",
        role: "answer-synthesizer",
        modelRole: "answer",
        risk: "low",
        input: { question: input.question, retrievalQueryId: retrievalQuery.id, contextPackId: contextPack.id },
      });
      const answerProfileId = session.modelProfile ?? selectModelProfile(input.mode ?? "local", { depth: input.depth, question: input.question });
      const answerModelCall = modelsRepo.recordCall({
        sessionId: session.id,
        taskId: answerAgentRun.id,
        retrievalQueryId: retrievalQuery.id,
        profileId: answerProfileId,
        role: "answer",
        promptTokens: Math.ceil((input.question.length + contextPack.usedTokens) / 4),
        completionTokens: Math.ceil(answer.length / 4),
        latencyMs: 0,
        status: "ok",
        request: {
          question: input.question,
          retrievalQueryId: retrievalQuery.id,
          contextPackId: contextPack.id,
          citations: citations.slice(0, 5),
        },
        response: {
          answer,
          confidence,
          citations: citations.slice(0, 5),
          insufficientReason,
        },
      });
      store.appendEvent(createEvent("model.called", { role: "answer", profileId: answerModelCall.profileId }, { sessionId: session.id, projectId: project.id, agent: "answer_agent" }));
      store.appendEvent(createEvent("model.completed", { role: "answer", profileId: answerModelCall.profileId, requestId: answerModelCall.id }, { sessionId: session.id, projectId: project.id, agent: "answer_agent" }));

      const retrievalCompleted = createEvent(
        chunks.length === 0 ? "retrieval.low_confidence" : "retrieval.completed",
        {
          question: input.question,
          chunkCount: chunks.length,
          confidence,
        },
        { sessionId: session.id, projectId: project.id, agent: "retriever" },
      );
      store.appendEvent(retrievalCompleted);

      const summary = createEvent(
        "session.completed",
        {
          summary: answer,
        },
        { sessionId: session.id, projectId: project.id, agent: "orchestrator" },
      );
      store.appendEvent(summary);
      store.updateSession(session.id, {
        status: "completed",
        finishedAt: now(),
        durationMs: 0,
        finalSummary: answer,
        activeTaskId: null,
      });

      conversationRepo.appendMessage({
        sessionId: session.id,
        projectId: project.id,
        role: "assistant",
        agent: "answer_agent",
        content: answer,
        parentMessageId: userMessage.id,
        meta: { confidence, retrievalQueryId: retrievalQuery.id, citationCount: citations.length },
      });
      agentsRepo.updateRun(answerAgentRun.id, {
        status: "completed",
        finishedAt: now(),
        durationMs: Date.parse(now()) - Date.parse(answerAgentRun.startedAt),
        output: { answer, confidence, citations: citations.length, contextPackId: contextPack.id },
      });

      if (chunks.length > 0) {
        store.createLesson({
          projectId: project.id,
          sessionId: session.id,
          title: `Answer: ${input.question.slice(0, 40)}`,
          body: answer,
          tags: ["ask", "retrieval"],
          importance: Math.max(1, Math.round(confidence * 5)),
        });
        store.appendEvent(
          createEvent(
            "lesson.created",
            {
              title: `Answer: ${input.question.slice(0, 40)}`,
              body: answer,
              tags: ["ask", "retrieval"],
              importance: Math.max(1, Math.round(confidence * 5)),
            },
            { sessionId: session.id, projectId: project.id, agent: "learning" },
          ),
        );
      }
      evalRepo.recordAnswerEvaluation({
        sessionId: session.id,
        retrievalQueryId: retrievalQuery.id,
        groundedness: chunks.length > 0 ? confidence : 0,
        citationCoverage: chunks.length > 0 ? Math.min(1, citations.length / 3) : 0,
        contradiction: 0,
        notes: chunks.length === 0 ? "no_chunks" : null,
      });
      evalRepo.recordSessionOutcome({
        sessionId: session.id,
        outcome: chunks.length === 0 ? "failed" : confidence >= 0.5 ? "success" : "partial",
        score: confidence,
        notes: chunks.length === 0 ? "no_chunks" : null,
      });
      enqueueReflectionJob(store, session.id, "ask", project.id);

      return {
        sessionId: session.id,
        projectId: project.id,
        question: input.question,
        answer,
        confidence,
        citations,
        retrievedChunks: chunks,
        insufficientReason,
      };
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
    retrieval: retrievalRepo,
    models: modelsRepo,
    agents: agentsRepo,
    context: contextRepo,
    memory: memoryRepo,
    skills: skillsRepo,
    evals: evalRepo,
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

function detectLanguageFromPath(projectPath: string): string | null {
  const name = basename(projectPath).toLowerCase();
  if (name.includes("python") || name.includes("py")) return "python";
  if (name.includes("web") || name.includes("frontend")) return "typescript";
  return null;
}

function detectFrameworkFromPath(projectPath: string): string | null {
  const name = basename(projectPath).toLowerCase();
  if (name.includes("react")) return "react";
  if (name.includes("next")) return "next.js";
  if (name.includes("expo")) return "expo";
  return null;
}

async function indexProjectFiles(db: DatabaseSync, projectId: string, projectPath: string, qdrantSettings: QdrantRuntimeSettings | null) {
  const files = await walkFiles(projectPath);
  let filesIndexed = 0;
  let chunksIndexed = 0;
  let qdrantFailed = false;
  const ts = now();
  const upsertFile = db.prepare(
    `INSERT INTO files (
      id, project_id, path, language, size_bytes, content_hash, is_indexed, is_generated, last_seen_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, path) DO UPDATE SET
      language = excluded.language,
      size_bytes = excluded.size_bytes,
      content_hash = excluded.content_hash,
      is_indexed = excluded.is_indexed,
      is_generated = excluded.is_generated,
      last_seen_at = excluded.last_seen_at,
      updated_at = excluded.updated_at`,
  );
  const upsertDocument = db.prepare(
    `INSERT INTO rag_documents (
      id, project_id, file_id, path, content_hash, chunk_count, indexed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, path) DO UPDATE SET
      file_id = excluded.file_id,
      content_hash = excluded.content_hash,
      chunk_count = excluded.chunk_count,
      indexed_at = excluded.indexed_at,
      updated_at = excluded.updated_at`,
  );
  const deleteChunks = db.prepare("DELETE FROM rag_chunks WHERE document_id = ?");
  const insertChunk = db.prepare(
    `INSERT INTO rag_chunks (
      id, project_id, document_id, chunk_index, content, content_hash, start_line, end_line, token_count, embedding_id, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const qdrantPoints: QdrantPoint[] = [];

  for (const filePath of files) {
    const absolutePath = resolve(filePath);
    if (!(await isReadableFile(absolutePath))) {
      continue;
    }
    const content = await safeReadText(absolutePath);
    if (content == null || content.length > 256_000 || !isProbablyTextFile(absolutePath)) {
      continue;
    }

    const contentHash = hashContent(content);
    const fileId = createId("file");
    const documentId = createId("doc");
    const relativePath = normalize(relative(projectPath, absolutePath));
    const language = inferLanguage(relativePath);
    const chunks = chunkContent(content);
    const indexedChunks: Array<{ id: string; content: string }> = [];

    upsertFile.run(fileId, projectId, relativePath, language, new TextEncoder().encode(content).length, contentHash, 1, 0, ts, ts, ts);
    upsertDocument.run(documentId, projectId, fileId, relativePath, contentHash, chunks.length, ts, ts, ts);
    deleteChunks.run(documentId);

    chunks.forEach((chunk, index) => {
      const chunkId = createId("chunk");
      const chunkHash = hashContent(`${relativePath}\n${chunk.content}\n${chunk.startLine}\n${chunk.endLine}`);
      insertChunk.run(
        chunkId,
        projectId,
        documentId,
        index,
        chunk.content,
        chunkHash,
        chunk.startLine,
        chunk.endLine,
        chunk.tokenCount,
        null,
        JSON.stringify({ path: relativePath, language }),
        ts,
      );
      indexedChunks.push({ id: chunkId, content: chunk.content });
      if (qdrantSettings) {
        qdrantPoints.push(
          qdrantPointForChunk(
            projectId,
            documentId,
            relativePath,
            {
              id: chunkId,
              content: chunk.content,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              tokenCount: chunk.tokenCount,
            },
            language,
          ),
        );
      }
      chunksIndexed += 1;
    });
    syncSearchIndexForFile(db, projectId, relativePath, indexedChunks);
    filesIndexed += 1;
  }

  if (qdrantSettings && qdrantPoints.length > 0) {
    const upserted = upsertQdrantChunksSync(qdrantSettings, qdrantPoints);
    if (!upserted) {
      qdrantFailed = true;
    }
  }

  db.prepare("UPDATE projects SET status = ?, last_indexed_at = ?, updated_at = ? WHERE id = ?").run("ready", ts, ts, projectId);
  return { filesIndexed, chunksIndexed, qdrantFailed };
}

async function walkFiles(root: string): Promise<string[]> {
  const entries: string[] = [];
  async function visit(current: string): Promise<void> {
    const items = (await readdir(current, { withFileTypes: true })) as Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>;
    for (const item of items) {
      if (item.name.startsWith(".")) {
        if (!DEFAULT_IGNORE_DIRS.has(item.name)) {
          continue;
        }
      }
      if (DEFAULT_IGNORE_DIRS.has(item.name)) {
        continue;
      }
      const nextPath = join(current, item.name);
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) {
        await visit(nextPath);
        continue;
      }
      entries.push(nextPath);
    }
  }
  await visit(root);
  return entries;
}

function inferLanguage(path: string): string | null {
  const extension = extname(path).toLowerCase();
  if (extension === ".ts" || extension === ".tsx" || extension === ".js" || extension === ".jsx") {
    return "typescript";
  }
  if (extension === ".py") return "python";
  if (extension === ".rs") return "rust";
  if (extension === ".go") return "go";
  if (extension === ".java") return "java";
  if (extension === ".sh") return "shell";
  return null;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function createDatabaseBootstrap(dbPath: string) {
  const db = new DatabaseSync(dbPath);
  return { db };
}
