import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import fastify from "fastify";
import type {
  AskRequest,
  CompiledPromptRecord,
  ConfigSnapshot,
  ContextBudgetEventRecord,
  ContextPackRecord,
  EventEnvelope,
  EvalRunRecord,
  FactRecord,
  HandoffRequest,
  MemoryEntryRecord,
  ModelCallRecord,
  PlanRequest,
  ProjectRuleRecord,
  ProjectSummary,
  RetrievalQueryRecord,
  SessionReplayRequest,
  SessionTimelineResponse,
  SkillRecord,
} from "../../../packages/shared/src/index.ts";
import { createEvent, createId, parseAskRequest, parseProjectCreateInput } from "../../../packages/shared/src/index.ts";
import { resolveConfig, resolveProjectConfig } from "../../../packages/config/src/index.ts";
import { initializeStore, createStore } from "../../../packages/db/src/store.ts";
import type { ProjectContextGraph } from "../../../packages/code-intelligence/src/index.ts";
import { buildSessionTimeline } from "../../../packages/timeline/src/index.ts";
import { createModelRuntime, type ModelCallRecordedHook, type ModelRuntime } from "../../../packages/model-runtime/src/index.ts";
import { runAskWorkflow } from "../../../packages/ask-engine/src/index.ts";
import { runPromptLab } from "../../../packages/prompt-lab-engine/src/index.ts";
import { applyApprovedDevRun, approveDevRun, cancelDevRun, runDevWorkflow } from "../../../packages/dev-agent/src/index.ts";
import { parseDevRequest } from "../../../packages/agent-protocol/src/dev.ts";
import type { ModelProviderRecord, ModelProfileRecord } from "../../../packages/shared/src/index.ts";
import { runExplainWithStore } from "./retrieval-explain.ts";
import {
  renderCard,
  renderEmptyState,
  renderEventFeed,
  renderKeyValueList,
  renderProjectItem,
  renderTaskItem,
  renderSessionItem,
  renderShell,
} from "../../../packages/ui/src/index.ts";

export interface IntelligenceStack {
  runtime: ModelRuntime;
  providers: Pick<ModelProviderRecord, "id" | "kind" | "displayName" | "baseUrl" | "apiKeyEnv" | "enabled">[];
  profiles: ModelProfileRecord[];
}

export interface ServerOptions {
  config?: Partial<ConfigSnapshot>;
  inProcess?: boolean;
  intelligenceStack?: IntelligenceStack;
  store?: ReturnType<typeof createStore>;
}

export interface ServerHandle {
  url: string;
  close(): Promise<void>;
  inject(input: { method: string; url: string; headers?: Record<string, string>; body?: unknown }): Promise<{ statusCode: number; body: string }>;
}

interface JsonResponse {
  status: "ok" | "error";
  data?: unknown;
  error?: { message: string; code?: string };
}

function json(status: "ok" | "error", data?: unknown, error?: { message: string; code?: string }): JsonResponse {
  return status === "ok" ? { status, data } : { status, error };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isHtmlRequest(req: any): boolean {
  const accept = String(req.headers?.accept ?? "");
  return accept.includes("text/html") || (!accept.includes("application/json") && !accept.includes("text/event-stream"));
}

async function readJsonBody(fastifyRequest: any, rawReq: any): Promise<unknown> {
  let body = "";
  if (typeof fastifyRequest?.body === "string" && fastifyRequest.body.length > 0) {
    body = fastifyRequest.body;
  } else if (typeof rawReq?.body === "string" && rawReq.body.length > 0) {
    body = rawReq.body;
  } else {
    for await (const chunk of rawReq) {
      body += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    }
  }
  if (body.trim().length === 0) return {};
  return JSON.parse(body);
}

async function readTextBody(fastifyRequest: any, rawReq: any): Promise<string> {
  if (typeof fastifyRequest?.body === "string" && fastifyRequest.body.length > 0) {
    return fastifyRequest.body;
  }
  if (typeof rawReq?.body === "string" && rawReq.body.length > 0) {
    return rawReq.body;
  }
  let body = "";
  for await (const chunk of rawReq) {
    body += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
  }
  return body;
}

function safeParseList(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function readProjectGraph(store: ReturnType<typeof createStore>, projectId: string): ProjectContextGraph | null {
  try {
    const row = store.db.prepare("SELECT summary_json, updated_at FROM project_context_graphs WHERE project_id = ? LIMIT 1").get(projectId) as { summary_json: string; updated_at: string } | undefined;
    if (!row) return null;
    const parsed = safeParseJson(row.summary_json);
    return typeof parsed === "object" && parsed !== null
      ? { ...(parsed as ProjectContextGraph), updatedAt: row.updated_at }
      : null;
  } catch {
    return null;
  }
}

function buildSessionTraceData(store: ReturnType<typeof createStore>, sessionId: string): Record<string, unknown> {
  const session = store.getSession(sessionId);
  if (!session) {
    return {};
  }
  const projectId = session.projectId;
  const compiledPrompts = store.listCompiledPrompts(sessionId, 100);
  return {
    session,
    messages: store.conversation.listMessages(sessionId, 500),
    events: store.listEvents(sessionId, 500),
    retrievalQueries: store.retrieval.listQueriesForSession(sessionId, 100),
    compiledPrompts,
    modelCalls: store.models.listCalls(sessionId, 100),
    agentRuns: store.agents.listRuns(sessionId, 100),
    agentHandoffs: store.agents.listHandoffs(sessionId, 100),
    contextPacks: store.context.listPacksForSession(sessionId, 100).map((pack) => ({
      pack,
      items: store.context.listItems(pack.id),
      budgetEvents: store.context.listBudgetEvents(pack.id),
    })),
    memoryCandidates: store.memory.listCandidates(undefined, projectId, 100).filter((candidate) => candidate.sessionId === sessionId || candidate.projectId === projectId),
    skills: store.skills.listSkills(undefined, 100),
    evalOutcomes: store.evals.listOutcomes(sessionId, 100),
  };
}

function readCount(store: ReturnType<typeof createStore>, sql: string): { count: number; ok: boolean } {
  try {
    const row = store.db.prepare(sql).get() as { count?: number } | undefined;
    return { count: typeof row?.count === "number" ? row.count : 0, ok: true };
  } catch {
    return { count: 0, ok: false };
  }
}

function buildHealthSnapshot(store: ReturnType<typeof createStore>, config: ConfigSnapshot): Record<string, unknown> {
  const migrationsApplied = readCount(store, "SELECT COUNT(*) AS count FROM schema_migrations");
  const projectCount = readCount(store, "SELECT COUNT(*) AS count FROM projects");
  const sessionCount = readCount(store, "SELECT COUNT(*) AS count FROM agent_sessions");
  const modelProviderCount = readCount(store, "SELECT COUNT(*) AS count FROM model_providers");
  const promptCount = readCount(store, "SELECT COUNT(*) AS count FROM compiled_prompts");
  const databaseReachable = migrationsApplied.ok && projectCount.ok && sessionCount.ok && modelProviderCount.ok && promptCount.ok;
  const qdrant = {
    enabled: config.qdrantEnabled,
    url: config.qdrantUrl,
    collection: config.qdrantCollection,
  };
  // Redact database path for safety
  const redactedDatabasePath = config.databasePath ? `.../${path.basename(config.databasePath)}` : null;
  const redactedRuntimeDir = config.runtimeDir ? `.../${path.basename(config.runtimeDir)}` : null;

  return {
    uptime: process.uptime(),
    databasePath: redactedDatabasePath,
    runtimeDir: redactedRuntimeDir,
    databaseReachable,
    migrations: {
      applied: migrationsApplied.count,
    },
    projectCount: projectCount.count,
    sessionCount: sessionCount.count,
    qdrant,
    cloudEnabled: config.cloudEnabled,
    modelProviderCount: modelProviderCount.count,
    promptCount: promptCount.count,
  };
}

function buildRuntimeForStore(store: ReturnType<typeof createStore>, cloudEnabled: boolean): ModelRuntime {
  return createModelRuntime({
    providers: store.models.listProviders(),
    profiles: store.models.listProfiles(),
    cloudEnabled,
    recordCall: store.models.recordCall,
  });
}

function sendJson(res: any, payload: JsonResponse, statusCode = 200): void {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    connection: "close",
  });
  res.end(JSON.stringify(payload));
}

function sendHtml(res: any, html: string, statusCode = 200): void {
  res.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    connection: "close",
  });
  res.end(html);
}

function sendText(res: any, body: string, statusCode = 200): void {
  res.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    connection: "close",
  });
  res.end(body);
}

function redirect(res: any, location: string): void {
  res.writeHead(303, { location, connection: "close" });
  res.end();
}

function pageShell(
  title: string,
  route: string,
  options: {
    contentHtml: string;
    rightPanelHtml?: string;
    activeProjectId?: string | null;
    projectCount?: number;
    sessionCount?: number;
    activeSessionCount?: number;
    projects?: ProjectSummary[];
    liveStatus?: string;
  },
): string {
  return renderShell({
    title,
    route,
    activeProjectId: options.activeProjectId ?? null,
    contentHtml: options.contentHtml,
    rightPanelHtml: options.rightPanelHtml,
    projects: options.projects,
    sessionCount: options.sessionCount ?? 0,
    activeSessionCount: options.activeSessionCount ?? 0,
    liveStatus: options.liveStatus ?? "live",
  });
}

function renderDashboard(store: ReturnType<typeof createStore>, route = "/dashboard"): string {
  const dashboard = store.dashboardSnapshot();
  const projects = store.listProjects();
  const events = store.listEvents(undefined, 40);
  const contentHtml = [
    renderCard(
      "Projects",
      `<div class="kpi"><div class="value">${dashboard.projects}</div><div class="label">Indexed projects in the local store</div></div>`,
      4,
    ),
    renderCard(
      "Active Sessions",
      `<div class="kpi"><div class="value">${dashboard.activeSessions}</div><div class="label">Running, queued, or paused</div></div>`,
      4,
    ),
    renderCard(
      "Recent Lessons",
      `<div class="kpi"><div class="value">${dashboard.recentLessons.length}</div><div class="label">Captured memory entries</div></div>`,
      4,
    ),
    renderCard(
      "Projects",
      `<div class="list">${projects.length > 0 ? projects.map(renderProjectItem).join("") : renderEmptyState("No projects yet", "Add a repo to begin indexing.")}</div>`,
      8,
    ),
    renderCard(
      "Recent Sessions",
      `<div class="list">${dashboard.recentSessions.length > 0 ? dashboard.recentSessions.map(renderSessionItem).join("") : renderEmptyState("No sessions yet", "Ask a question or index a repo to create one.")}</div>`,
      4,
    ),
    renderCard(
      "Recent Lessons",
      `<div class="list">${dashboard.recentLessons.length > 0
        ? dashboard.recentLessons.map((lesson) => `<div class="list-item"><strong>${escapeHtml(lesson.title)}</strong><div class="tiny">${escapeHtml(lesson.body)}</div></div>`).join("")
        : renderEmptyState("No lessons yet", "Answers and indexing runs will populate memory.")}</div>`,
      6,
    ),
    renderCard(
      "Checks",
      `<div class="list">${dashboard.recentChecks.length > 0
        ? dashboard.recentChecks.map((check) => `<div class="list-item"><strong>${escapeHtml(check.name)}</strong><div class="tiny">${escapeHtml(check.status)}</div></div>`).join("")
        : renderEmptyState("No checks yet", "Allowlisted checks will show up here.")}</div>`,
      6,
    ),
  ].join("");

  const rightPanelHtml = renderCard("Event Stream", renderEventFeed(events));
  return pageShell("Dashboard", route, {
    contentHtml,
    rightPanelHtml,
    projects,
    projectCount: dashboard.projects,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: dashboard.activeSessions,
    liveStatus: "healthy",
  });
}

function renderProjectsPage(store: ReturnType<typeof createStore>): string {
  const projects = store.listProjects();
  const contentHtml = [
    renderCard(
      "Projects",
      `<div class="stack">${projects.length > 0 ? projects.map(renderProjectItem).join("") : renderEmptyState("No projects yet", "Use the CLI to add a repo path.")}</div>`,
      8,
    ),
    renderCard(
      "Add Project",
      `<form method="post" action="/projects" class="stack">
        <input name="path" placeholder="/home/namik/Documents/code/noxcrm" />
        <input name="name" placeholder="optional display name" />
        <button type="submit">Add project</button>
      </form>`,
      4,
    ),
  ].join("");
  return pageShell("Projects", "/projects", {
    contentHtml,
    rightPanelHtml: renderCard("Quick Tips", `<div class="tiny">Project indexing scans text files, stores chunks, and immediately emits a session trace.</div>`),
    projects,
    projectCount: projects.length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: "ready",
  });
}

function renderProjectDetailPage(store: ReturnType<typeof createStore>, projectId: string): string {
  const project = store.getProject(projectId);
  if (!project) {
    return pageShell("Project not found", `/projects/${projectId}`, {
      contentHtml: renderCard("Missing project", `No project found for <code>${escapeHtml(projectId)}</code>.`),
      projects: store.listProjects(),
      projectCount: store.listProjects().length,
      sessionCount: store.listSessions(1000).length,
      activeSessionCount: store.dashboardSnapshot().activeSessions,
      liveStatus: "missing",
    });
  }

  const files = store.listProjectFiles(project.id, 20);
  const chunks = store.listProjectChunks(project.id, 10);
  const sessions = store.listProjectSessions(project.id, 8);
  const lessons = store.listProjectLessons(project.id, 8);
  const graph = readProjectGraph(store, project.id);
  const symbols = store.codeIntelligence.listSymbols(project.id, null, 10);
  const symbolCount = { count: store.codeIntelligence.countSymbols(project.id) };

  const contentHtml = [
    renderCard(
      "Project Summary",
      renderKeyValueList([
        ["Path", project.path],
        ["Language", project.language ?? "unknown"],
        ["Framework", project.framework ?? "unknown"],
        ["Status", project.status],
        ["Files", String(project.fileCount)],
        ["Chunks", String(project.chunkCount)],
        ["Symbols", String(symbolCount.count)],
      ]),
      6,
    ),
    renderCard(
      "Context Graph",
      graph
        ? renderKeyValueList([
            ["Entrypoints", String(graph.entrypoints.length)],
            ["Routes", graph.routeFiles.slice(0, 3).join(", ")],
            ["Middleware", graph.middlewareFiles.slice(0, 3).join(", ")],
            ["DB/Auth", [...graph.dbFiles, ...graph.authPaths].slice(0, 3).join(", ")],
          ])
        : renderEmptyState("No graph yet", "Context graph is built during indexing."),
      6,
    ),
    renderCard(
      "Top Symbols",
      `<div class="list">${symbols.length > 0 ? symbols.map((s) => `<div class="list-item"><strong>${escapeHtml(s.name)}</strong><div class="tiny">${escapeHtml(s.kind)} · ${escapeHtml(s.path)}</div></div>`).join("") : renderEmptyState("No symbols", "Symbols are extracted during indexing.")}</div><div class="tiny" style="margin-top:8px"><a href="/projects/${encodeURIComponent(project.id)}/symbols">View all symbols</a></div>`,
      6,
    ),
    renderCard(
      "Files",
      `<div class="list">${files.length > 0 ? files.map((file) => `<div class="list-item"><div class="row"><strong>${escapeHtml(file.path)}</strong><span class="badge">${file.isIndexed ? "indexed" : "pending"}</span></div><div class="tiny">${escapeHtml(file.language ?? "unknown")} · ${file.sizeBytes} bytes</div></div>`).join("") : renderEmptyState("No files yet", "Index the project to populate file metadata.")}</div>`,
      6,
    ),
    renderCard(
      "Chunks",
      `<div class="list">${chunks.length > 0 ? chunks.map((chunk) => `<div class="list-item"><strong>${escapeHtml(chunk.path)}</strong><div class="tiny">Lines ${chunk.startLine}-${chunk.endLine} · score ${chunk.score.toFixed(1)}</div><pre>${escapeHtml(chunk.content.slice(0, 280))}</pre></div>`).join("") : renderEmptyState("No chunks yet", "Retrieval data appears after indexing.")}</div>`,
      6,
    ),
    renderCard(
      "Sessions",
      `<div class="list">${sessions.length > 0 ? sessions.map(renderSessionItem).join("") : renderEmptyState("No sessions yet", "Index or ask against this project to create traces.")}</div>`,
      6,
    ),
    renderCard(
      "Lessons",
      `<div class="list">${lessons.length > 0 ? lessons.map((lesson) => `<div class="list-item"><strong>${escapeHtml(lesson.title)}</strong><div class="tiny">${escapeHtml(lesson.body)}</div></div>`).join("") : renderEmptyState("No lessons yet", "Answer synthesis adds memory entries here.")}</div>`,
      12,
    ),
  ].join("");

  return pageShell(project.name, `/projects/${project.id}`, {
    contentHtml,
    rightPanelHtml: renderCard("Recent Trace", renderEventFeed(store.listEvents(undefined, 40))),
    activeProjectId: project.id,
    projects: store.listProjects(),
    projectCount: store.listProjects().length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: project.status,
  });
}

function renderSessionsPage(store: ReturnType<typeof createStore>): string {
  const sessions = store.listSessions(100);
  const contentHtml = renderCard(
    "Sessions",
    `<div class="list">${sessions.length > 0 ? sessions.map(renderSessionItem).join("") : renderEmptyState("No sessions", "Ask a question or index a project to create one.")}</div>`,
    8,
  );
  return pageShell("Sessions", "/sessions", {
    contentHtml,
    rightPanelHtml: renderCard("Recent Events", renderEventFeed(store.listEvents(undefined, 40))),
    projects: store.listProjects(),
    projectCount: store.listProjects().length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: "streaming",
  });
}

function renderSessionDetailPage(store: ReturnType<typeof createStore>, sessionId: string): string {
  const session = store.getSession(sessionId);
  if (!session) {
    return pageShell("Session not found", `/sessions/${sessionId}`, {
      contentHtml: renderCard("Missing session", `No session found for <code>${escapeHtml(sessionId)}</code>.`),
      projects: store.listProjects(),
      projectCount: store.listProjects().length,
      sessionCount: store.listSessions(1000).length,
      activeSessionCount: store.dashboardSnapshot().activeSessions,
      liveStatus: "missing",
    });
  }

  const events = store.listEvents(session.id, 100);
  const tasks = store.listTasks(session.id, 20);
  const timeline = buildSessionTimeline({
    session,
    messages: store.conversation.listMessages(session.id, 100),
    events,
    agentRuns: store.agents.listRuns(session.id, 50),
    modelCalls: store.models.listCalls(session.id, 50),
    compiledPrompts: store.listCompiledPrompts(session.id, 50),
    retrievalQueries: store.retrieval.listQueriesForSession(session.id, 50),
    contextPacks: store.context.listPacksForSession(session.id, 20),
    outcomes: store.evals.listOutcomes(session.id, 20),
  });

  const contentHtml = [
    renderCard(
      "Session Summary",
      renderKeyValueList([
        ["Title", session.title],
        ["Goal", session.userGoal],
        ["Status", session.status],
        ["Mode", session.mode],
        ["Source", session.source],
        ["Started", session.startedAt],
        ["Finished", session.finishedAt ?? "running"],
        ["Model Calls", String(timeline.counts.modelCalls)],
        ["Retrivals", String(timeline.counts.retrievalQueries)],
      ]),
      6,
    ),
    renderCard(
      "Final Summary",
      `<pre>${escapeHtml(session.finalSummary ?? "No final summary yet.")}</pre>`,
      6,
    ),
    renderCard(
      "Timeline",
      `<div class="list">${timeline.items.length > 0 ? timeline.items.map((item) => `<div class="list-item"><strong>${escapeHtml(item.kind)}: ${escapeHtml(item.title)}</strong><div class="tiny">${escapeHtml(item.summary)}</div></div>`).join("") : renderEmptyState("Empty timeline", "No events captured for this session yet.")}</div>`,
      12,
    ),
    renderCard(
      "Tasks",
      `<div class="list">${tasks.length > 0 ? tasks.map((task) => `<a href="/tasks/${encodeURIComponent(task.id)}" style="display:block">${renderTaskItem(task)}</a>`).join("") : renderEmptyState("No tasks yet", "Plans and worker jobs create task records here.")}</div>`,
      12,
    ),
    renderCard("Event Timeline", renderEventFeed(events), 12),
  ].join("");

  return pageShell(session.title, `/sessions/${session.id}`, {
    contentHtml,
    rightPanelHtml: renderCard("Session Events", renderEventFeed(events)),
    projects: store.listProjects(),
    projectCount: store.listProjects().length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: session.status,
  });
}

function renderCompiledPromptItem(prompt: CompiledPromptRecord): string {
  return `<div class="list-item">
    <div class="row"><strong>${escapeHtml(prompt.mode)}</strong><span class="badge">${escapeHtml(prompt.role)}</span></div>
    <div class="tiny">${escapeHtml(prompt.id)}${prompt.sessionId ? ` · session ${escapeHtml(prompt.sessionId)}` : ""}</div>
    <div class="tiny">${escapeHtml(String(prompt.estimatedTokens))} tokens · ${escapeHtml(prompt.createdAt)}</div>
  </div>`;
}

function renderCompiledPromptPage(store: ReturnType<typeof createStore>, promptId: string): string {
  const prompt = store.getCompiledPrompt(promptId);
  if (!prompt) {
    return pageShell("Prompt not found", `/prompts/${promptId}`, {
      contentHtml: renderCard("Missing prompt", `No compiled prompt found for <code>${escapeHtml(promptId)}</code>.`),
      projects: store.listProjects(),
      projectCount: store.listProjects().length,
      sessionCount: store.listSessions(1000).length,
      activeSessionCount: store.dashboardSnapshot().activeSessions,
      liveStatus: "missing",
    });
  }

  const messages = safeParseJson(prompt.messagesJson);
  const includedContext = safeParseJson(prompt.includedContextJson);
  const omittedContext = safeParseJson(prompt.omittedContextJson);
  const safetyNotes = safeParseJson(prompt.safetyNotesJson);
  const outputSchema = prompt.outputSchemaJson ? safeParseJson(prompt.outputSchemaJson) : null;
  const contentHtml = [
    renderCard(
      "Prompt Summary",
      renderKeyValueList([
        ["Mode", prompt.mode],
        ["Role", prompt.role],
        ["Tokens", String(prompt.estimatedTokens)],
        ["Session", prompt.sessionId ?? "none"],
        ["Task", prompt.taskId ?? "none"],
        ["Retrieval Query", prompt.retrievalQueryId ?? "none"],
        ["Context Pack", prompt.contextPackId ?? "none"],
        ["Created", prompt.createdAt],
      ]),
      6,
    ),
    renderCard("Messages", `<pre>${escapeHtml(JSON.stringify(messages, null, 2))}</pre>`, 6),
    renderCard("Included Context", `<pre>${escapeHtml(JSON.stringify(includedContext, null, 2))}</pre>`, 6),
    renderCard("Omitted Context", `<pre>${escapeHtml(JSON.stringify(omittedContext, null, 2))}</pre>`, 6),
    renderCard("Safety Notes", `<pre>${escapeHtml(JSON.stringify(safetyNotes, null, 2))}</pre>`, 6),
    renderCard("Output Schema", `<pre>${escapeHtml(JSON.stringify(outputSchema, null, 2))}</pre>`, 6),
  ].join("");

  return pageShell(`Prompt ${prompt.id}`, `/prompts/${prompt.id}`, {
    contentHtml,
    rightPanelHtml: renderCard("Prompt Trace", `<div class="stack">${renderCompiledPromptItem(prompt)}</div>`),
    projects: store.listProjects(),
    projectCount: store.listProjects().length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: "ready",
  });
}

function renderPromptsPage(store: ReturnType<typeof createStore>, sessionId?: string | null): string {
  const prompts = store.listCompiledPrompts(sessionId ?? null, 100);
  const contentHtml = [
    renderCard(
      "Compiled Prompts",
      `<div class="list">${prompts.length > 0 ? prompts.map((prompt) => `<a href="/prompts/${encodeURIComponent(prompt.id)}" style="display:block">${renderCompiledPromptItem(prompt)}</a>`).join("") : renderEmptyState("No prompts yet", "Ask a question or run a plan to create compiled prompts.")}</div>`,
      12,
    ),
  ].join("");
  return pageShell("Prompts", `/prompts${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`, {
    contentHtml,
    rightPanelHtml: renderCard("Prompt Filter", renderKeyValueList([["Session", sessionId ?? "all"], ["Count", String(prompts.length)]])),
    projects: store.listProjects(),
    projectCount: store.listProjects().length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: "ready",
  });
}

function renderTasksPage(store: ReturnType<typeof createStore>): string {
  const tasks = store.listRecentTasks(40);
  const byStatus = tasks.reduce<Record<string, number>>((acc, task) => {
    acc[task.status] = (acc[task.status] ?? 0) + 1;
    return acc;
  }, {});
  const contentHtml = [
    renderCard(
      "Recent Tasks",
      `<div class="list">${tasks.length > 0 ? tasks.map((task) => `<a href="/tasks/${encodeURIComponent(task.id)}" style="display:block">${renderTaskItem(task)}</a>`).join("") : renderEmptyState("No tasks yet", "Plans and worker jobs will appear here.")}</div>`,
      8,
    ),
    renderCard(
      "Task Summary",
      renderKeyValueList([
        ["Queued", String(byStatus.queued ?? 0)],
        ["Running", String(byStatus.running ?? 0)],
        ["Completed", String(byStatus.completed ?? 0)],
        ["Failed", String(byStatus.failed ?? 0)],
      ]),
      4,
    ),
  ].join("");
  return pageShell("Tasks", "/tasks", {
    contentHtml,
    rightPanelHtml: renderCard("Recent Trace", renderEventFeed(store.listEvents(undefined, 40))),
    projects: store.listProjects(),
    projectCount: store.listProjects().length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: "ready",
  });
}

function renderTaskDetailPage(store: ReturnType<typeof createStore>, taskId: string): string {
  const task = store.getTask(taskId);
  if (!task) {
    return pageShell("Task not found", `/tasks/${taskId}`, {
      contentHtml: renderCard("Missing task", `No task found for <code>${escapeHtml(taskId)}</code>.`),
      projects: store.listProjects(),
      projectCount: store.listProjects().length,
      sessionCount: store.listSessions(1000).length,
      activeSessionCount: store.dashboardSnapshot().activeSessions,
      liveStatus: "missing",
    });
  }

  const session = store.getSession(task.sessionId);
  const project = session?.projectId ? store.getProject(session.projectId) : null;
  const events = store.listEvents(task.sessionId, 100).filter((event) => event.taskId === task.id || event.taskId == null);
  const expectedFiles = safeParseList(task.expectedFilesJson);
  const actualFiles = safeParseList(task.actualFilesJson);
  const checks = safeParseList(task.checksJson);
  const result = task.resultJson.trim() && task.resultJson.trim() !== "{}" ? task.resultJson : "No result recorded yet.";

  const contentHtml = [
    renderCard(
      "Task Summary",
      renderKeyValueList([
        ["Title", task.title],
        ["Description", task.description],
        ["Type", task.type],
        ["Status", task.status],
        ["Risk", task.risk],
        ["Priority", String(task.priority)],
        ["Session", session ? session.title : task.sessionId],
        ["Project", project ? project.name : "unknown"],
      ]),
      6,
    ),
    renderCard(
      "Actions",
      `<div class="stack">
        <form method="post" action="/tasks/${encodeURIComponent(task.id)}/start"><button type="submit">Start task</button></form>
        <form method="post" action="/tasks/${encodeURIComponent(task.id)}/complete" class="stack">
          <textarea name="result" placeholder="completion notes"></textarea>
          <button type="submit">Complete task</button>
        </form>
        <form method="post" action="/tasks/${encodeURIComponent(task.id)}/fail" class="stack">
          <textarea name="error" placeholder="failure notes"></textarea>
          <button type="submit">Fail task</button>
        </form>
      </div>`,
      6,
    ),
    renderCard("Expected Files", expectedFiles.length > 0 ? `<div class="list">${expectedFiles.map((file) => `<div class="list-item">${escapeHtml(file)}</div>`).join("")}</div>` : renderEmptyState("No expected files", "Planner-created tasks will list files here."), 4),
    renderCard("Actual Files", actualFiles.length > 0 ? `<div class="list">${actualFiles.map((file) => `<div class="list-item">${escapeHtml(file)}</div>`).join("")}</div>` : renderEmptyState("No actual files", "Update the task after edits land."), 4),
    renderCard("Checks", checks.length > 0 ? `<div class="list">${checks.map((check) => `<div class="list-item">${escapeHtml(check)}</div>`).join("")}</div>` : renderEmptyState("No checks", "Checks will be attached to the task graph."), 4),
    renderCard("Result", `<pre>${escapeHtml(result)}</pre>`, 12),
    renderCard("Event Timeline", renderEventFeed(events), 12),
  ].join("");

  return pageShell(task.title, `/tasks/${task.id}`, {
    contentHtml,
    rightPanelHtml: renderCard("Task Events", renderEventFeed(events)),
    activeProjectId: project?.id ?? null,
    projects: store.listProjects(),
    projectCount: store.listProjects().length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: task.status,
  });
}

function renderAskPage(
  store: ReturnType<typeof createStore>,
  options: { result?: Awaited<ReturnType<ReturnType<typeof createStore>["ask"]>>; error?: string; question?: string } = {},
): string {
  const projects = store.listProjects();
  const selectOptions = projects
    .map((project) => `<option value="${escapeHtml(project.id)}"${options.result?.projectId === project.id ? " selected" : ""}>${escapeHtml(project.name)}</option>`)
    .join("");
  const contentHtml = [
    renderCard(
      "Ask a Question",
      `<form method="post" action="/ask" class="stack">
        <select name="project">${selectOptions || `<option value="">Add a project first</option>`}</select>
        <textarea name="question" placeholder="where is auth handled?">${escapeHtml(options.question ?? "")}</textarea>
        <select name="depth">
          <option value="standard">Standard depth</option>
          <option value="shallow">Shallow</option>
          <option value="deep">Deep</option>
        </select>
        <button type="submit">Ask</button>
      </form>`,
      6,
    ),
    renderCard(
      "Answer",
      options.result
        ? `<div class="list-item"><div class="badge" data-tone="${options.result.confidence > 0.65 ? "good" : options.result.confidence > 0.35 ? "warn" : "bad"}">confidence ${Math.round(options.result.confidence * 100)}%</div><pre>${escapeHtml(options.result.answer)}</pre></div>`
        : renderEmptyState("No answer yet", options.error ?? "Submit a question to see retrieved context and citations."),
      6,
    ),
    renderCard(
      "Citations",
      options.result && options.result.citations.length > 0
        ? `<div class="list">${options.result.citations
            .map(
              (citation) => `<div class="list-item"><strong>${escapeHtml(citation.path)}</strong><div class="tiny">Lines ${citation.startLine}-${citation.endLine} · score ${citation.score.toFixed(1)}</div><pre>${escapeHtml(citation.excerpt)}</pre></div>`,
            )
            .join("")}</div>`
        : renderEmptyState("No citations", "If retrieval misses, the response will say so explicitly."),
      12,
    ),
  ].join("");

  return pageShell("Ask", "/ask", {
    contentHtml,
    rightPanelHtml: renderCard("Recent Trace", renderEventFeed(store.listEvents(undefined, 40))),
    projects,
    projectCount: projects.length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: options.result ? "answered" : "ready",
  });
}

function renderResearchPage(
  store: ReturnType<typeof createStore>,
  options: { projectId?: string; topic?: string; mode?: string; result?: { summary: string; sources: Array<{ path: string; score: number; excerpt: string }>; contradictions: string[]; brief: string } } = {},
): string {
  const projects = store.listProjects();
  const projectOptions = projects
    .map((project) => `<option value="${escapeHtml(project.id)}"${options.projectId === project.id ? " selected" : ""}>${escapeHtml(project.name)}</option>`)
    .join("");
  const contentHtml = [
    renderCard(
      "Research Topic",
      `<form method="post" action="/research" class="stack">
        <select name="project">${projectOptions || `<option value="">Add a project first</option>`}</select>
        <input name="topic" placeholder="authentication architecture" value="${escapeHtml(options.topic ?? "")}" />
        <select name="mode">
          <option value="local">Local only</option>
          <option value="hybrid">Hybrid</option>
          <option value="web">Web</option>
        </select>
        <button type="submit">Research</button>
      </form>`,
      6,
    ),
    renderCard(
      "Summary",
      options.result ? `<pre>${escapeHtml(options.result.summary)}</pre>` : renderEmptyState("No research yet", "Run a topic search to gather a brief."),
      6,
    ),
    renderCard(
      "Sources",
      options.result
        ? `<div class="list">${options.result.sources.length > 0 ? options.result.sources.map((source) => `<div class="list-item"><strong>${escapeHtml(source.path)}</strong><div class="tiny">score ${source.score.toFixed(1)}</div><pre>${escapeHtml(source.excerpt)}</pre></div>`).join("") : renderEmptyState("No sources", "Research will list supporting chunks.")}</div>`
        : renderEmptyState("No sources", "Research sources appear here."),
      6,
    ),
    renderCard(
      "Brief",
      options.result ? `<pre>${escapeHtml(options.result.brief)}</pre>` : renderEmptyState("No brief yet", "The final brief will be suitable for handoff."),
      6,
    ),
  ].join("");
  return pageShell("Research", "/research", {
    contentHtml,
    rightPanelHtml: renderCard("Recent Trace", renderEventFeed(store.listEvents(undefined, 40))),
    projects,
    projectCount: projects.length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: options.result ? "analyzed" : "ready",
  });
}

function renderPlannerPage(
  store: ReturnType<typeof createStore>,
  options: { result?: Awaited<ReturnType<ReturnType<typeof createStore>["createPlan"]>>["response"]; error?: string } = {},
): string {
  const projects = store.listProjects();
  const projectOptions = projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join("");
  const contentHtml = [
    renderCard(
      "Generate Plan",
      `<form method="post" action="/plan" class="stack">
        <select name="project">${projectOptions || `<option value="">Add a project first</option>`}</select>
        <textarea name="goal" placeholder="Refactor auth flow without breaking login">${escapeHtml(options.result?.goal ?? "")}</textarea>
        <select name="risk">
          <option value="medium">Medium</option>
          <option value="low">Low</option>
          <option value="high">High</option>
        </select>
        <button type="submit">Generate plan</button>
      </form>`,
      6,
    ),
    renderCard(
      "Plan Summary",
      options.result
        ? renderKeyValueList([
            ["Risk", options.result.risk],
            ["Model", options.result.modelRecommendation],
            ["Depth", options.result.researchDepth],
            ["Checks", options.result.checks.join(", ")],
          ])
        : renderEmptyState("No plan yet", options.error ?? "Generate a task graph for a project goal."),
      6,
    ),
    renderCard(
      "Task Graph",
      options.result
        ? `<div class="list">${options.result.taskGraph
            .map(
              (task) => `<div class="list-item"><div class="row"><strong>${escapeHtml(task.title)}</strong><span class="badge">${escapeHtml(task.status)}</span></div><div class="tiny">${escapeHtml(task.description)}</div><div class="tiny">Checks: ${escapeHtml(task.checks.join(", "))}</div><div class="tiny">Files: ${escapeHtml(task.expectedFiles.join(", ") || "none")}</div></div>`,
            )
            .join("")}</div>`
        : renderEmptyState("No task graph", "The plan will appear here after generation."),
      12,
    ),
    renderCard(
      "Likely Files",
      options.result
        ? `<div class="list">${options.result.likelyFiles.length > 0 ? options.result.likelyFiles.map((file) => `<div class="list-item">${escapeHtml(file)}</div>`).join("") : renderEmptyState("No files", "The planner did not identify any files yet.")}</div>`
        : renderEmptyState("No files", "Plan output will list likely files."),
      6,
    ),
    renderCard(
      "Session",
      options.result
        ? renderKeyValueList([
            ["Session", options.result.sessionId],
            ["Project", options.result.projectId],
            ["Goal", options.result.goal],
          ])
        : renderEmptyState("No session", "Each generated plan creates a traceable session."),
      6,
    ),
  ].join("");
  return pageShell("Planner", "/planner", {
    contentHtml,
    rightPanelHtml: renderCard("Recent Trace", renderEventFeed(store.listEvents(undefined, 40))),
    projects,
    projectCount: projects.length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: options.result ? "planned" : "ready",
  });
}

function renderHandoffPage(
  store: ReturnType<typeof createStore>,
  options: { result?: Awaited<ReturnType<ReturnType<typeof createStore>["createHandoff"]>>; error?: string } = {},
): string {
  const projects = store.listProjects();
  const sessions = store.listSessions(50);
  const projectOptions = projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join("");
  const sessionOptions = sessions.map((session) => `<option value="${escapeHtml(session.id)}">${escapeHtml(session.title)}</option>`).join("");
  const contentHtml = [
    renderCard(
      "Create Handoff",
      `<form method="post" action="/handoff" class="stack">
        <select name="sessionId">${sessionOptions || `<option value="">Run a session first</option>`}</select>
        <select name="project">${projectOptions || `<option value="">Add a project first</option>`}</select>
        <select name="target">
          <option value="opencode">OpenCode</option>
          <option value="codex">Codex</option>
          <option value="manual">Manual</option>
          <option value="clipboard">Clipboard</option>
          <option value="file">File</option>
        </select>
        <textarea name="subtask" placeholder="Implement the next smallest change">${escapeHtml(options.result?.prompt ?? "")}</textarea>
        <button type="submit">Generate handoff</button>
      </form>`,
      6,
    ),
    renderCard(
      "Prompt",
      options.result ? `<pre>${escapeHtml(options.result.prompt)}</pre>` : renderEmptyState("No handoff yet", options.error ?? "Generate a target-specific prompt from a live session."),
      6,
    ),
    renderCard(
      "Selected Context",
      options.result
        ? renderKeyValueList([
            ["Files to inspect", options.result.selectedContext.filesToInspect.join(", ") || "none"],
            ["Files likely to edit", options.result.selectedContext.filesLikelyToEdit.join(", ") || "none"],
            ["Checks to run", options.result.selectedContext.checksToRun.join(", ")],
            ["Constraints", options.result.selectedContext.constraints.join(" | ")],
          ])
        : renderEmptyState("No context", "The handoff will include files, checks, and constraints."),
      12,
    ),
  ].join("");
  return pageShell("Handoff", "/handoff", {
    contentHtml,
    rightPanelHtml: renderCard("Recent Trace", renderEventFeed(store.listEvents(undefined, 40))),
    projects,
    projectCount: projects.length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: options.result ? "ready" : "ready",
  });
}

function renderChecksPage(store: ReturnType<typeof createStore>): string {
  const checks = store.listCheckRuns(20);
  const projects = store.listProjects();
  const contentHtml = [
    renderCard(
      "Allowed Checks",
      `<div class="list">${["typecheck", "tests", "build", "lint"]
        .map((name) => `<div class="list-item"><strong>${name}</strong><div class="tiny">Allowlisted validation check</div></div>`)
        .join("")}</div>`,
      4,
    ),
    renderCard(
      "Recent Runs",
      `<div class="list">${checks.length > 0 ? checks.map((check) => `<div class="list-item"><div class="row"><strong>${escapeHtml(check.name)}</strong><span class="badge" data-tone="${check.status === "completed" ? "good" : check.status === "failed" ? "bad" : "warn"}">${escapeHtml(check.status)}</span></div><div class="tiny">${escapeHtml(check.command ?? "no command")}</div><div class="tiny">${escapeHtml(check.output ?? check.errorOutput ?? "no output")}</div></div>`).join("") : renderEmptyState("No checks yet", "Run an allowlisted check to create durable history.")}</div>`,
      8,
    ),
    renderCard(
      "Run Check",
      `<form method="post" action="/checks/run" class="stack">
        <input name="name" placeholder="typecheck" />
        <input name="projectId" placeholder="optional project id" />
        <button type="submit">Record check run</button>
      </form>`,
      4,
    ),
  ].join("");
  return pageShell("Checks", "/checks", {
    contentHtml,
    rightPanelHtml: renderCard("Recent Events", renderEventFeed(store.listEvents(undefined, 40))),
    projects,
    projectCount: projects.length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: "ready",
  });
}

function renderMemoryPage(store: ReturnType<typeof createStore>): string {
  const projects = store.listProjects();
  const contentHtml = projects
    .map((project) => {
      const lessons = store.listProjectLessons(project.id, 5);
      const rules = store.listProjectRules(project.id, 5);
      const memory = store.listProjectMemory(project.id, 5);
      return renderCard(
        `${project.name} Memory`,
        [
          `<div class="list">${rules.length > 0 ? rules.map((rule) => `<div class="list-item"><strong>${escapeHtml(rule.title)}</strong><div class="tiny">${escapeHtml(rule.body)}</div></div>`).join("") : renderEmptyState("No rules", "Pin project rules here.")}</div>`,
          `<div class="list">${memory.length > 0 ? memory.map((entry) => `<div class="list-item"><strong>${escapeHtml(entry.title)}</strong><div class="tiny">${escapeHtml(entry.body)}</div></div>`).join("") : renderEmptyState("No memory", "Lessons and retrieved patterns will show up here.")}</div>`,
          `<div class="list">${lessons.length > 0 ? lessons.map((lesson) => `<div class="list-item"><strong>${escapeHtml(lesson.title)}</strong><div class="tiny">${escapeHtml(lesson.body)}</div></div>`).join("") : renderEmptyState("No lessons", "Ask or index the project to create lessons.")}</div>`,
        ].join(""),
        12,
      );
    })
    .join("");
  return pageShell("Memory", "/memory", {
    contentHtml: contentHtml || renderCard("Memory", "No projects yet.", 12),
    rightPanelHtml: renderCard("Recent Trace", renderEventFeed(store.listEvents(undefined, 40))),
    projects,
    projectCount: projects.length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: "ready",
  });
}

function renderReviewsPage(
  store: ReturnType<typeof createStore>,
  options: { result?: ReturnType<ReturnType<typeof createStore>["createReview"]>; error?: string } = {},
): string {
  const projects = store.listProjects();
  const projectOptions = projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join("");
  const reviews = store.listReviews(undefined, 20);
  const contentHtml = [
    renderCard(
      "Create Review",
      `<form method="post" action="/reviews" class="stack">
        <select name="project">${projectOptions || `<option value="">Add a project first</option>`}</select>
        <input name="sessionId" placeholder="optional session id" />
        <input name="title" placeholder="review title" />
        <input name="plannedFiles" placeholder="planned/file1.ts, planned/file2.ts" />
        <input name="editedFiles" placeholder="edited/file1.ts, edited/file2.ts" />
        <input name="checks" placeholder="typecheck, tests" />
        <textarea name="notes" placeholder="review notes"></textarea>
        <button type="submit">Create review</button>
      </form>`,
      6,
    ),
    renderCard(
      "Latest Review",
      options.result
        ? `<div class="list-item"><strong>${escapeHtml(options.result.title)}</strong><div class="tiny">${escapeHtml(options.result.summary)}</div><div class="tiny">Next: ${escapeHtml(options.result.nextStep)}</div></div>`
        : renderEmptyState("No review yet", options.error ?? "Create a review to capture scope creep, missing tests, and risks."),
      6,
    ),
    renderCard(
      "Review History",
      `<div class="list">${reviews.length > 0 ? reviews.map((review) => `<a href="/reviews/${encodeURIComponent(review.id)}" style="display:block"><div class="list-item"><div class="row"><strong>${escapeHtml(review.title)}</strong><span class="badge">${escapeHtml(review.createdAt)}</span></div><div class="tiny">${escapeHtml(review.summary)}</div></div></a>`).join("") : renderEmptyState("No reviews yet", "Review history will accumulate here.")}</div>`,
      12,
    ),
  ].join("");
  return pageShell("Reviews", "/reviews", {
    contentHtml,
    rightPanelHtml: renderCard("Recent Trace", renderEventFeed(store.listEvents(undefined, 40))),
    projects,
    projectCount: projects.length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: options.result ? "reviewed" : "ready",
  });
}

function renderReviewDetailPage(store: ReturnType<typeof createStore>, reviewId: string): string {
  const review = store.getReview(reviewId);
  if (!review) {
    return pageShell("Review not found", `/reviews/${reviewId}`, {
      contentHtml: renderCard("Missing review", `No review found for <code>${escapeHtml(reviewId)}</code>.`),
      projects: store.listProjects(),
      projectCount: store.listProjects().length,
      sessionCount: store.listSessions(1000).length,
      activeSessionCount: store.dashboardSnapshot().activeSessions,
      liveStatus: "missing",
    });
  }

  const plannedFiles = safeParseList(review.plannedFilesJson);
  const editedFiles = safeParseList(review.editedFilesJson);
  const checks = safeParseList(review.checksJson);
  const scopeCreep = safeParseList(review.scopeCreepJson);
  const missingTests = safeParseList(review.missingTestsJson);
  const riskyChanges = safeParseList(review.riskyChangesJson);
  const project = review.projectId ? store.getProject(review.projectId) : null;
  const session = review.sessionId ? store.getSession(review.sessionId) : null;

  const contentHtml = [
    renderCard(
      "Review Summary",
      renderKeyValueList([
        ["Title", review.title],
        ["Project", project ? project.name : review.projectId ?? "unknown"],
        ["Session", session ? session.title : review.sessionId ?? "none"],
        ["Created", review.createdAt],
        ["Updated", review.updatedAt],
      ]),
      6,
    ),
    renderCard("Summary", `<pre>${escapeHtml(review.summary)}</pre>`, 6),
    renderCard("Planned Files", plannedFiles.length > 0 ? `<div class="list">${plannedFiles.map((file) => `<div class="list-item">${escapeHtml(file)}</div>`).join("")}</div>` : renderEmptyState("No planned files", "The review did not capture planned files."), 4),
    renderCard("Edited Files", editedFiles.length > 0 ? `<div class="list">${editedFiles.map((file) => `<div class="list-item">${escapeHtml(file)}</div>`).join("")}</div>` : renderEmptyState("No edited files", "The review did not capture edited files."), 4),
    renderCard("Checks", checks.length > 0 ? `<div class="list">${checks.map((check) => `<div class="list-item">${escapeHtml(check)}</div>`).join("")}</div>` : renderEmptyState("No checks", "The review did not capture validation checks."), 4),
    renderCard("Scope Creep", scopeCreep.length > 0 ? `<div class="list">${scopeCreep.map((file) => `<div class="list-item">${escapeHtml(file)}</div>`).join("")}</div>` : renderEmptyState("No scope creep", "Nothing extra slipped into the change set."), 4),
    renderCard("Missing Tests", missingTests.length > 0 ? `<div class="list">${missingTests.map((file) => `<div class="list-item">${escapeHtml(file)}</div>`).join("")}</div>` : renderEmptyState("No missing tests", "The review did not flag missing tests."), 4),
    renderCard("Risky Changes", riskyChanges.length > 0 ? `<div class="list">${riskyChanges.map((file) => `<div class="list-item">${escapeHtml(file)}</div>`).join("")}</div>` : renderEmptyState("No risky changes", "Nothing high-risk was detected."), 4),
  ].join("");

  return pageShell(review.title, `/reviews/${review.id}`, {
    contentHtml,
    rightPanelHtml: renderCard("Recent Trace", renderEventFeed(store.listEvents(session?.id ?? undefined, 40))),
    activeProjectId: project?.id ?? null,
    projects: store.listProjects(),
    projectCount: store.listProjects().length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: "ready",
  });
}

function renderRetrievalPage(
  store: ReturnType<typeof createStore>,
  options: { projectId?: string; query?: string; chunks?: ReturnType<ReturnType<typeof createStore>["searchChunks"]> } = {},
): string {
  const projects = store.listProjects();
  const projectOptions = projects.map((project) => `<option value="${escapeHtml(project.id)}"${options.projectId === project.id ? " selected" : ""}>${escapeHtml(project.name)}</option>`).join("");
  const chunks = options.chunks ?? [];
  const contentHtml = [
    renderCard(
      "Search Retrieval",
      `<form method="post" action="/retrieval/search" class="stack">
        <select name="project">${projectOptions || `<option value="">Add a project first</option>`}</select>
        <textarea name="query" placeholder="where is auth handled?">${escapeHtml(options.query ?? "")}</textarea>
        <button type="submit">Search</button>
      </form>`,
      6,
    ),
    renderCard(
      "Results",
      chunks.length > 0
        ? `<div class="list">${chunks
            .map(
              (chunk) => `<div class="list-item"><div class="row"><strong>${escapeHtml(chunk.path)}</strong><span class="badge">score ${chunk.score.toFixed(1)}</span></div><div class="tiny">Lines ${chunk.startLine}-${chunk.endLine}</div><pre>${escapeHtml(chunk.content.slice(0, 260))}</pre></div>`,
            )
            .join("")}</div>`
        : renderEmptyState("No results", "Run a retrieval search against a project."),
      6,
    ),
  ].join("");
  return pageShell("Retrieval", "/retrieval", {
    contentHtml,
    rightPanelHtml: renderCard("Recent Trace", renderEventFeed(store.listEvents(undefined, 40))),
    projects,
    projectCount: projects.length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: "ready",
  });
}

function renderModelsPage(store: ReturnType<typeof createStore>, config: ConfigSnapshot): string {
  const usage = store.listModelUsage(20);
  const contentHtml = [
    renderCard(
      "Local Model Status",
      renderKeyValueList([
        ["API URL", config.apiUrl],
        ["Web Port", String(config.webPort)],
        ["Database", config.databasePath],
        ["Runtime", config.runtimeDir],
      ]),
      6,
    ),
    renderCard(
      "Usage History",
      `<div class="list">${usage.length > 0 ? usage.map((entry) => `<div class="list-item"><div class="row"><strong>${escapeHtml(entry.modelName)}</strong><span class="badge">${escapeHtml(entry.day)}</span></div><div class="tiny">Prompt ${entry.promptTokens} · completion ${entry.completionTokens} · requests ${entry.requests}</div></div>`).join("") : renderEmptyState("No usage yet", "Model usage will appear after generation calls are recorded.")}</div>`,
      6,
    ),
  ].join("");
  return pageShell("Models", "/models", {
    contentHtml,
    rightPanelHtml: renderCard("Config", `<pre>${escapeHtml(JSON.stringify(store.getSettings(config), null, 2))}</pre>`),
    projects: store.listProjects(),
    projectCount: store.listProjects().length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: "ready",
  });
}

function renderMcpPage(store: ReturnType<typeof createStore>): string {
  const calls = store.listMcpCalls(20);
  const contentHtml = [
    renderCard(
      "MCP Safety",
      renderKeyValueList([
        ["Allowed tools", "ai_search_project, ai_ask_rag, ai_create_session, ai_create_plan, ai_get_current_task, ai_get_next_subtask, ai_create_handoff, ai_run_check"],
        ["Blocked by default", "raw shell execution, arbitrary file writes"],
      ]),
      6,
    ),
    renderCard(
      "Recent Calls",
      `<div class="list">${calls.length > 0 ? calls.map((call) => `<a href="/mcp/calls/${encodeURIComponent(call.id)}" style="display:block"><div class="list-item"><div class="row"><strong>${escapeHtml(call.toolName)}</strong><span class="badge" data-tone="${call.blocked ? "bad" : "good"}">${call.blocked ? "blocked" : "allowed"}</span></div><div class="tiny">${escapeHtml(call.inputJson)}</div></div></a>`).join("") : renderEmptyState("No calls yet", "MCP calls will be logged here.")}</div>`,
      6,
    ),
  ].join("");
  return pageShell("MCP", "/mcp", {
    contentHtml,
    rightPanelHtml: renderCard("Recent Trace", renderEventFeed(store.listEvents(undefined, 40))),
    projects: store.listProjects(),
    projectCount: store.listProjects().length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: "ready",
  });
}

function renderSettingsPage(store: ReturnType<typeof createStore>, config: ConfigSnapshot): string {
  const settings = store.getSettings(config);
  const contentHtml = [
    renderCard("Settings Snapshot", `<pre>${escapeHtml(JSON.stringify(settings, null, 2))}</pre>`, 12),
    renderCard(
      "Runtime Notes",
      renderEmptyState("Current defaults", "The bootstrap uses local SQLite, local runtime directories, and no cloud routing by default."),
      12,
    ),
  ].join("");
  return pageShell("Settings", "/settings", {
    contentHtml,
    rightPanelHtml: renderCard("Recent Trace", renderEventFeed(store.listEvents(undefined, 40))),
    projects: store.listProjects(),
    projectCount: store.listProjects().length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: "ready",
  });
}

export async function startWorkbenchServer(options: ServerOptions = {}): Promise<ServerHandle> {
  const config = resolveConfig(options.config ?? {});
  await mkdir(config.runtimeDir, { recursive: true });
  const store = options.store ?? createStore(initializeStore(config.databasePath));
  await store.ensureRuntimeDirs(config.runtimeDir);
  if (options.intelligenceStack) {
    store.setIntelligenceStack(options.intelligenceStack);
  } else if (process.env.AI_DISABLE_INTELLIGENCE_STACK !== "true") {
    const providers = store.models.listProviders().map((provider) => ({
      id: provider.id,
      kind: provider.kind,
      displayName: provider.displayName,
      baseUrl: provider.baseUrl,
      apiKeyEnv: provider.apiKeyEnv,
      enabled: provider.enabled,
    }));
    const profiles = store.models.listProfiles();
    const runtime = createModelRuntime({
      providers,
      profiles,
      cloudEnabled: config.cloudEnabled,
    });
    store.setIntelligenceStack({ runtime, providers, profiles });
  }

  const listeners = new Set<any>();
  const publish = (event: EventEnvelope) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of listeners) {
      try {
        res.write(payload);
      } catch {
        listeners.delete(res);
      }
    }
  };

  const app = fastify({ logger: false });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });
  app.addContentTypeParser("text/plain", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });
  app.addContentTypeParser("multipart/form-data", (_request, payload, done) => {
    const req = payload as unknown as { on: (event: string, listener: (...args: unknown[]) => void) => void };
    let data = "";
    req.on("data", (chunk: unknown) => {
      data += typeof chunk === "string" ? chunk : (chunk as { toString(enc: string): string }).toString("utf8");
    });
    req.on("end", () => done(null, data));
    req.on("error", (err: unknown) => done(err instanceof Error ? err : new Error(String(err))));
  });
  app.all("/*", async (request, reply) => {
    reply.hijack();
    const req: any = request.raw;
    const res: any = reply.raw;
    let path = "/";
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = String(req.method ?? "GET").toUpperCase();
      path = url.pathname;

      try {
      if (method === "GET" && path === "/health") {
        sendJson(res, json("ok", buildHealthSnapshot(store, config)));
        return;
      }

      if (method === "GET" && path === "/version") {
        sendJson(res, json("ok", { version: "0.1.0", build: "bootstrap" }));
        return;
      }

      if (method === "GET" && path === "/config") {
        sendJson(
          res,
          json("ok", {
            ...config,
            projects: store.listProjects().length,
            activeSessions: store.dashboardSnapshot().activeSessions,
          }),
        );
        return;
      }

      if (method === "GET" && path === "/status") {
        const dashboard = store.dashboardSnapshot();
        const health = buildHealthSnapshot(store, config);
        sendJson(
          res,
          json("ok", {
            health,
            config: {
              ...config,
              projects: store.listProjects().length,
              activeSessions: dashboard.activeSessions,
            },
            summary: {
              projects: dashboard.projects,
              activeSessions: dashboard.activeSessions,
              sessions: dashboard.recentSessions.length,
              lessons: dashboard.recentLessons.length,
              checks: dashboard.recentChecks.length,
            },
            projects: store.listProjects().slice(0, 3).map((project) => ({
              id: project.id,
              name: project.name,
              status: project.status,
              path: project.path,
            })),
            sessions: dashboard.recentSessions.map((session) => ({
              id: session.id,
              title: session.title,
              status: session.status,
              mode: session.mode,
              startedAt: session.startedAt,
            })),
            checks: dashboard.recentChecks.map((check) => ({
              id: check.id,
              name: check.name,
              status: check.status,
              createdAt: check.createdAt,
            })),
            settings: store.getSettings(config),
          }),
        );
        return;
      }

      if (method === "GET" && path === "/events/stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        });
        res.write(": connected\n\n");
        for (const event of store.listEvents(undefined, 500)) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        listeners.add(res);
        req.on("close", () => {
          listeners.delete(res);
        });
        return;
      }

      if (method === "GET" && path === "/") {
        redirect(res, "/dashboard");
        return;
      }

      if (method === "GET" && path === "/dashboard") {
        sendHtml(res, renderDashboard(store));
        return;
      }

      if (method === "GET" && path === "/projects") {
        if (!isHtmlRequest(req)) {
          sendJson(res, json("ok", store.listProjects()));
          return;
        }
        sendHtml(res, renderProjectsPage(store));
        return;
      }

      if (path.startsWith("/projects/")) {
        const projectId = decodeURIComponent(path.slice("/projects/".length)).split("/")[0];
        const rest = path.slice(`/projects/${projectId}`.length);
        if (method === "GET" && rest === "") {
          if (!isHtmlRequest(req)) {
            sendJson(res, json("ok", store.getProject(projectId)));
            return;
          }
          sendHtml(res, renderProjectDetailPage(store, projectId));
          return;
        }
        if (method === "GET" && rest === "/symbols") {
          const project = store.getProject(projectId);
          if (!project) {
            sendJson(res, json("error", undefined, { message: "project not found" }), 404);
            return;
          }
          const query = url.searchParams.get("query") || url.searchParams.get("q") || null;
          const limit = Number(url.searchParams.get("limit") || 50) || 50;
          const symbols = store.codeIntelligence.listSymbols(project.id, query, limit);
          const total = store.codeIntelligence.countSymbols(project.id);
          sendJson(res, json("ok", { project, symbols, query, limit, total }));
          return;
        }

        if (method === "GET" && rest === "/graph") {
          const project = store.getProject(projectId);
          if (!project) {
            sendJson(res, json("error", undefined, { message: "project not found" }), 404);
            return;
          }
          const graph = readProjectGraph(store, project.id);
          const topSymbols = store.codeIntelligence.listSymbols(project.id, null, 20);
          const topEdges = store.codeIntelligence.listEdges(project.id, 20);

          const counts = {
            symbols: store.codeIntelligence.countSymbols(project.id),
            edges: store.codeIntelligence.countEdges(project.id),
            routeFiles: graph?.routeFiles?.length ?? 0,
            middlewareFiles: graph?.middlewareFiles?.length ?? 0,
            dbFiles: graph?.dbFiles?.length ?? 0,
            authPaths: graph?.authPaths?.length ?? 0,
          };

          sendJson(
            res,
            json("ok", {
              project,
              config: resolveProjectConfig(project.path),
              graph,
              counts,
              topSymbols,
              topEdges,
              symbols: topSymbols,
              edges: topEdges,
            }),
          );
          return;
        }
        if (method === "POST" && rest === "/index") {
          const result = await store.indexProject(projectId);
          result.events.forEach(publish);
          if (isHtmlRequest(req)) {
            redirect(res, `/sessions/${result.session.id}`);
          } else {
            sendJson(res, json("ok", result));
          }
          return;
        }
        if (method === "GET" && rest === "/memory") {
          sendJson(
            res,
            json("ok", {
              lessons: store.listProjectLessons(projectId),
              rules: store.listProjectRules(projectId),
              memory: store.listProjectMemory(projectId),
            }),
          );
          return;
        }
        if (method === "GET" && rest === "/retrieval") {
          const query = String(url.searchParams.get("q") ?? "");
          sendJson(res, json("ok", { chunks: store.searchChunks(projectId, query, { limit: 20 }), query }));
          return;
        }
      }

      if (method === "POST" && path === "/projects") {
        const body = (req.headers?.["content-type"]?.includes("application/json")
          ? await readJsonBody(request, req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(request, req)))) as Record<string, unknown>;
        const input = parseProjectCreateInput(body);
        const project = store.createProject(input);
        if (isHtmlRequest(req)) {
          redirect(res, `/projects/${project.id}`);
        } else {
          sendJson(res, json("ok", project));
        }
        return;
      }

      if (method === "GET" && path === "/sessions") {
        if (!isHtmlRequest(req)) {
          sendJson(res, json("ok", store.listSessions(100)));
          return;
        }
        sendHtml(res, renderSessionsPage(store));
        return;
      }

      if (method === "GET" && path === "/prompts") {
        const sessionId = url.searchParams.get("sessionId");
        const limit = Number(url.searchParams.get("limit") ?? 100) || 100;
        const prompts = store.listCompiledPrompts(sessionId, limit);
        if (!isHtmlRequest(req)) {
          sendJson(res, json("ok", prompts));
          return;
        }
        sendHtml(res, renderPromptsPage(store, sessionId));
        return;
      }

      if (path.startsWith("/prompts/")) {
        const promptId = decodeURIComponent(path.slice("/prompts/".length)).split("/")[0];
        const prompt = store.getCompiledPrompt(promptId);
        if (!prompt) {
          if (!isHtmlRequest(req)) {
            sendJson(res, json("error", undefined, { message: "prompt not found" }), 404);
            return;
          }
          sendHtml(res, renderCompiledPromptPage(store, promptId), 404);
          return;
        }
        if (!isHtmlRequest(req)) {
          sendJson(res, json("ok", prompt));
          return;
        }
        sendHtml(res, renderCompiledPromptPage(store, promptId));
        return;
      }

      if (method === "GET" && path === "/tasks") {
        if (!isHtmlRequest(req)) {
          sendJson(res, json("ok", store.listRecentTasks(100)));
          return;
        }
        sendHtml(res, renderTasksPage(store));
        return;
      }

      if (path.startsWith("/sessions/")) {
        const sessionId = decodeURIComponent(path.slice("/sessions/".length)).split("/")[0];
        const rest = path.slice(`/sessions/${sessionId}`.length);
        if (method === "GET" && rest === "") {
          if (!isHtmlRequest(req)) {
            sendJson(res, json("ok", store.getSession(sessionId)));
            return;
          }
          sendHtml(res, renderSessionDetailPage(store, sessionId));
          return;
        }
        if (method === "GET" && rest === "/events") {
          sendJson(res, json("ok", store.listEvents(sessionId, 500)));
          return;
        }
        if (method === "GET" && rest === "/timeline") {
          const session = store.getSession(sessionId);
          if (!session) {
            sendJson(res, json("error", undefined, { message: "session not found" }), 404);
            return;
          }
          const timeline = buildSessionTimeline({
            session,
            messages: store.conversation.listMessages(sessionId, 500),
            events: store.listEvents(sessionId, 500),
            agentRuns: store.agents.listRuns(sessionId, 200),
            modelCalls: store.models.listCalls(sessionId, 200),
            compiledPrompts: store.listCompiledPrompts(sessionId, 100),
            retrievalQueries: store.retrieval.listQueriesForSession(sessionId, 100),
            contextPacks: store.context.listPacksForSession(sessionId, 100),
            outcomes: store.evals.listOutcomes(sessionId, 100),
          });
          sendJson(res, json("ok", timeline));
          return;
        }
        if (method === "GET" && rest === "/trace") {
          const trace = buildSessionTraceData(store, sessionId);
          if (!trace.session) {
            sendJson(res, json("error", undefined, { message: "session not found" }), 404);
            return;
          }
          sendJson(res, json("ok", trace));
          return;
        }
        if (method === "POST" && rest === "/replay") {
          const body = (req.headers?.["content-type"]?.includes("application/json")
            ? await readJsonBody(request, req)
            : Object.fromEntries(new URLSearchParams(await readTextBody(request, req)))) as Record<string, unknown>;
          const input: SessionReplayRequest = {
            fromTimelineItemId: typeof body.fromTimelineItemId === "string" ? body.fromTimelineItemId : undefined,
            editedUserRequest: typeof body.editedUserRequest === "string" ? body.editedUserRequest : undefined,
            editedSystemPrompt: typeof body.editedSystemPrompt === "string" ? body.editedSystemPrompt : undefined,
            editedContextPackId: typeof body.editedContextPackId === "string" ? body.editedContextPackId : undefined,
            selectedPromptId: typeof body.selectedPromptId === "string" ? body.selectedPromptId : undefined,
            modelProfileId: typeof body.modelProfileId === "string" ? body.modelProfileId : undefined,
            mode: body.mode === "local" || body.mode === "hybrid" || body.mode === "cloud" ? body.mode : undefined,
            dryRun: body.dryRun === true || body.dryRun === "true",
          };
          const parentSession = store.getSession(sessionId);
          if (!parentSession) {
            sendJson(res, json("error", undefined, { message: "session not found" }), 404);
            return;
          }
          const replayQuestion = input.editedUserRequest ?? parentSession.userGoal;
          const replayMode = input.mode ?? (parentSession.mode === "plan" || parentSession.mode === "handoff" || parentSession.mode === "check" || parentSession.mode === "reflect" ? "local" : parentSession.mode);
          const branchSession = store.createSession({
            projectId: parentSession.projectId,
            title: `Replay: ${parentSession.title}`,
            userGoal: replayQuestion,
            mode: replayMode === "local" || replayMode === "hybrid" || replayMode === "cloud" ? replayMode : "local",
            source: "replay",
            modelProfile: input.modelProfileId ?? parentSession.modelProfile,
          });
          store.db.prepare(
            `INSERT INTO session_replays (
              id, parent_session_id, child_session_id, source_session_id, mode, request_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            createId("srep"),
            parentSession.id,
            branchSession.id,
            input.fromTimelineItemId ?? null,
            replayMode === "local" || replayMode === "hybrid" || replayMode === "cloud" ? replayMode : "local",
            JSON.stringify(input),
            new Date().toISOString(),
            new Date().toISOString(),
          );
          if (input.dryRun) {
            sendJson(
              res,
              json("ok", {
                parentSessionId: parentSession.id,
                childSession: branchSession,
                replay: {
                  dryRun: true,
                  request: input,
                },
              }),
            );
            return;
          }
          const runtime = buildRuntimeForStore(store, config.cloudEnabled);
          const result = await runAskWorkflow({
            store,
            runtime,
            cloudEnabled: config.cloudEnabled,
            input: {
              project: parentSession.projectId ?? "",
              question: replayQuestion,
              mode: replayMode === "local" || replayMode === "hybrid" || replayMode === "cloud" ? replayMode : "local",
              depth: "standard",
            },
            preferredAnswerProfileId: input.modelProfileId ?? parentSession.modelProfile,
            sessionId: branchSession.id,
          });
          sendJson(
            res,
            json("ok", {
              parentSessionId: parentSession.id,
              childSession: store.getSession(branchSession.id),
              replay: {
                request: input,
                result,
              },
            }),
          );
          return;
        }
      }

      if (path.startsWith("/tasks/")) {
        const taskId = decodeURIComponent(path.slice("/tasks/".length)).split("/")[0];
        const rest = path.slice(`/tasks/${taskId}`.length);
        const task = store.getTask(taskId);
        if (!task) {
          if (method === "GET") {
            sendHtml(res, renderTaskDetailPage(store, taskId), 404);
            return;
          }
          sendJson(res, json("error", undefined, { message: `Unknown task: ${taskId}` }), 404);
          return;
        }
        if (method === "GET" && rest === "") {
          if (!isHtmlRequest(req)) {
            sendJson(res, json("ok", task));
            return;
          }
          sendHtml(res, renderTaskDetailPage(store, taskId));
          return;
        }
        if (method === "POST" && (rest === "/start" || rest === "/complete" || rest === "/fail")) {
          const body = (req.headers?.["content-type"]?.includes("application/json")
            ? await readJsonBody(request, req)
            : Object.fromEntries(new URLSearchParams(await readTextBody(request, req)))) as Record<string, unknown>;
          const session = store.getSession(task.sessionId);
          const projectId = session?.projectId ?? null;
          let nextTask = task;
          if (rest === "/start") {
            nextTask = store.updateTask(task.id, { status: "running" });
            if (session) {
              store.updateSession(session.id, { activeTaskId: task.id });
            }
            store.appendEvent(createEvent("task.started", { title: task.title }, { sessionId: task.sessionId, projectId, taskId: task.id, agent: "orchestrator" }));
          } else if (rest === "/complete") {
            const result = String(body.result ?? body.note ?? "");
            nextTask = store.updateTask(task.id, {
              status: "completed",
              actualFilesJson: JSON.stringify(safeParseList(task.expectedFilesJson)),
              resultJson: JSON.stringify({ result, completedAt: new Date().toISOString() }),
            });
            if (session?.activeTaskId === task.id) {
              store.updateSession(session.id, { activeTaskId: null });
            }
            store.appendEvent(createEvent("task.completed", { title: task.title, result }, { sessionId: task.sessionId, projectId, taskId: task.id, agent: "orchestrator" }));
          } else {
            const error = String(body.error ?? body.note ?? "");
            nextTask = store.updateTask(task.id, {
              status: "failed",
              resultJson: JSON.stringify({ error, failedAt: new Date().toISOString() }),
            });
            if (session?.activeTaskId === task.id) {
              store.updateSession(session.id, { activeTaskId: null });
            }
            store.appendEvent(createEvent("task.failed", { title: task.title, error }, { sessionId: task.sessionId, projectId, taskId: task.id, agent: "orchestrator" }));
          }
          if (isHtmlRequest(req)) {
            sendHtml(res, renderTaskDetailPage(store, nextTask.id));
          } else {
            sendJson(res, json("ok", nextTask));
          }
          return;
        }
      }

      if (path.startsWith("/checks/")) {
        const checkId = decodeURIComponent(path.slice("/checks/".length)).split("/")[0];
        if (method === "GET") {
          sendJson(res, json("ok", store.getCheckRun(checkId)));
          return;
        }
      }

      if (path.startsWith("/handoffs/")) {
        const handoffId = decodeURIComponent(path.slice("/handoffs/".length)).split("/")[0];
        if (method === "GET") {
          const handoff = store.listHandoffs(undefined, 100).find((item) => item.id === handoffId) ?? null;
          sendJson(res, json("ok", handoff));
          return;
        }
      }

      if (method === "POST" && path === "/ask") {
        const body = (req.headers?.["content-type"]?.includes("application/json")
          ? await readJsonBody(request, req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(request, req)))) as Record<string, unknown>;
        const normalized: AskRequest = parseAskRequest(body);
        const result = await store.ask(normalized);
        store.listEvents(result.sessionId).forEach(publish);
        if (isHtmlRequest(req)) {
          sendHtml(res, renderAskPage(store, { result, question: normalized.question }));
        } else {
          sendJson(res, json("ok", result));
        }
        return;
      }

      if (method === "POST" && path === "/plan") {
        const body = (req.headers?.["content-type"]?.includes("application/json")
          ? await readJsonBody(request, req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(request, req)))) as Record<string, unknown>;
        const normalized: PlanRequest = {
          project: String(body.project ?? ""),
          goal: String(body.goal ?? ""),
          risk: body.risk === "low" || body.risk === "medium" || body.risk === "high" ? body.risk : "medium",
        };
        const result = await store.createPlan(normalized);
        if (isHtmlRequest(req)) {
          sendHtml(res, renderPlannerPage(store, { result: result.response }));
        } else {
          sendJson(res, json("ok", result.response));
        }
        return;
      }

      if (method === "POST" && path === "/research") {
        const body = (req.headers?.["content-type"]?.includes("application/json")
          ? await readJsonBody(request, req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(request, req)))) as Record<string, unknown>;
        const projectId = String(body.project ?? body.projectId ?? "");
        const topic = String(body.topic ?? "");
        const mode = body.mode === "web" || body.mode === "hybrid" ? body.mode : "local";
        const chunks = store.searchChunks(projectId, topic, { limit: mode === "local" ? 6 : 10 });
        const lessons = store.listProjectLessons(projectId, 5);
        const sources = chunks.map((chunk) => ({
          path: chunk.path,
          score: chunk.score,
          excerpt: chunk.content.split("\n").slice(0, 4).join("\n"),
        }));
        const contradictions = lessons
          .filter((lesson) => /but|however|contradict|instead/i.test(lesson.body))
          .map((lesson) => lesson.title)
          .slice(0, 5);
        const summary = [
          `Topic: ${topic}`,
          `Mode: ${mode}`,
          "",
          `Found ${chunks.length} local sources and ${lessons.length} lessons.`,
          mode === "web" ? "Web research is not wired yet, so this result is local-first only." : "",
          "",
          ...sources.slice(0, 3).map((source) => `- ${source.path} (score ${source.score.toFixed(1)})`),
        ]
          .filter(Boolean)
          .join("\n");
        const brief = [
          `Research brief for ${topic}.`,
          `Use the highest-scoring local sources first.`,
          contradictions.length > 0 ? `Watch for contradictions in: ${contradictions.join(", ")}.` : "No obvious contradictions detected in current lessons.",
          `Top sources: ${sources.slice(0, 3).map((source) => source.path).join(", ") || "none"}.`,
        ].join("\n");
        const result = { summary, sources, contradictions, brief };
        if (isHtmlRequest(req)) {
          sendHtml(res, renderResearchPage(store, { projectId, topic, mode, result }));
        } else {
          sendJson(res, json("ok", { projectId, topic, mode, ...result }));
        }
        return;
      }

      if (method === "POST" && path === "/handoff") {
        const body = (req.headers?.["content-type"]?.includes("application/json")
          ? await readJsonBody(request, req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(request, req)))) as Record<string, unknown>;
        const normalized: HandoffRequest = {
          sessionId: String(body.sessionId ?? ""),
          project: String(body.project ?? ""),
          target:
            body.target === "opencode" ||
            body.target === "codex" ||
            body.target === "manual" ||
            body.target === "clipboard" ||
            body.target === "file"
              ? body.target
              : "manual",
          subtask: String(body.subtask ?? ""),
        };
        const result = await store.createHandoff(normalized);
        if (isHtmlRequest(req)) {
          sendHtml(res, renderHandoffPage(store, { result }));
        } else {
          sendJson(res, json("ok", result));
        }
        return;
      }

      if (path.startsWith("/dev/")) {
        const tail = decodeURIComponent(path.slice("/dev/".length));
        const [head, ...rest] = tail.split("/");
        const trimmedRest = rest.join("/");

        if (method === "POST" && head === "run") {
          const body = (req.headers?.["content-type"]?.includes("application/json")
            ? await readJsonBody(request, req)
            : Object.fromEntries(new URLSearchParams(await readTextBody(request, req)))) as Record<string, unknown>;
          const devRequest = parseDevRequest({
            project: body.project ?? body.projectId ?? "",
            goal: body.goal ?? "",
            mode: body.mode,
            approvalPolicy: body.approvalPolicy,
            approveEdits: body.approveEdits,
            checks: Array.isArray(body.checks) ? body.checks : undefined,
            maxRepairs: typeof body.maxRepairs === "number" ? body.maxRepairs : undefined,
          });
          const projectId = String(body.projectId ?? devRequest.project);
          const project = store.getProject(projectId);
          if (!project) {
            sendJson(res, json("error", undefined, { message: `unknown project: ${projectId}` }), 404);
            return;
          }
          const session = store.createSession({
            projectId: project.id,
            title: devRequest.goal.slice(0, 80),
            userGoal: devRequest.goal,
            mode: "dev" as any,
            source: "api",
            modelProfile: "dev-editor-local",
          });
          const runtimeDir = config.runtimeDir;
          await store.ensureRuntimeDirs(runtimeDir);
          const devRuntime = createModelRuntime({
            providers: store.models.listProviders().map((p) => ({
              id: p.id,
              kind: p.kind,
              displayName: p.displayName,
              baseUrl: p.baseUrl,
              apiKeyEnv: p.apiKeyEnv,
              enabled: p.enabled,
            })),
            profiles: store.models.listProfiles(),
            cloudEnabled: config.cloudEnabled,
          });
          const result = await runDevWorkflow({
            request: devRequest,
            project: { id: project.id, name: project.name, path: project.path, config: resolveProjectConfig(project.path).raw },
            runtime: {
              devRuns: store.dev,
              execution: store.execution,
              retrieval: store.retrieval,
              models: store.models,
              conversation: store.conversation,
              modelRuntime: devRuntime,
            },
            runtimeDir,
            sessionId: session.id,
            source: "api",
          });
          sendJson(res, json("ok", result.result));
          return;
        }

        if (method === "GET" && head === "runs" && trimmedRest.length === 0) {
          const projectId = url.searchParams.get("projectId");
          const limit = Number(url.searchParams.get("limit") ?? "50") || 50;
          const runs = store.dev.listRuns(projectId ? { projectId, limit } : { limit });
          sendJson(res, json("ok", { runs }));
          return;
        }

        if (method === "GET" && head === "runs" && trimmedRest.length > 0) {
          const runId = trimmedRest.split("/")[0] ?? "";
          const run = store.dev.getRunWithEdits(runId);
          if (!run) {
            sendJson(res, json("error", undefined, { message: "dev run not found" }), 404);
            return;
          }
          const workspace = store.execution.getWorkspaceForRun(run.id);
          const approvals = store.execution.listApprovals(run.id);
          const patches = store.execution.listPatches(run.id);
          sendJson(
            res,
            json("ok", {
              run,
              workspace,
              approvals,
              patches,
            }),
          );
          return;
        }

        if (method === "GET" && head === "runs" && trimmedRest.endsWith("/diff")) {
          const runId = trimmedRest.split("/")[0] ?? "";
          const run = store.dev.getRun(runId);
          if (!run) {
            sendJson(res, json("error", undefined, { message: "dev run not found" }), 404);
            return;
          }
          sendJson(res, json("ok", { runId: run.id, diff: run.workspace?.path ? "" : "", diffText: "", summary: run.summary }));
          return;
        }

        if (method === "POST" && head === "runs" && trimmedRest.endsWith("/approve")) {
          const runId = trimmedRest.split("/")[0] ?? "";
          const body = (req.headers?.["content-type"]?.includes("application/json")
            ? await readJsonBody(request, req)
            : {}) as Record<string, unknown> | null;
          const approval = await approveDevRun({
            runId,
            runtime: { devRuns: store.dev, execution: store.execution },
            decidedBy: typeof body?.decidedBy === "string" ? body.decidedBy : "api",
            notes: typeof body?.notes === "string" ? body.notes : undefined,
          });
          sendJson(res, approval.ok ? json("ok", approval.run) : json("error", undefined, { message: approval.error ?? "approval failed" }), approval.ok ? 200 : 400);
          return;
        }

        if (method === "POST" && head === "runs" && trimmedRest.endsWith("/apply")) {
          const runId = trimmedRest.split("/")[0] ?? "";
          const run = store.dev.getRun(runId);
          if (!run) {
            sendJson(res, json("error", undefined, { message: "dev run not found" }), 404);
            return;
          }
          const project = store.getProject(run.projectId);
          if (!project) {
            sendJson(res, json("error", undefined, { message: "project not found" }), 404);
            return;
          }
          const outcome = await applyApprovedDevRun({
            runId,
            projectPath: project.path,
            runtime: { devRuns: store.dev, execution: store.execution },
          });
          sendJson(res, outcome.ok ? json("ok", { run: outcome.run, applied: outcome.applied }) : json("error", undefined, { message: outcome.error ?? "apply failed" }), outcome.ok ? 200 : 400);
          return;
        }

        if (method === "POST" && head === "runs" && trimmedRest.endsWith("/cancel")) {
          const runId = trimmedRest.split("/")[0] ?? "";
          const body = (req.headers?.["content-type"]?.includes("application/json")
            ? await readJsonBody(request, req)
            : {}) as Record<string, unknown> | null;
          const outcome = await cancelDevRun({
            runId,
            runtime: { devRuns: store.dev, execution: store.execution },
            reason: typeof body?.reason === "string" ? body.reason : undefined,
          });
          sendJson(res, outcome.ok ? json("ok", outcome.run) : json("error", undefined, { message: outcome.error ?? "cancel failed" }), outcome.ok ? 200 : 400);
          return;
        }
      }

      if (method === "POST" && path === "/checks/run") {
        const body = (req.headers?.["content-type"]?.includes("application/json")
          ? await readJsonBody(request, req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(request, req)))) as Record<string, unknown>;
        const name = String(body.name ?? "");
        const projectId = body.projectId ? String(body.projectId) : null;
        const allowed = new Set(["typecheck", "tests", "build", "lint"]);
        const check = store.createCheckRun({
          name,
          projectId,
          status: allowed.has(name) ? "completed" : "blocked",
          command: name,
          output: allowed.has(name) ? `Recorded allowlisted check ${name}.` : null,
          errorOutput: allowed.has(name) ? null : `Check ${name} is not allowlisted.`,
          exitCode: allowed.has(name) ? 0 : 1,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        });
        if (!allowed.has(name)) {
          store.appendEvent(createEvent("tool.blocked", { tool: name, reason: "check not allowlisted" }, { projectId, agent: "checks" }));
        } else {
          store.appendEvent(createEvent("check.completed", { name }, { projectId, agent: "checks" }));
        }
        if (isHtmlRequest(req)) {
          sendHtml(res, renderChecksPage(store));
        } else {
          sendJson(res, json("ok", check));
        }
        return;
      }

      if (method === "POST" && path === "/memory/lesson") {
        const body = (req.headers?.["content-type"]?.includes("application/json")
          ? await readJsonBody(request, req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(request, req)))) as Record<string, unknown>;
        const projectId = body.projectId ? String(body.projectId) : null;
        const lesson = store.createLesson({
          projectId,
          sessionId: body.sessionId ? String(body.sessionId) : null,
          title: String(body.title ?? "Memory note"),
          body: String(body.body ?? ""),
          tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
          importance: Number(body.importance ?? 1),
        });
        if (isHtmlRequest(req)) {
          sendHtml(res, renderMemoryPage(store));
        } else {
          sendJson(res, json("ok", lesson));
        }
        return;
      }

      if (method === "POST" && path === "/memory/reflect") {
        const body = (req.headers?.["content-type"]?.includes("application/json")
          ? await readJsonBody(request, req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(request, req)))) as Record<string, unknown>;
        const sessionId = String(body.sessionId ?? "");
        const session = store.getSession(sessionId);
        if (!session) {
          throw new Error(`Unknown session: ${sessionId}`);
        }
        const lesson = store.createLesson({
          projectId: session.projectId,
          sessionId,
          title: `Reflection: ${session.title}`,
          body: session.finalSummary ?? session.userGoal,
          tags: ["reflection"],
          importance: 3,
        });
        store.appendEvent(createEvent("lesson.created", { title: lesson.title, body: lesson.body, tags: ["reflection"], importance: 3 }, { sessionId, projectId: session.projectId, agent: "learning" }));
        if (isHtmlRequest(req)) {
          sendHtml(res, renderMemoryPage(store));
        } else {
          sendJson(res, json("ok", lesson));
        }
        return;
      }

      if (method === "POST" && path === "/reviews") {
        const body = (req.headers?.["content-type"]?.includes("application/json")
          ? await readJsonBody(request, req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(request, req)))) as Record<string, unknown>;
        const result = store.createReview({
          project: String(body.project ?? ""),
          sessionId: body.sessionId ? String(body.sessionId) : null,
          title: body.title ? String(body.title) : undefined,
          plannedFiles: String(body.plannedFiles ?? "")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
          editedFiles: String(body.editedFiles ?? "")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
          checks: String(body.checks ?? "")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
          notes: body.notes ? String(body.notes) : undefined,
        });
        const job = store.enqueueJob({
          type: "review.reflect",
          payload: { reviewId: result.id, source: "api" },
        });
        if (isHtmlRequest(req)) {
          sendHtml(res, renderReviewsPage(store, { result }));
        } else {
          sendJson(res, json("ok", { result, jobId: job.id }));
        }
        return;
      }

      if (method === "GET" && path === "/prompt-lab/runs") {
        sendJson(res, json("ok", store.promptLab.listRuns(100)));
        return;
      }

      if (path.startsWith("/prompt-lab/runs/")) {
        const runId = decodeURIComponent(path.slice("/prompt-lab/runs/".length)).split("/")[0];
        const run = store.promptLab.getRun(runId);
        if (!run) {
          sendJson(res, json("error", undefined, { message: "prompt lab run not found" }), 404);
          return;
        }
        sendJson(
          res,
          json("ok", {
            run,
            prompt: store.getCompiledPrompt(run.promptId),
            results: store.promptLab.listResults(runId),
          }),
        );
        return;
      }

      if (method === "POST" && path === "/prompt-lab/run") {
        const body = (req.headers?.["content-type"]?.includes("application/json")
          ? await readJsonBody(request, req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(request, req)))) as Record<string, unknown>;
        const projectId = String(body.projectId ?? body.project ?? "");
        const promptId = String(body.promptId ?? body.prompt ?? "");
        const selectedProfiles = Array.isArray(body.modelProfileIds)
          ? body.modelProfileIds
          : Array.isArray(body.modelProfiles)
            ? body.modelProfiles
            : [];
        const notes = typeof body.notes === "string" ? body.notes : null;
        const dryRun = body.dryRun === true || body.dryRun === "true";
        try {
          const engineResult = await runPromptLab({
            getProject(id: string) { return store.getProject(id); },
            getCompiledPrompt(id: string) { return store.getCompiledPrompt(id); },
            createRun(input) { return store.promptLab.createRun(input); },
            createResult(input) { return store.promptLab.createResult(input); },
            getProfile(id: string) { return store.models.getProfile(id); },
            listProfiles() { return store.models.listProfiles(); },
            listProviders() { return store.models.listProviders(); },
          }, { projectId, promptId, selectedProfiles, notes, dryRun }, {
            cloudEnabled: config.cloudEnabled,
            recordModelCall(input: Parameters<ModelCallRecordedHook>[0]) { return store.models.recordCall(input); },
          });
          sendJson(res, json("ok", engineResult));
        } catch (error) {
          const statusCode = (error as Error & { statusCode?: number }).statusCode ?? 500;
          sendJson(res, json("error", undefined, { message: (error as Error).message }), statusCode);
        }
        return;
      }

      if (method === "POST" && path === "/retrieval/search") {
        const body = (req.headers?.["content-type"]?.includes("application/json")
          ? await readJsonBody(request, req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(request, req)))) as Record<string, unknown>;
        const projectId = String(body.project ?? body.projectId ?? "");
        const query = String(body.query ?? "");
        const chunks = store.searchChunks(projectId, query, { limit: Number(body.limit ?? 8) || 8 });
        if (isHtmlRequest(req)) {
          sendHtml(res, renderRetrievalPage(store, { projectId, query, chunks }));
        } else {
          sendJson(res, json("ok", chunks));
        }
        return;
      }

      if (method === "POST" && path === "/retrieval/explain") {
        const body = (req.headers?.["content-type"]?.includes("application/json")
          ? await readJsonBody(request, req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(request, req)))) as Record<string, unknown>;
        const projectId = String(body.project ?? body.projectId ?? "");
        const query = String(body.query ?? "");
        const mode = body.mode === "cloud" || body.mode === "hybrid" ? body.mode : "local";
        const depth = body.depth === "shallow" || body.depth === "deep" ? body.depth : "standard";
        const limit = Number(body.limit ?? 8) || 8;
        if (!projectId || !query) {
          sendJson(res, json("error", undefined, { message: "project and query are required" }));
          return;
        }
        const projectRecord = store.getProject(projectId);
        if (!projectRecord) {
          sendJson(res, json("error", undefined, { message: `Unknown project: ${projectId}` }));
          return;
        }
        const explanation = runExplainWithStore(store, { projectId, query, mode, depth, limit });
        sendJson(res, json("ok", explanation));
        return;
      }

      if (method === "POST" && path === "/context/explain") {
        const body = (req.headers?.["content-type"]?.includes("application/json")
          ? await readJsonBody(request, req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(request, req)))) as Record<string, unknown>;
        const projectId = String(body.project ?? body.projectId ?? "");
        const query = String(body.query ?? "");
        const mode = body.mode === "cloud" || body.mode === "hybrid" ? body.mode : "local";
        const depth = body.depth === "shallow" || body.depth === "deep" ? body.depth : "standard";
        const limit = Number(body.limit ?? 8) || 8;
        const project = store.getProject(projectId);
        if (!project) {
          sendJson(res, json("error", undefined, { message: `Unknown project: ${projectId}` }), 404);
          return;
        }
        const explanation = runExplainWithStore(store, { projectId, query, mode, depth, limit });
        sendJson(
          res,
          json("ok", {
            project,
            config: resolveProjectConfig(project.path),
            graph: readProjectGraph(store, project.id),
            explanation,
            selectionReasons: explanation.selected.map((entry) => ({
              path: entry.path,
              finalScore: entry.finalScore,
              rerankReason: explanation.ranked.find((ranked) => ranked.path === entry.path)?.rerankReason ?? "selected",
            })),
          }),
        );
        return;
      }

      if (method === "POST" && path === "/retrieval/context") {
        const body = (req.headers?.["content-type"]?.includes("application/json")
          ? await readJsonBody(request, req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(request, req)))) as Record<string, unknown>;
        const projectId = String(body.project ?? body.projectId ?? "");
        const query = String(body.query ?? "");
        const chunks = store.searchChunks(projectId, query, { limit: Number(body.limit ?? 8) || 8 });
        const context = {
          query,
          selectedFiles: [...new Set(chunks.map((chunk) => chunk.path))],
          chunks,
        };
        sendJson(res, json("ok", context));
        return;
      }

      if (method === "GET" && path === "/ask") {
        sendHtml(res, renderAskPage(store));
        return;
      }

      if (method === "GET" && path === "/research") {
        if (!isHtmlRequest(req)) {
          sendJson(res, json("ok", { lessons: store.listRecentLessons(20), rules: store.listProjects().flatMap((project) => store.listProjectRules(project.id, 10)) }));
          return;
        }
        sendHtml(res, renderResearchPage(store));
        return;
      }
      if (method === "GET" && path === "/planner") {
        if (!isHtmlRequest(req)) {
          sendJson(
            res,
            json("ok", {
              tasks: store.listRecentTasks(40),
              projects: store.listProjects(),
              recentSessions: store.listSessions(20).filter((session) => session.mode === "plan"),
              activeSessionCount: store.dashboardSnapshot().activeSessions,
            }),
          );
          return;
        }
        sendHtml(res, renderPlannerPage(store));
        return;
      }
      if (method === "GET" && path === "/handoff") {
        if (!isHtmlRequest(req)) {
          sendJson(
            res,
            json("ok", {
              projects: store.listProjects(),
              sessions: store.listSessions(20),
              handoffs: store.listHandoffs(undefined, 20),
            }),
          );
          return;
        }
        sendHtml(res, renderHandoffPage(store));
        return;
      }
      if (method === "GET" && path === "/checks") {
        if (!isHtmlRequest(req)) {
          sendJson(res, json("ok", store.listCheckRuns(20)));
          return;
        }
        sendHtml(res, renderChecksPage(store));
        return;
      }
      if (method === "GET" && path === "/memory") {
        if (!isHtmlRequest(req)) {
          sendJson(
            res,
            json("ok", {
              projects: store.listProjects().map((project) => ({
                project,
                lessons: store.listProjectLessons(project.id, 5),
                rules: store.listProjectRules(project.id, 5),
                memory: store.listProjectMemory(project.id, 5),
              })),
            }),
          );
          return;
        }
        sendHtml(res, renderMemoryPage(store));
        return;
      }
      if (method === "GET" && path === "/retrieval") {
        if (!isHtmlRequest(req)) {
          sendJson(
            res,
            json("ok", {
              projects: store.listProjects(),
              recentLessons: store.listRecentLessons(20),
            }),
          );
          return;
        }
        sendHtml(res, renderRetrievalPage(store));
        return;
      }
      if (method === "GET" && path === "/reviews") {
        if (!isHtmlRequest(req)) {
          sendJson(res, json("ok", store.listReviews(undefined, 20)));
          return;
        }
        sendHtml(res, renderReviewsPage(store));
        return;
      }
      if (path.startsWith("/reviews/")) {
        const reviewId = decodeURIComponent(path.slice("/reviews/".length)).split("/")[0];
        if (method === "GET") {
          if (!isHtmlRequest(req)) {
            sendJson(res, json("ok", store.getReview(reviewId)));
            return;
          }
          sendHtml(res, renderReviewDetailPage(store, reviewId));
          return;
        }
      }
      if (method === "GET" && path === "/models") {
        if (!isHtmlRequest(req)) {
          sendJson(res, json("ok", { usage: store.listModelUsage(50), settings: store.getSettings(config) }));
          return;
        }
        sendHtml(res, renderModelsPage(store, config));
        return;
      }
      if (method === "GET" && path === "/mcp") {
        if (!isHtmlRequest(req)) {
          sendJson(res, json("ok", store.listMcpCalls(50)));
          return;
        }
        sendHtml(res, renderMcpPage(store));
        return;
      }
      if (method === "GET" && path === "/mcp/calls") {
        sendJson(res, json("ok", store.listMcpCalls(50)));
        return;
      }
      if (path.startsWith("/mcp/calls/")) {
        const callId = decodeURIComponent(path.slice("/mcp/calls/".length)).split("/")[0];
        if (method === "GET") {
          if (!isHtmlRequest(req)) {
            sendJson(res, json("ok", store.getMcpCall(callId)));
            return;
          }
          const call = store.getMcpCall(callId);
          if (!call) {
            sendHtml(
              res,
              pageShell("MCP call not found", `/mcp/calls/${callId}`, {
                contentHtml: renderCard("Missing call", `No MCP call found for <code>${escapeHtml(callId)}</code>.`),
                projects: store.listProjects(),
                projectCount: store.listProjects().length,
                sessionCount: store.listSessions(1000).length,
                activeSessionCount: store.dashboardSnapshot().activeSessions,
                liveStatus: "missing",
              }),
              404,
            );
            return;
          }
          const session = call.sessionId ? store.getSession(call.sessionId) : null;
          const project = call.projectId ? store.getProject(call.projectId) : null;
          sendHtml(
            res,
            pageShell(`MCP ${call.toolName}`, `/mcp/calls/${call.id}`, {
              contentHtml: [
                renderCard(
                  "Call Summary",
                  renderKeyValueList([
                    ["Tool", call.toolName],
                    ["Blocked", call.blocked ? "yes" : "no"],
                    ["Project", project ? project.name : call.projectId ?? "none"],
                    ["Session", session ? session.title : call.sessionId ?? "none"],
                    ["Created", call.createdAt],
                  ]),
                  6,
                ),
                renderCard("Input", `<pre>${escapeHtml(call.inputJson)}</pre>`, 6),
                renderCard("Output", `<pre>${escapeHtml(call.outputJson ?? "No output recorded.")}</pre>`, 12),
              ].join(""),
              rightPanelHtml: renderCard("Recent Trace", renderEventFeed(store.listEvents(call.sessionId ?? undefined, 40))),
              activeProjectId: project?.id ?? null,
              projects: store.listProjects(),
              projectCount: store.listProjects().length,
              sessionCount: store.listSessions(1000).length,
              activeSessionCount: store.dashboardSnapshot().activeSessions,
              liveStatus: call.blocked ? "blocked" : "ready",
            }),
          );
          return;
        }
      }
      if (method === "GET" && path === "/settings") {
        if (!isHtmlRequest(req)) {
          sendJson(res, json("ok", store.getSettings(config)));
          return;
        }
        sendHtml(res, renderSettingsPage(store, config));
        return;
      }

      // ---- Observability API: retrieval, memory, skills, models, agents, context, conversations, eval ----

      if (path.startsWith("/symbols/") && method === "GET") {
        const symbolId = decodeURIComponent(path.slice("/symbols/".length)).split("/")[0];
        if (!symbolId) {
          sendJson(res, json("error", undefined, { message: "symbol id required" }), 400);
          return;
        }
        const symbol = store.codeIntelligence.getSymbol(symbolId);
        if (!symbol) {
          sendJson(res, json("error", undefined, { message: "symbol not found" }), 404);
          return;
        }
        const project = store.getProject(symbol.projectId);
        const chunks = store.codeIntelligence.listSymbolChunks(symbolId);
        const edges = store.codeIntelligence.listEdgesForSymbol(symbolId);
        const relatedSymbolIds = new Set<string>();
        for (const edge of edges) {
          if (edge.fromSymbolId !== symbolId) {
            relatedSymbolIds.add(edge.fromSymbolId);
          }
          if (edge.toSymbolId !== symbolId) {
            relatedSymbolIds.add(edge.toSymbolId);
          }
        }
        const relatedSymbols = Array.from(relatedSymbolIds)
          .map((id) => store.codeIntelligence.getSymbol(id))
          .filter((item): item is NonNullable<typeof item> => Boolean(item));
        sendJson(
          res,
          json("ok", {
            projectId: symbol.projectId,
            filePath: symbol.path,
            projectPath: project?.path ?? null,
            // deprecated: old consumers expected the symbol path here
            symbolPath: symbol.path,
            project: project ? { id: project.id, path: project.path, name: project.name } : null,
            symbol,
            chunks,
            edges,
            relatedSymbols,
          }),
        );
        return;
      }

      if (method === "GET" && path === "/retrieval/queries") {

        const sessionId = url.searchParams.get("sessionId");
        const projectId = url.searchParams.get("projectId");
        const limit = Number(url.searchParams.get("limit") ?? "50") || 50;
        const queries = sessionId
          ? store.retrieval.listQueriesForSession(sessionId, limit)
          : projectId
            ? store.retrieval.listQueriesForProject(projectId, limit)
            : store.retrieval.listQueriesForProject(
                store.listProjects()[0]?.id ?? "",
                limit,
              ).slice(0, 0);
        sendJson(res, json("ok", queries));
        return;
      }
      if (path.startsWith("/retrieval/queries/")) {
        const id = decodeURIComponent(path.slice("/retrieval/queries/".length)).split("/")[0];
        if (method === "GET") {
          const query = store.retrieval.getQuery(id);
          if (!query) {
            sendJson(res, json("error", undefined, { message: "retrieval query not found" }), 404);
            return;
          }
          sendJson(
            res,
            json("ok", {
              query,
              rewrites: store.retrieval.listRewrites(id),
              results: store.retrieval.listResults(id),
              selected: store.retrieval.listSelectedContext(id),
              misses: store.retrieval.listMisses(id),
              feedback: store.retrieval.listFeedback(id),
            }),
          );
          return;
        }
      }

      if (method === "GET" && path === "/memory/candidates") {
        const status = url.searchParams.get("status") as "pending" | "accepted" | "rejected" | null;
        const projectId = url.searchParams.get("projectId");
        sendJson(
          res,
          json("ok", store.memory.listCandidates(status ?? "pending", projectId, 100)),
        );
        return;
      }
      if (path.startsWith("/memory/candidates/") && method === "POST") {
        const tail = decodeURIComponent(path.slice("/memory/candidates/".length));
        const [id, action] = tail.split("/");
        if (action === "accept") {
          const body = (await readJsonBody(request, req)) as { notes?: string } | null;
          const entry = store.memory.acceptCandidate(id, body?.notes ?? null);
          sendJson(res, json("ok", entry));
          return;
        }
        if (action === "reject") {
          const body = (await readJsonBody(request, req)) as { reason?: string } | null;
          store.memory.reviewCandidate(id, "rejected", body?.reason ?? null);
          sendJson(res, json("ok", { id, status: "rejected" }));
          return;
        }
        sendJson(res, json("error", undefined, { message: `unknown action: ${action ?? ""}` }), 400);
        return;
      }
      if (method === "GET" && path === "/memory/entries") {
        const projectId = url.searchParams.get("projectId");
        const scope = url.searchParams.get("scope") as
          | "global" | "project" | "repo" | "path" | null;
        sendJson(res, json("ok", store.memory.listEntries(projectId, scope ?? undefined, 100)));
        return;
      }
      if (method === "GET" && path === "/memory/facts") {
        const projectId = url.searchParams.get("projectId");
        const project = projectId ? store.getProject(projectId) : null;
        if (projectId && !project) {
          sendJson(res, json("ok", []));
          return;
        }
        sendJson(res, json("ok", store.memory.listFacts(project?.id ?? null, 100)));
        return;
      }
      if (method === "GET" && path === "/memory/rules") {
        const projectId = url.searchParams.get("projectId");
        if (!projectId) {
          sendJson(res, json("ok", []));
          return;
        }
        sendJson(res, json("ok", store.memory.listProjectRules(projectId, 100)));
        return;
      }

      if (method === "GET" && path === "/skills/candidates") {
        const status = url.searchParams.get("status") as "pending" | "active" | "deprecated" | "rejected" | null;
        sendJson(
          res,
          json("ok", store.skills.listCandidates(status ?? undefined, 100)),
        );
        return;
      }
      if (path.startsWith("/skills/candidates/") && method === "POST") {
        const tail = decodeURIComponent(path.slice("/skills/candidates/".length));
        const [id, action] = tail.split("/");
        if (action === "accept") {
          const skill = store.skills.acceptCandidate(id);
          sendJson(res, json("ok", skill));
          return;
        }
        if (action === "reject") {
          const body = (await readJsonBody(request, req)) as { reason?: string } | null;
          store.skills.reviewCandidate(id, "rejected");
          sendJson(res, json("ok", { id, status: "rejected", reason: body?.reason ?? null }));
          return;
        }
        sendJson(res, json("error", undefined, { message: `unknown action: ${action ?? ""}` }), 400);
        return;
      }
      if (method === "GET" && path === "/skills") {
        sendJson(res, json("ok", store.skills.listSkills()));
        return;
      }

      if (method === "GET" && path === "/models/providers") {
        sendJson(
          res,
          json("ok", {
            providers: store.models.listProviders(),
            profiles: store.models.listProfiles(),
          }),
        );
        return;
      }
      if (method === "GET" && path === "/models/routes") {
        sendJson(res, json("ok", store.listModelRoutes(100)));
        return;
      }
      if (method === "POST" && path === "/models/route") {
        const body = (req.headers?.["content-type"]?.includes("application/json")
          ? await readJsonBody(request, req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(request, req)))) as Record<string, unknown>;
        const selectedProfileId = store.recommendModelProfile(
          body.mode === "cloud" || body.mode === "hybrid" || body.mode === "local" ? body.mode : "any",
          {
            risk: body.risk === "low" || body.risk === "medium" || body.risk === "high" ? body.risk : undefined,
            depth: body.depth === "shallow" || body.depth === "standard" || body.depth === "deep" ? body.depth : undefined,
            question: body.question ? String(body.question) : undefined,
            goal: body.goal ? String(body.goal) : undefined,
          },
        );
        const route = store.recordModelRoute({
          taskPattern: String(body.taskPattern ?? body.task ?? "ask"),
          mode: body.mode === "cloud" || body.mode === "hybrid" || body.mode === "local" ? body.mode : "any",
          selectedProfileId,
          fallbackProfileId: body.fallbackProfileId ? String(body.fallbackProfileId) : null,
          reason: body.reason ? String(body.reason) : null,
        });
        sendJson(
          res,
          json("ok", {
            route,
            profile: store.models.getProfile(selectedProfileId),
          }),
        );
        return;
      }
      if (method === "GET" && path === "/models/calls") {
        const limit = Number(url.searchParams.get("limit") ?? "50") || 50;
        sendJson(res, json("ok", store.models.listAllCalls(limit)));
        return;
      }
      if (method === "POST" && path === "/models/health/check") {
        const body = (req.headers?.["content-type"]?.includes("application/json")
          ? await readJsonBody(request, req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(request, req)))) as Record<string, unknown>;
        const providerId = String(body.providerId ?? "");
        if (!providerId) {
          sendJson(res, json("error", undefined, { message: "providerId is required" }), 400);
          return;
        }
        const profileId = body.profileId ? String(body.profileId) : null;
        const status = body.status === "healthy" || body.status === "degraded" || body.status === "unreachable" || body.status === "disabled"
          ? body.status
          : "healthy";
        const check = store.models.recordHealthCheck({
          providerId,
          profileId,
          status,
          latencyMs: body.latencyMs == null ? null : Number(body.latencyMs),
          detail: body.detail ? String(body.detail) : null,
        });
        sendJson(res, json("ok", check));
        return;
      }
      if (method === "GET" && path === "/models/health") {
        const providers = store.models.listProviders();
        const profiles = store.models.listProfiles();
        const recentCalls = store.models.listAllCalls(20);
        const profileById = new Map(profiles.map((p) => [p.id, p]));
        const lastByProvider = new Map<string, typeof recentCalls[number]>();
        for (const call of recentCalls) {
          const profile = profileById.get(call.profileId);
          if (!profile) continue;
          if (!lastByProvider.has(profile.providerId)) {
            lastByProvider.set(profile.providerId, call);
          }
        }
        const providersWithHealth = providers.map((p) => ({
          ...p,
          lastCall: lastByProvider.get(p.id) ?? null,
        }));
        sendJson(
          res,
          json("ok", { providers: providersWithHealth, recentCalls }),
        );
        return;
      }

      if (method === "GET" && path === "/agents/runs") {
        const sessionId = url.searchParams.get("sessionId");
        if (!sessionId) {
          sendJson(res, json("ok", []));
          return;
        }
        sendJson(res, json("ok", store.agents.listRuns(sessionId, 200)));
        return;
      }
      if (path.startsWith("/agents/runs/") && method === "GET") {
        const id = decodeURIComponent(path.slice("/agents/runs/".length)).split("/")[0];
        const run = store.agents.getRun(id);
        if (!run) {
          sendJson(res, json("error", undefined, { message: "agent run not found" }), 404);
          return;
        }
        sendJson(
          res,
          json("ok", { run, messages: store.agents.listMessages(id) }),
        );
        return;
      }
      if (method === "GET" && path === "/agents/handoffs") {
        const sessionId = url.searchParams.get("sessionId");
        sendJson(
          res,
          json("ok", sessionId ? store.agents.listHandoffs(sessionId, 100) : store.agents.listAllHandoffs(100)),
        );
        return;
      }

      if (method === "GET" && path === "/context/packs") {
        const sessionId = url.searchParams.get("sessionId");
        if (!sessionId) {
          sendJson(res, json("ok", []));
          return;
        }
        sendJson(res, json("ok", store.context.listPacksForSession(sessionId, 50)));
        return;
      }
      if (path.startsWith("/context/packs/") && method === "GET") {
        const id = decodeURIComponent(path.slice("/context/packs/".length)).split("/")[0];
        const pack = store.context.getPack(id);
        if (!pack) {
          sendJson(res, json("error", undefined, { message: "context pack not found" }), 404);
          return;
        }
        sendJson(
          res,
          json("ok", {
            pack,
            items: store.context.listItems(id),
            budgetEvents: store.context.listBudgetEvents(id),
          }),
        );
        return;
      }

      if (path.startsWith("/conversations/") && method === "GET") {
        const sessionId = decodeURIComponent(path.slice("/conversations/".length)).split("/")[0];
        sendJson(res, json("ok", store.conversation.listMessages(sessionId, 200)));
        return;
      }

      if (method === "GET" && path === "/eval/cases") {
        const projectId = url.searchParams.get("projectId");
        const cases = projectId
          ? store.evals.listCases().filter((c) => c.projectId === projectId)
          : store.evals.listCases();
        sendJson(res, json("ok", cases));
        return;
      }
      if (method === "POST" && path === "/eval/cases") {
        const body = (await readJsonBody(request, req)) as {
          projectId?: string;
          question: string;
          expectedAnswerContains?: string;
          expectedFiles?: string[];
          tags?: string[];
        };
        if (!body.question) {
          sendJson(res, json("error", undefined, { message: "question is required" }), 400);
          return;
        }
        const created = store.evals.addCase({
          projectId: body.projectId ?? null,
          question: body.question,
          expectedAnswerContains: body.expectedAnswerContains ?? null,
          expectedFiles: body.expectedFiles ?? [],
          tags: body.tags ?? [],
        });
        sendJson(res, json("ok", created));
        return;
      }
      if (method === "GET" && path === "/eval/answers") {
        sendJson(res, json("ok", store.evals.listAnswerEvaluations(100)));
        return;
      }
      if (method === "GET" && path === "/eval/outcomes") {
        const sessionId = url.searchParams.get("sessionId");
        sendJson(
          res,
          json("ok", sessionId ? store.evals.listOutcomes(sessionId) : store.evals.listAllOutcomes(100)),
        );
        return;
      }

      sendHtml(
        res,
        pageShell("Not Found", path, {
          contentHtml: renderCard("Not Found", `No route matched <code>${escapeHtml(path)}</code>.`),
          projects: store.listProjects(),
          projectCount: store.listProjects().length,
          sessionCount: store.listSessions(1000).length,
          activeSessionCount: store.dashboardSnapshot().activeSessions,
          liveStatus: "missing",
        }),
        404,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isHtmlRequest(req)) {
        sendHtml(res, pageShell("Error", path, {
          contentHtml: renderCard("Request failed", `<pre>${escapeHtml(message)}</pre>`),
          projects: store.listProjects(),
          projectCount: store.listProjects().length,
          sessionCount: store.listSessions(1000).length,
          activeSessionCount: store.dashboardSnapshot().activeSessions,
          liveStatus: "error",
        }), 500);
        return;
      }
      sendJson(res, json("error", undefined, { message }), 500);
      }
    })().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        if (isHtmlRequest(req)) {
          sendHtml(res, pageShell("Error", path, {
            contentHtml: renderCard("Request failed", `<pre>${escapeHtml(message)}</pre>`),
            projects: store.listProjects(),
            projectCount: store.listProjects().length,
            sessionCount: store.listSessions(1000).length,
            activeSessionCount: store.dashboardSnapshot().activeSessions,
            liveStatus: "error",
          }), 500);
          return;
        }
        sendJson(res, json("error", undefined, { message }), 500);
      }
    });
  });

  const inject = async (input: { method: string; url: string; headers?: Record<string, string>; body?: unknown }) => {
    const headers = {
      accept: "application/json",
      ...(input.body === undefined ? input.headers : { "content-type": "application/json", ...input.headers }),
    };
    const method = input.method.toUpperCase() as "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";
    const response = await app.inject({
      method,
      url: input.url,
      headers,
      payload: input.body === undefined ? undefined : JSON.stringify(input.body),
    });
    return { statusCode: response.statusCode, body: response.body };
  };

  if (options.inProcess) {
    await app.ready();
    return {
      url: "http://in-process",
      inject,
      close: () => app.close(),
    };
  }

  const port = config.apiPort;
  await app.listen({ port, host: "127.0.0.1" });
  const address = app.server.address();
  const actualPort = address && typeof address === "object" ? address.port : port;

  return {
    url: `http://127.0.0.1:${actualPort}`,
    inject,
    close: () => app.close(),
  };
}
