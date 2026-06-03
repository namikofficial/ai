import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import type { AskRequest, ConfigSnapshot, EventEnvelope, HandoffRequest, PlanRequest, ProjectSummary } from "../../../packages/shared/src/index.ts";
import { createEvent, parseAskRequest, parseProjectCreateInput } from "../../../packages/shared/src/index.ts";
import { resolveConfig } from "../../../packages/config/src/index.ts";
import { initializeStore, createStore } from "../../../packages/db/src/store.ts";
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

export interface ServerOptions {
  config?: Partial<ConfigSnapshot>;
}

export interface ServerHandle {
  url: string;
  close(): Promise<void>;
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

async function readJsonBody(req: any): Promise<unknown> {
  let body = "";
  for await (const chunk of req) {
    body += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
  }
  if (body.trim().length === 0) return {};
  return JSON.parse(body);
}

async function readTextBody(req: any): Promise<string> {
  let body = "";
  for await (const chunk of req) {
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
      ]),
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
      ]),
      6,
    ),
    renderCard(
      "Final Summary",
      `<pre>${escapeHtml(session.finalSummary ?? "No final summary yet.")}</pre>`,
      6,
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
      `<div class="list">${reviews.length > 0 ? reviews.map((review) => `<div class="list-item"><div class="row"><strong>${escapeHtml(review.title)}</strong><span class="badge">${escapeHtml(review.createdAt)}</span></div><div class="tiny">${escapeHtml(review.summary)}</div></div>`).join("") : renderEmptyState("No reviews yet", "Review history will accumulate here.")}</div>`,
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
      `<div class="list">${calls.length > 0 ? calls.map((call) => `<div class="list-item"><div class="row"><strong>${escapeHtml(call.toolName)}</strong><span class="badge" data-tone="${call.blocked ? "bad" : "good"}">${call.blocked ? "blocked" : "allowed"}</span></div><div class="tiny">${escapeHtml(call.inputJson)}</div></div>`).join("") : renderEmptyState("No calls yet", "MCP calls will be logged here.")}</div>`,
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
  const db = initializeStore(config.databasePath);
  const store = createStore(db);
  await store.ensureRuntimeDirs(config.runtimeDir);

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

  const server = createServer((req: any, res: any) => {
    void (async () => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = String(req.method ?? "GET").toUpperCase();
    const path = url.pathname;

    try {
      if (method === "GET" && path === "/health") {
        sendJson(res, json("ok", { uptime: process.uptime(), databasePath: config.databasePath }));
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
        sendJson(
          res,
          json("ok", {
            health: { uptime: process.uptime(), databasePath: config.databasePath },
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
          ? await readJsonBody(req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(req)))) as Record<string, unknown>;
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
            ? await readJsonBody(req)
            : Object.fromEntries(new URLSearchParams(await readTextBody(req)))) as Record<string, unknown>;
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
          ? await readJsonBody(req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(req)))) as Record<string, unknown>;
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
          ? await readJsonBody(req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(req)))) as Record<string, unknown>;
        const normalized: PlanRequest = {
          project: String(body.project ?? ""),
          goal: String(body.goal ?? ""),
          risk: body.risk === "low" || body.risk === "medium" || body.risk === "high" ? body.risk : "medium",
        };
        const result = store.createPlan(normalized);
        if (isHtmlRequest(req)) {
          sendHtml(res, renderPlannerPage(store, { result: result.response }));
        } else {
          sendJson(res, json("ok", result.response));
        }
        return;
      }

      if (method === "POST" && path === "/research") {
        const body = (req.headers?.["content-type"]?.includes("application/json")
          ? await readJsonBody(req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(req)))) as Record<string, unknown>;
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
          ? await readJsonBody(req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(req)))) as Record<string, unknown>;
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
        const result = store.createHandoff(normalized);
        if (isHtmlRequest(req)) {
          sendHtml(res, renderHandoffPage(store, { result }));
        } else {
          sendJson(res, json("ok", result));
        }
        return;
      }

      if (method === "POST" && path === "/checks/run") {
        const body = (req.headers?.["content-type"]?.includes("application/json")
          ? await readJsonBody(req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(req)))) as Record<string, unknown>;
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
          ? await readJsonBody(req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(req)))) as Record<string, unknown>;
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
          ? await readJsonBody(req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(req)))) as Record<string, unknown>;
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
          ? await readJsonBody(req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(req)))) as Record<string, unknown>;
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
        if (isHtmlRequest(req)) {
          sendHtml(res, renderReviewsPage(store, { result }));
        } else {
          sendJson(res, json("ok", result));
        }
        return;
      }

      if (method === "POST" && path === "/retrieval/search") {
        const body = (req.headers?.["content-type"]?.includes("application/json")
          ? await readJsonBody(req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(req)))) as Record<string, unknown>;
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
          ? await readJsonBody(req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(req)))) as Record<string, unknown>;
        const projectId = String(body.project ?? body.projectId ?? "");
        const query = String(body.query ?? "");
        const chunks = store.searchChunks(projectId, query, { limit: Number(body.limit ?? 8) || 8 });
        const explanation = {
          query,
          projectId,
          evidenceCount: chunks.length,
          topPaths: chunks.slice(0, 3).map((chunk) => chunk.path),
          confidence: chunks.length === 0 ? 0 : chunks[0].score / 8,
          chunks,
        };
        sendJson(res, json("ok", explanation));
        return;
      }

      if (method === "POST" && path === "/retrieval/context") {
        const body = (req.headers?.["content-type"]?.includes("application/json")
          ? await readJsonBody(req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(req)))) as Record<string, unknown>;
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
      if (method === "GET" && path === "/settings") {
        if (!isHtmlRequest(req)) {
          sendJson(res, json("ok", store.getSettings(config)));
          return;
        }
        sendHtml(res, renderSettingsPage(store, config));
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
    })();
  });

  const port = config.webPort;
  await new Promise<void>((resolveListen) => {
    server.listen(port, "127.0.0.1", () => resolveListen());
  });

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}
