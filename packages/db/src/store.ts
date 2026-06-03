import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { basename, extname, join, normalize, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  ReviewRecord,
  ReviewRequest,
  ReviewResponse,
  SettingsSnapshot,
  ProjectCreateInput,
  ProjectRecord,
  ProjectStatus,
  ProjectSummary,
  RetrievalChunk,
  SessionRecord,
  SessionStatus,
  TaskRecord,
  TaskStatus,
} from "../../shared/src/index.ts";
import { createEvent, createId, slugifyName } from "../../shared/src/index.ts";

type Row = Record<string, unknown>;

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

function rankChunk(question: string, path: string, content: string, startLine: number, endLine: number): number {
  const haystack = `${path}\n${content}`.toLowerCase();
  const terms = question
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((term) => term.length >= 3);
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) {
      score += term.length >= 6 ? 3 : 1;
    }
  }
  const pathParts = path.toLowerCase().split(/[^a-z0-9]+/g).filter(Boolean);
  for (const term of terms) {
    if (pathParts.includes(term)) {
      score += 2;
    }
  }
  if (/auth|login|session|token/i.test(path)) score += 2;
  if (/test|spec/i.test(path)) score += 1;
  if (/readme|docs?|notes?/i.test(path)) score += 1;
  if (terms.some((term) => content.toLowerCase().includes(`${term}(`) || content.toLowerCase().includes(`${term} `))) {
    score += 1;
  }
  score += Math.max(0, 5 - Math.min(5, Math.abs(endLine - startLine) / 40));
  return score;
}

function selectModelProfile(
  mode: AskMode | "index" | "plan" | "handoff" | "check" | "reflect",
  details: { risk?: "low" | "medium" | "high"; depth?: "shallow" | "standard" | "deep"; question?: string; goal?: string } = {},
): string {
  if (mode === "cloud") {
    return "ask-cloud-router";
  }
  if (mode === "hybrid") {
    return "ask-hybrid-router";
  }
  if (mode === "index") {
    return "indexer-local";
  }
  if (mode === "plan") {
    if (details.risk === "high" || details.depth === "deep") return "planner-deep-local";
    if (details.risk === "medium") return "planner-balanced-local";
    return "planner-fast-local";
  }
  if (mode === "handoff") {
    return "handoff-local";
  }
  if (mode === "check") {
    return "checker-local";
  }
  if (mode === "reflect") {
    return "reflector-local";
  }
  if (details.depth === "deep") return "ask-deep-local";
  if (details.question && details.question.length > 120) return "ask-extended-local";
  return "ask-fast-local";
}

function buildFtsQuery(question: string): string | null {
  const terms = Array.from(
    new Set(
      question
        .toLowerCase()
        .split(/[^a-z0-9]+/g)
        .filter((term) => term.length >= 3),
    ),
  );
  if (terms.length === 0) {
    return null;
  }
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
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
  const sql = readFileSync(join(process.cwd(), "packages/db/migrations/0001_init.sql"), "utf8");
  db.exec(sql);
  tryEnableSearchIndex(db);
}

export function initializeStore(dbPath: string): DatabaseSync {
  const db = openStore({ databasePath: dbPath });
  const migrationSql = readFileSync(join(process.cwd(), "packages/db/migrations/0001_init.sql"), "utf8");
  db.exec(migrationSql);
  tryEnableSearchIndex(db);
  return db;
}

export function createStore(db: DatabaseSync) {
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
          if (scored.length > 0) {
            return scored.slice(0, limit);
          }
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
      return scored.slice(0, limit);
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

      const indexSummary = await indexProjectFiles(db, project.id, project.path);
      const completedSession = store.updateSession(session.id, {
        status: "completed",
        finishedAt: now(),
        durationMs: Date.parse(now()) - Date.parse(session.startedAt),
        activeTaskId: null,
        finalSummary: `Indexed ${indexSummary.filesIndexed} files and ${indexSummary.chunksIndexed} chunks.`,
      });
      store.updateTask(task.id, { status: "completed", resultJson: JSON.stringify(indexSummary) });
      store.updateProjectStatus(project.id, "ready", now());

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

      const retrievalStarted = createEvent("retrieval.started", { question: input.question }, { sessionId: session.id, projectId: project.id, agent: "retriever" });
      store.appendEvent(retrievalStarted);

      const chunks = store.searchChunks(project.id, input.question, { limit: input.depth === "deep" ? 12 : input.depth === "shallow" ? 4 : 8 });
      const citations = chunks.map((chunk) => ({
        chunkId: chunk.id,
        path: chunk.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        excerpt: chunk.content.split("\n").slice(0, 4).join("\n"),
        score: chunk.score,
      }));

      const confidence = chunks.length === 0 ? 0 : Math.min(0.95, Math.max(0.25, chunks[0].score / 8));
      const insufficientReason = chunks.length === 0 ? "No matching chunks were found in the selected project." : null;
      const answer =
        chunks.length === 0
          ? `I could not find enough local context in ${project.name} to answer "${input.question}".`
          : buildAnswer(input.question, project, chunks, citations, confidence);

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
    listStatefulSessions(): SessionRecord[] {
      return store.listSessions(100);
    },
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

function buildAnswer(
  question: string,
  project: ProjectSummary,
  chunks: RetrievalChunk[],
  citations: Array<{ path: string; startLine: number; endLine: number; score: number }>,
  confidence: number,
): string {
  const bullets = chunks.slice(0, 3).map((chunk, index) => {
    const excerpt = chunk.content.split("\n").slice(0, 3).join(" ");
    return `${index + 1}. ${chunk.path}:${chunk.startLine}-${chunk.endLine} ${excerpt.slice(0, 160)}`;
  });
  return [
    `I found the most relevant local context in ${project.name} for "${question}".`,
    `Confidence: ${Math.round(confidence * 100)}%.`,
    "",
    ...bullets,
    "",
    "Citations:",
    ...citations.slice(0, 3).map((citation) => `- ${citation.path}:${citation.startLine}-${citation.endLine}`),
  ].join("\n");
}

async function indexProjectFiles(db: DatabaseSync, projectId: string, projectPath: string) {
  const files = await walkFiles(projectPath);
  let filesIndexed = 0;
  let chunksIndexed = 0;
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
      chunksIndexed += 1;
    });
    syncSearchIndexForFile(db, projectId, relativePath, indexedChunks);
    filesIndexed += 1;
  }

  db.prepare("UPDATE projects SET status = ?, last_indexed_at = ?, updated_at = ? WHERE id = ?").run("ready", ts, ts, projectId);
  return { filesIndexed, chunksIndexed };
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
