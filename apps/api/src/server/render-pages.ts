import type { ProjectContextGraph } from "../../../../packages/code-intelligence/src/index.ts";
import { resolveProjectConfig } from "../../../../packages/config/src/index.ts";
import { createStore } from "../../../../packages/db/src/store.ts";
import type {
  CompiledPromptRecord,
  ConfigSnapshot,
  ProjectSummary,
} from "../../../../packages/shared/src/index.ts";
import { buildSessionTimeline } from "../../../../packages/timeline/src/index.ts";
import {
  renderCard,
  renderEmptyState,
  renderEventFeed,
  renderKeyValueList,
  renderProjectItem,
  renderSessionItem,
  renderShell,
  renderTaskItem,
} from "../../../../packages/ui/src/index.ts";
import { safeParseJson, safeParseList } from "./http.ts";

type Store = ReturnType<typeof createStore>;

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "\u0026amp;")
    .replaceAll("<", "\u0026lt;")
    .replaceAll(">", "\u0026gt;")
    .replaceAll('"', "\u0026quot;")
    .replaceAll("'", "\u0026#39;");
}

export function pageShell(
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
  }
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

export function renderDashboard(store: Store, route = "/dashboard"): string {
  const dashboard = store.dashboardSnapshot();
  const projects = store.listProjects();
  const events = store.listEvents(undefined, 40);
  const contentHtml = [
    renderCard("Projects", `<div class="kpi"><div class="value">${dashboard.projects}</div><div class="label">Indexed projects in the local store</div></div>`, 4),
    renderCard("Active Sessions", `<div class="kpi"><div class="value">${dashboard.activeSessions}</div><div class="label">Running, queued, or paused</div></div>`, 4),
    renderCard("Recent Lessons", `<div class="kpi"><div class="value">${dashboard.recentLessons.length}</div><div class="label">Captured memory entries</div></div>`, 4),
    renderCard("Projects", `<div class="list">${projects.length > 0 ? projects.map(renderProjectItem).join("") : renderEmptyState("No projects yet", "Add a repo to begin indexing.")}</div>`, 8),
    renderCard("Recent Sessions", `<div class="list">${dashboard.recentSessions.length > 0 ? dashboard.recentSessions.map(renderSessionItem).join("") : renderEmptyState("No sessions yet", "Ask a question or index a repo to create one.")}</div>`, 4),
    renderCard(
      "Recent Lessons",
      `<div class="list">${dashboard.recentLessons.length > 0 ? dashboard.recentLessons.map((lesson) => `<div class="list-item"><strong>${escapeHtml(lesson.title)}</strong><div class="tiny">${escapeHtml(lesson.body)}</div></div>`).join("") : renderEmptyState("No lessons yet", "Answers and indexing runs will populate memory.")}</div>`,
      6
    ),
    renderCard(
      "Checks",
      `<div class="list">${dashboard.recentChecks.length > 0 ? dashboard.recentChecks.map((check) => `<div class="list-item"><strong>${escapeHtml(check.name)}</strong><div class="tiny">${escapeHtml(check.status)}</div></div>`).join("") : renderEmptyState("No checks yet", "Allowlisted checks will show up here.")}</div>`,
      6
    ),
  ].join("");

  return pageShell("Dashboard", route, {
    contentHtml,
    rightPanelHtml: renderCard("Event Stream", renderEventFeed(events)),
    projects,
    projectCount: dashboard.projects,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: dashboard.activeSessions,
    liveStatus: "healthy",
  });
}

export function renderProjectsPage(store: Store): string {
  const projects = store.listProjects();
  const contentHtml = [
    renderCard("Projects", `<div class="stack">${projects.length > 0 ? projects.map(renderProjectItem).join("") : renderEmptyState("No projects yet", "Use the CLI to add a repo path.")}</div>`, 8),
    renderCard(
      "Add Project",
      `<form method="post" action="/projects" class="stack">
        <input name="path" placeholder="/home/namik/Documents/code/noxcrm" />
        <input name="name" placeholder="optional display name" />
        <button type="submit">Add project</button>
      </form>`,
      4
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

export function renderProjectDetailPage(store: Store, projectId: string, graph: ProjectContextGraph | null): string {
  const project = store.getProject(projectId);
  if (!project) {
    return renderNotFoundPage(store, `/projects/${projectId}`, "Missing project", `No project found for <code>${escapeHtml(projectId)}</code>.`);
  }

  const files = store.listProjectFiles(project.id, 20);
  const chunks = store.listProjectChunks(project.id, 10);
  const sessions = store.listProjectSessions(project.id, 8);
  const lessons = store.listProjectLessons(project.id, 8);
  const symbols = store.codeIntelligence.listSymbols(project.id, null, 10);
  const symbolCount = { count: store.codeIntelligence.countSymbols(project.id) };

  const contentHtml = [
    renderCard("Project Summary", renderKeyValueList([["Path", project.path], ["Language", project.language ?? "unknown"], ["Framework", project.framework ?? "unknown"], ["Status", project.status], ["Files", String(project.fileCount)], ["Chunks", String(project.chunkCount)], ["Symbols", String(symbolCount.count)]]), 6),
    renderCard("Context Graph", graph ? renderKeyValueList([["Entrypoints", String(graph.entrypoints.length)], ["Routes", graph.routeFiles.slice(0, 3).join(", ")], ["Middleware", graph.middlewareFiles.slice(0, 3).join(", ")], ["DB/Auth", [...graph.dbFiles, ...graph.authPaths].slice(0, 3).join(", ")]]) : renderEmptyState("No graph yet", "Context graph is built during indexing."), 6),
    renderCard("Top Symbols", `<div class="list">${symbols.length > 0 ? symbols.map((s) => `<div class="list-item"><strong>${escapeHtml(s.name)}</strong><div class="tiny">${escapeHtml(s.kind)} · ${escapeHtml(s.path)}</div></div>`).join("") : renderEmptyState("No symbols", "Symbols are extracted during indexing.")}</div><div class="tiny" style="margin-top:8px"><a href="/projects/${encodeURIComponent(project.id)}/symbols">View all symbols</a></div>`, 6),
    renderCard("Files", `<div class="list">${files.length > 0 ? files.map((file) => `<div class="list-item"><div class="row"><strong>${escapeHtml(file.path)}</strong><span class="badge">${file.isIndexed ? "indexed" : "pending"}</span></div><div class="tiny">${escapeHtml(file.language ?? "unknown")} · ${file.sizeBytes} bytes</div></div>`).join("") : renderEmptyState("No files yet", "Index the project to populate file metadata.")}</div>`, 6),
    renderCard("Chunks", `<div class="list">${chunks.length > 0 ? chunks.map((chunk) => `<div class="list-item"><strong>${escapeHtml(chunk.path)}</strong><div class="tiny">Lines ${chunk.startLine}-${chunk.endLine} · score ${chunk.score.toFixed(1)}</div><pre>${escapeHtml(chunk.content.slice(0, 280))}</pre></div>`).join("") : renderEmptyState("No chunks yet", "Retrieval data appears after indexing.")}</div>`, 6),
    renderCard("Sessions", `<div class="list">${sessions.length > 0 ? sessions.map(renderSessionItem).join("") : renderEmptyState("No sessions yet", "Index or ask against this project to create traces.")}</div>`, 6),
    renderCard("Lessons", `<div class="list">${lessons.length > 0 ? lessons.map((lesson) => `<div class="list-item"><strong>${escapeHtml(lesson.title)}</strong><div class="tiny">${escapeHtml(lesson.body)}</div></div>`).join("") : renderEmptyState("No lessons yet", "Answer synthesis adds memory entries here.")}</div>`, 12),
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

export function renderSessionsPage(store: Store): string {
  const sessions = store.listSessions(100);
  return pageShell("Sessions", "/sessions", {
    contentHtml: renderCard("Sessions", `<div class="list">${sessions.length > 0 ? sessions.map(renderSessionItem).join("") : renderEmptyState("No sessions", "Ask a question or index a project to create one.")}</div>`, 8),
    rightPanelHtml: renderCard("Recent Events", renderEventFeed(store.listEvents(undefined, 40))),
    projects: store.listProjects(),
    projectCount: store.listProjects().length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: "streaming",
  });
}

export function renderSessionDetailPage(store: Store, sessionId: string): string {
  const session = store.getSession(sessionId);
  if (!session) {
    return renderNotFoundPage(store, `/sessions/${sessionId}`, "Missing session", `No session found for <code>${escapeHtml(sessionId)}</code>.`);
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
    renderCard("Session Summary", renderKeyValueList([["Title", session.title], ["Goal", session.userGoal], ["Status", session.status], ["Mode", session.mode], ["Source", session.source], ["Started", session.startedAt], ["Finished", session.finishedAt ?? "running"], ["Model Calls", String(timeline.counts.modelCalls)], ["Retrivals", String(timeline.counts.retrievalQueries)]]), 6),
    renderCard("Final Summary", `<pre>${escapeHtml(session.finalSummary ?? "No final summary yet.")}</pre>`, 6),
    renderCard("Timeline", `<div class="list">${timeline.items.length > 0 ? timeline.items.map((item) => `<div class="list-item"><strong>${escapeHtml(item.kind)}: ${escapeHtml(item.title)}</strong><div class="tiny">${escapeHtml(item.summary)}</div></div>`).join("") : renderEmptyState("Empty timeline", "No events captured for this session yet.")}</div>`, 12),
    renderCard("Tasks", `<div class="list">${tasks.length > 0 ? tasks.map((task) => `<a href="/tasks/${encodeURIComponent(task.id)}" style="display:block">${renderTaskItem(task)}</a>`).join("") : renderEmptyState("No tasks yet", "Plans and worker jobs create task records here.")}</div>`, 12),
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

export function renderCompiledPromptItem(prompt: CompiledPromptRecord): string {
  return `<div class="list-item"><div class="row"><strong>${escapeHtml(prompt.mode)}</strong><span class="badge">${escapeHtml(prompt.role)}</span></div><div class="tiny">${escapeHtml(prompt.id)}${prompt.sessionId ? ` · session ${escapeHtml(prompt.sessionId)}` : ""}</div><div class="tiny">${escapeHtml(String(prompt.estimatedTokens))} tokens · ${escapeHtml(prompt.createdAt)}</div></div>`;
}

export function renderCompiledPromptPage(store: Store, promptId: string): string {
  const prompt = store.getCompiledPrompt(promptId);
  if (!prompt) {
    return renderNotFoundPage(store, `/prompts/${promptId}`, "Missing prompt", `No compiled prompt found for <code>${escapeHtml(promptId)}</code>.`);
  }
  const messages = safeParseJson(prompt.messagesJson);
  const includedContext = safeParseJson(prompt.includedContextJson);
  const omittedContext = safeParseJson(prompt.omittedContextJson);
  const safetyNotes = safeParseJson(prompt.safetyNotesJson);
  const outputSchema = prompt.outputSchemaJson ? safeParseJson(prompt.outputSchemaJson) : null;

  return pageShell(`Prompt ${prompt.id}`, `/prompts/${prompt.id}`, {
    contentHtml: [
      renderCard("Prompt Summary", renderKeyValueList([["Mode", prompt.mode], ["Role", prompt.role], ["Tokens", String(prompt.estimatedTokens)], ["Session", prompt.sessionId ?? "none"], ["Task", prompt.taskId ?? "none"], ["Retrieval Query", prompt.retrievalQueryId ?? "none"], ["Context Pack", prompt.contextPackId ?? "none"], ["Created", prompt.createdAt]]), 6),
      renderCard("Messages", `<pre>${escapeHtml(JSON.stringify(messages, null, 2))}</pre>`, 6),
      renderCard("Included Context", `<pre>${escapeHtml(JSON.stringify(includedContext, null, 2))}</pre>`, 6),
      renderCard("Omitted Context", `<pre>${escapeHtml(JSON.stringify(omittedContext, null, 2))}</pre>`, 6),
      renderCard("Safety Notes", `<pre>${escapeHtml(JSON.stringify(safetyNotes, null, 2))}</pre>`, 6),
      renderCard("Output Schema", `<pre>${escapeHtml(JSON.stringify(outputSchema, null, 2))}</pre>`, 6),
    ].join(""),
    rightPanelHtml: renderCard("Prompt Trace", `<div class="stack">${renderCompiledPromptItem(prompt)}</div>`),
    projects: store.listProjects(),
    projectCount: store.listProjects().length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: "ready",
  });
}

export function renderPromptsPage(store: Store, sessionId?: string | null): string {
  const prompts = store.listCompiledPrompts(sessionId ?? null, 100);
  return pageShell("Prompts", `/prompts${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`, {
    contentHtml: renderCard("Compiled Prompts", `<div class="list">${prompts.length > 0 ? prompts.map((prompt) => `<a href="/prompts/${encodeURIComponent(prompt.id)}" style="display:block">${renderCompiledPromptItem(prompt)}</a>`).join("") : renderEmptyState("No prompts yet", "Ask a question or run a plan to create compiled prompts.")}</div>`, 12),
    rightPanelHtml: renderCard("Prompt Filter", renderKeyValueList([["Session", sessionId ?? "all"], ["Count", String(prompts.length)]])),
    projects: store.listProjects(),
    projectCount: store.listProjects().length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: "ready",
  });
}

export function renderTasksPage(store: Store): string {
  const tasks = store.listRecentTasks(40);
  const byStatus = tasks.reduce<Record<string, number>>((acc, task) => {
    acc[task.status] = (acc[task.status] ?? 0) + 1;
    return acc;
  }, {});
  return pageShell("Tasks", "/tasks", {
    contentHtml: [
      renderCard("Recent Tasks", `<div class="list">${tasks.length > 0 ? tasks.map((task) => `<a href="/tasks/${encodeURIComponent(task.id)}" style="display:block">${renderTaskItem(task)}</a>`).join("") : renderEmptyState("No tasks yet", "Plans and worker jobs will appear here.")}</div>`, 8),
      renderCard("Task Summary", renderKeyValueList([["Queued", String(byStatus.queued ?? 0)], ["Running", String(byStatus.running ?? 0)], ["Completed", String(byStatus.completed ?? 0)], ["Failed", String(byStatus.failed ?? 0)]]), 4),
    ].join(""),
    rightPanelHtml: renderCard("Recent Trace", renderEventFeed(store.listEvents(undefined, 40))),
    projects: store.listProjects(),
    projectCount: store.listProjects().length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: "ready",
  });
}

export function renderTaskDetailPage(store: Store, taskId: string): string {
  const task = store.getTask(taskId);
  if (!task) {
    return renderNotFoundPage(store, `/tasks/${taskId}`, "Missing task", `No task found for <code>${escapeHtml(taskId)}</code>.`);
  }
  const session = store.getSession(task.sessionId);
  const project = session?.projectId ? store.getProject(session.projectId) : null;
  const events = store.listEvents(task.sessionId, 100).filter((event) => event.taskId === task.id || event.taskId == null);
  const expectedFiles = safeParseList(task.expectedFilesJson);
  const actualFiles = safeParseList(task.actualFilesJson);
  const checks = safeParseList(task.checksJson);
  const result = task.resultJson.trim() && task.resultJson.trim() !== "{}" ? task.resultJson : "No result recorded yet.";

  return pageShell(task.title, `/tasks/${task.id}`, {
    contentHtml: [
      renderCard("Task Summary", renderKeyValueList([["Title", task.title], ["Description", task.description], ["Type", task.type], ["Status", task.status], ["Risk", task.risk], ["Priority", String(task.priority)], ["Session", session ? session.title : task.sessionId], ["Project", project ? project.name : "unknown"]]), 6),
      renderCard("Actions", `<div class="stack"><form method="post" action="/tasks/${encodeURIComponent(task.id)}/start"><button type="submit">Start task</button></form><form method="post" action="/tasks/${encodeURIComponent(task.id)}/complete" class="stack"><textarea name="result" placeholder="completion notes"></textarea><button type="submit">Complete task</button></form><form method="post" action="/tasks/${encodeURIComponent(task.id)}/fail" class="stack"><textarea name="error" placeholder="failure notes"></textarea><button type="submit">Fail task</button></form></div>`, 6),
      renderCard("Expected Files", expectedFiles.length > 0 ? `<div class="list">${expectedFiles.map((file) => `<div class="list-item">${escapeHtml(file)}</div>`).join("")}</div>` : renderEmptyState("No expected files", "Planner-created tasks will list files here."), 4),
      renderCard("Actual Files", actualFiles.length > 0 ? `<div class="list">${actualFiles.map((file) => `<div class="list-item">${escapeHtml(file)}</div>`).join("")}</div>` : renderEmptyState("No actual files", "Update the task after edits land."), 4),
      renderCard("Checks", checks.length > 0 ? `<div class="list">${checks.map((check) => `<div class="list-item">${escapeHtml(check)}</div>`).join("")}</div>` : renderEmptyState("No checks", "Checks will be attached to the task graph."), 4),
      renderCard("Result", `<pre>${escapeHtml(result)}</pre>`, 12),
      renderCard("Event Timeline", renderEventFeed(events), 12),
    ].join(""),
    rightPanelHtml: renderCard("Task Events", renderEventFeed(events)),
    activeProjectId: project?.id ?? null,
    projects: store.listProjects(),
    projectCount: store.listProjects().length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: task.status,
  });
}

export function renderAskPage(store: Store, options: { result?: Awaited<ReturnType<Store["ask"]>>; error?: string; question?: string } = {}): string {
  const projects = store.listProjects();
  const selectOptions = projects.map((project) => `<option value="${escapeHtml(project.id)}"${options.result?.projectId === project.id ? " selected" : ""}>${escapeHtml(project.name)}</option>`).join("");
  return pageShell("Ask", "/ask", {
    contentHtml: [
      renderCard("Ask a Question", `<form method="post" action="/ask" class="stack"><select name="project">${selectOptions || `<option value="">Add a project first</option>`}</select><textarea name="question" placeholder="where is auth handled?">${escapeHtml(options.question ?? "")}</textarea><select name="depth"><option value="standard">Standard depth</option><option value="shallow">Shallow</option><option value="deep">Deep</option></select><button type="submit">Ask</button></form>`, 6),
      renderCard("Answer", options.result ? `<div class="list-item"><div class="badge" data-tone="${options.result.confidence > 0.65 ? "good" : options.result.confidence > 0.35 ? "warn" : "bad"}">confidence ${Math.round(options.result.confidence * 100)}%</div><pre>${escapeHtml(options.result.answer)}</pre></div>` : renderEmptyState("No answer yet", options.error ?? "Submit a question to see retrieved context and citations."), 6),
      renderCard("Citations", options.result && options.result.citations.length > 0 ? `<div class="list">${options.result.citations.map((citation) => `<div class="list-item"><strong>${escapeHtml(citation.path)}</strong><div class="tiny">Lines ${citation.startLine}-${citation.endLine} · score ${citation.score.toFixed(1)}</div><pre>${escapeHtml(citation.excerpt)}</pre></div>`).join("")}</div>` : renderEmptyState("No citations", "If retrieval misses, the response will say so explicitly."), 12),
    ].join(""),
    rightPanelHtml: renderCard("Recent Trace", renderEventFeed(store.listEvents(undefined, 40))),
    projects,
    projectCount: projects.length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: options.result ? "answered" : "ready",
  });
}

export function renderResearchPage(store: Store, options: { projectId?: string; topic?: string; mode?: string; result?: { summary: string; sources: Array<{ path: string; score: number; excerpt: string }>; contradictions: string[]; brief: string } } = {}): string {
  const projects = store.listProjects();
  const projectOptions = projects.map((project) => `<option value="${escapeHtml(project.id)}"${options.projectId === project.id ? " selected" : ""}>${escapeHtml(project.name)}</option>`).join("");
  return pageShell("Research", "/research", {
    contentHtml: [
      renderCard("Research Topic", `<form method="post" action="/research" class="stack"><select name="project">${projectOptions || `<option value="">Add a project first</option>`}</select><input name="topic" placeholder="authentication architecture" value="${escapeHtml(options.topic ?? "")}" /><select name="mode"><option value="local">Local only</option><option value="hybrid">Hybrid</option><option value="web">Web</option></select><button type="submit">Research</button></form>`, 6),
      renderCard("Summary", options.result ? `<pre>${escapeHtml(options.result.summary)}</pre>` : renderEmptyState("No research yet", "Run a topic search to gather a brief."), 6),
      renderCard("Sources", options.result ? `<div class="list">${options.result.sources.length > 0 ? options.result.sources.map((source) => `<div class="list-item"><strong>${escapeHtml(source.path)}</strong><div class="tiny">score ${source.score.toFixed(1)}</div><pre>${escapeHtml(source.excerpt)}</pre></div>`).join("") : renderEmptyState("No sources", "Research will list supporting chunks.")}</div>` : renderEmptyState("No sources", "Research sources appear here."), 6),
      renderCard("Brief", options.result ? `<pre>${escapeHtml(options.result.brief)}</pre>` : renderEmptyState("No brief yet", "The final brief will be suitable for handoff."), 6),
    ].join(""),
    rightPanelHtml: renderCard("Recent Trace", renderEventFeed(store.listEvents(undefined, 40))),
    projects,
    projectCount: projects.length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: options.result ? "analyzed" : "ready",
  });
}

export function renderPlannerPage(store: Store, options: { result?: Awaited<ReturnType<Store["createPlan"]>>["response"]; error?: string } = {}): string {
  const projects = store.listProjects();
  const projectOptions = projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join("");
  return pageShell("Planner", "/planner", {
    contentHtml: [
      renderCard("Generate Plan", `<form method="post" action="/plan" class="stack"><select name="project">${projectOptions || `<option value="">Add a project first</option>`}</select><textarea name="goal" placeholder="Refactor auth flow without breaking login">${escapeHtml(options.result?.goal ?? "")}</textarea><select name="risk"><option value="medium">Medium</option><option value="low">Low</option><option value="high">High</option></select><button type="submit">Generate plan</button></form>`, 6),
      renderCard("Plan Summary", options.result ? renderKeyValueList([["Risk", options.result.risk], ["Model", options.result.modelRecommendation], ["Depth", options.result.researchDepth], ["Checks", options.result.checks.join(", ")]]) : renderEmptyState("No plan yet", options.error ?? "Generate a task graph for a project goal."), 6),
      renderCard("Task Graph", options.result ? `<div class="list">${options.result.taskGraph.map((task) => `<div class="list-item"><div class="row"><strong>${escapeHtml(task.title)}</strong><span class="badge">${escapeHtml(task.status)}</span></div><div class="tiny">${escapeHtml(task.description)}</div><div class="tiny">Checks: ${escapeHtml(task.checks.join(", "))}</div><div class="tiny">Files: ${escapeHtml(task.expectedFiles.join(", ") || "none")}</div></div>`).join("")}</div>` : renderEmptyState("No task graph", "The plan will appear here after generation."), 12),
      renderCard("Likely Files", options.result ? `<div class="list">${options.result.likelyFiles.length > 0 ? options.result.likelyFiles.map((file) => `<div class="list-item">${escapeHtml(file)}</div>`).join("") : renderEmptyState("No files", "The planner did not identify any files yet.")}</div>` : renderEmptyState("No files", "Plan output will list likely files."), 6),
      renderCard("Session", options.result ? renderKeyValueList([["Session", options.result.sessionId], ["Project", options.result.projectId], ["Goal", options.result.goal]]) : renderEmptyState("No session", "Each generated plan creates a traceable session."), 6),
    ].join(""),
    rightPanelHtml: renderCard("Recent Trace", renderEventFeed(store.listEvents(undefined, 40))),
    projects,
    projectCount: projects.length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: options.result ? "planned" : "ready",
  });
}

export function renderHandoffPage(store: Store, options: { result?: Awaited<ReturnType<Store["createHandoff"]>>; error?: string } = {}): string {
  const projects = store.listProjects();
  const sessions = store.listSessions(50);
  const projectOptions = projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join("");
  const sessionOptions = sessions.map((session) => `<option value="${escapeHtml(session.id)}">${escapeHtml(session.title)}</option>`).join("");
  return pageShell("Handoff", "/handoff", {
    contentHtml: [
      renderCard("Create Handoff", `<form method="post" action="/handoff" class="stack"><select name="sessionId">${sessionOptions || `<option value="">Run a session first</option>`}</select><select name="project">${projectOptions || `<option value="">Add a project first</option>`}</select><select name="target"><option value="opencode">OpenCode</option><option value="codex">Codex</option><option value="manual">Manual</option><option value="clipboard">Clipboard</option><option value="file">File</option></select><textarea name="subtask" placeholder="Implement the next smallest change">${escapeHtml(options.result?.prompt ?? "")}</textarea><button type="submit">Generate handoff</button></form>`, 6),
      renderCard("Prompt", options.result ? `<pre>${escapeHtml(options.result.prompt)}</pre>` : renderEmptyState("No handoff yet", options.error ?? "Generate a target-specific prompt from a live session."), 6),
      renderCard("Selected Context", options.result ? renderKeyValueList([["Files to inspect", options.result.selectedContext.filesToInspect.join(", ") || "none"], ["Files likely to edit", options.result.selectedContext.filesLikelyToEdit.join(", ") || "none"], ["Checks to run", options.result.selectedContext.checksToRun.join(", ")], ["Constraints", options.result.selectedContext.constraints.join(" | ")]]) : renderEmptyState("No context", "The handoff will include files, checks, and constraints."), 12),
    ].join(""),
    rightPanelHtml: renderCard("Recent Trace", renderEventFeed(store.listEvents(undefined, 40))),
    projects,
    projectCount: projects.length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: "ready",
  });
}

export function renderChecksPage(store: Store): string {
  const checks = store.listCheckRuns(20);
  const projects = store.listProjects();
  return pageShell("Checks", "/checks", {
    contentHtml: [
      renderCard("Allowed Checks", `<div class="list">${["typecheck", "tests", "build", "lint"].map((name) => `<div class="list-item"><strong>${name}</strong><div class="tiny">Allowlisted validation check</div></div>`).join("")}</div>`, 4),
      renderCard("Recent Runs", `<div class="list">${checks.length > 0 ? checks.map((check) => `<div class="list-item"><div class="row"><strong>${escapeHtml(check.name)}</strong><span class="badge" data-tone="${check.status === "completed" ? "good" : check.status === "failed" ? "bad" : "warn"}">${escapeHtml(check.status)}</span></div><div class="tiny">${escapeHtml(check.command ?? "no command")}</div><div class="tiny">${escapeHtml(check.output ?? check.errorOutput ?? "no output")}</div></div>`).join("") : renderEmptyState("No checks yet", "Run an allowlisted check to create durable history.")}</div>`, 8),
      renderCard("Run Check", `<form method="post" action="/checks/run" class="stack"><input name="name" placeholder="typecheck" /><input name="projectId" placeholder="optional project id" /><button type="submit">Record check run</button></form>`, 4),
    ].join(""),
    rightPanelHtml: renderCard("Recent Events", renderEventFeed(store.listEvents(undefined, 40))),
    projects,
    projectCount: projects.length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: "ready",
  });
}

export function renderMemoryPage(store: Store): string {
  const projects = store.listProjects();
  const contentHtml = projects
    .map((project) => {
      const lessons = store.listProjectLessons(project.id, 5);
      const rules = store.listProjectRules(project.id, 5);
      const memory = store.listProjectMemory(project.id, 5);
      return renderCard(`${project.name} Memory`, [`<div class="list">${rules.length > 0 ? rules.map((rule) => `<div class="list-item"><strong>${escapeHtml(rule.title)}</strong><div class="tiny">${escapeHtml(rule.body)}</div></div>`).join("") : renderEmptyState("No rules", "Pin project rules here.")}</div>`, `<div class="list">${memory.length > 0 ? memory.map((entry) => `<div class="list-item"><strong>${escapeHtml(entry.title)}</strong><div class="tiny">${escapeHtml(entry.body)}</div></div>`).join("") : renderEmptyState("No memory", "Lessons and retrieved patterns will show up here.")}</div>`, `<div class="list">${lessons.length > 0 ? lessons.map((lesson) => `<div class="list-item"><strong>${escapeHtml(lesson.title)}</strong><div class="tiny">${escapeHtml(lesson.body)}</div></div>`).join("") : renderEmptyState("No lessons", "Ask or index the project to create lessons.")}</div>`].join(""), 12);
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

export function renderReviewsPage(store: Store, options: { result?: ReturnType<Store["createReview"]>; error?: string } = {}): string {
  const projects = store.listProjects();
  const projectOptions = projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join("");
  const reviews = store.listReviews(undefined, 20);
  return pageShell("Reviews", "/reviews", {
    contentHtml: [
      renderCard("Create Review", `<form method="post" action="/reviews" class="stack"><select name="project">${projectOptions || `<option value="">Add a project first</option>`}</select><input name="sessionId" placeholder="optional session id" /><input name="title" placeholder="review title" /><input name="plannedFiles" placeholder="planned/file1.ts, planned/file2.ts" /><input name="editedFiles" placeholder="edited/file1.ts, edited/file2.ts" /><input name="checks" placeholder="typecheck, tests" /><textarea name="notes" placeholder="review notes"></textarea><button type="submit">Create review</button></form>`, 6),
      renderCard("Latest Review", options.result ? `<div class="list-item"><strong>${escapeHtml(options.result.title)}</strong><div class="tiny">${escapeHtml(options.result.summary)}</div><div class="tiny">Next: ${escapeHtml(options.result.nextStep)}</div></div>` : renderEmptyState("No review yet", options.error ?? "Create a review to capture scope creep, missing tests, and risks."), 6),
      renderCard("Review History", `<div class="list">${reviews.length > 0 ? reviews.map((review) => `<a href="/reviews/${encodeURIComponent(review.id)}" style="display:block"><div class="list-item"><div class="row"><strong>${escapeHtml(review.title)}</strong><span class="badge">${escapeHtml(review.createdAt)}</span></div><div class="tiny">${escapeHtml(review.summary)}</div></div></a>`).join("") : renderEmptyState("No reviews yet", "Review history will accumulate here.")}</div>`, 12),
    ].join(""),
    rightPanelHtml: renderCard("Recent Trace", renderEventFeed(store.listEvents(undefined, 40))),
    projects,
    projectCount: projects.length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: options.result ? "reviewed" : "ready",
  });
}

export function renderReviewDetailPage(store: Store, reviewId: string): string {
  const review = store.getReview(reviewId);
  if (!review) {
    return renderNotFoundPage(store, `/reviews/${reviewId}`, "Missing review", `No review found for <code>${escapeHtml(reviewId)}</code>.`);
  }
  const plannedFiles = safeParseList(review.plannedFilesJson);
  const editedFiles = safeParseList(review.editedFilesJson);
  const checks = safeParseList(review.checksJson);
  const scopeCreep = safeParseList(review.scopeCreepJson);
  const missingTests = safeParseList(review.missingTestsJson);
  const riskyChanges = safeParseList(review.riskyChangesJson);
  const project = review.projectId ? store.getProject(review.projectId) : null;
  const session = review.sessionId ? store.getSession(review.sessionId) : null;

  return pageShell(review.title, `/reviews/${review.id}`, {
    contentHtml: [
      renderCard("Review Summary", renderKeyValueList([["Title", review.title], ["Project", project ? project.name : (review.projectId ?? "unknown")], ["Session", session ? session.title : (review.sessionId ?? "none")], ["Created", review.createdAt], ["Updated", review.updatedAt]]), 6),
      renderCard("Summary", `<pre>${escapeHtml(review.summary)}</pre>`, 6),
      renderCard("Planned Files", plannedFiles.length > 0 ? `<div class="list">${plannedFiles.map((file) => `<div class="list-item">${escapeHtml(file)}</div>`).join("")}</div>` : renderEmptyState("No planned files", "The review did not capture planned files."), 4),
      renderCard("Edited Files", editedFiles.length > 0 ? `<div class="list">${editedFiles.map((file) => `<div class="list-item">${escapeHtml(file)}</div>`).join("")}</div>` : renderEmptyState("No edited files", "The review did not capture edited files."), 4),
      renderCard("Checks", checks.length > 0 ? `<div class="list">${checks.map((check) => `<div class="list-item">${escapeHtml(check)}</div>`).join("")}</div>` : renderEmptyState("No checks", "The review did not capture validation checks."), 4),
      renderCard("Scope Creep", scopeCreep.length > 0 ? `<div class="list">${scopeCreep.map((file) => `<div class="list-item">${escapeHtml(file)}</div>`).join("")}</div>` : renderEmptyState("No scope creep", "Nothing extra slipped into the change set."), 4),
      renderCard("Missing Tests", missingTests.length > 0 ? `<div class="list">${missingTests.map((file) => `<div class="list-item">${escapeHtml(file)}</div>`).join("")}</div>` : renderEmptyState("No missing tests", "The review did not flag missing tests."), 4),
      renderCard("Risky Changes", riskyChanges.length > 0 ? `<div class="list">${riskyChanges.map((file) => `<div class="list-item">${escapeHtml(file)}</div>`).join("")}</div>` : renderEmptyState("No risky changes", "Nothing high-risk was detected."), 4),
    ].join(""),
    rightPanelHtml: renderCard("Recent Trace", renderEventFeed(store.listEvents(session?.id ?? undefined, 40))),
    activeProjectId: project?.id ?? null,
    projects: store.listProjects(),
    projectCount: store.listProjects().length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: "ready",
  });
}

export function renderRetrievalPage(store: Store, options: { projectId?: string; query?: string; chunks?: ReturnType<Store["searchChunks"]> } = {}): string {
  const projects = store.listProjects();
  const projectOptions = projects.map((project) => `<option value="${escapeHtml(project.id)}"${options.projectId === project.id ? " selected" : ""}>${escapeHtml(project.name)}</option>`).join("");
  const chunks = options.chunks ?? [];
  return pageShell("Retrieval", "/retrieval", {
    contentHtml: [
      renderCard("Search Retrieval", `<form method="post" action="/retrieval/search" class="stack"><select name="project">${projectOptions || `<option value="">Add a project first</option>`}</select><textarea name="query" placeholder="where is auth handled?">${escapeHtml(options.query ?? "")}</textarea><button type="submit">Search</button></form>`, 6),
      renderCard("Results", chunks.length > 0 ? `<div class="list">${chunks.map((chunk) => `<div class="list-item"><div class="row"><strong>${escapeHtml(chunk.path)}</strong><span class="badge">score ${chunk.score.toFixed(1)}</span></div><div class="tiny">Lines ${chunk.startLine}-${chunk.endLine}</div><pre>${escapeHtml(chunk.content.slice(0, 260))}</pre></div>`).join("")}</div>` : renderEmptyState("No results", "Run a retrieval search against a project."), 6),
    ].join(""),
    rightPanelHtml: renderCard("Recent Trace", renderEventFeed(store.listEvents(undefined, 40))),
    projects,
    projectCount: projects.length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: "ready",
  });
}

export function renderModelsPage(store: Store, config: ConfigSnapshot): string {
  const usage = store.listModelUsage(20);
  return pageShell("Models", "/models", {
    contentHtml: [
      renderCard("Local Model Status", renderKeyValueList([["API URL", config.apiUrl], ["Web Port", String(config.webPort)], ["Database", config.databasePath], ["Runtime", config.runtimeDir]]), 6),
      renderCard("Usage History", `<div class="list">${usage.length > 0 ? usage.map((entry) => `<div class="list-item"><div class="row"><strong>${escapeHtml(entry.modelName)}</strong><span class="badge">${escapeHtml(entry.day)}</span></div><div class="tiny">Prompt ${entry.promptTokens} · completion ${entry.completionTokens} · requests ${entry.requests}</div></div>`).join("") : renderEmptyState("No usage yet", "Model usage will appear after generation calls are recorded.")}</div>`, 6),
    ].join(""),
    rightPanelHtml: renderCard("Config", `<pre>${escapeHtml(JSON.stringify(store.getSettings(config), null, 2))}</pre>`),
    projects: store.listProjects(),
    projectCount: store.listProjects().length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: "ready",
  });
}

export function renderMcpPage(store: Store): string {
  const calls = store.listMcpCalls(20);
  return pageShell("MCP", "/mcp", {
    contentHtml: [
      renderCard("MCP Safety", renderKeyValueList([["Allowed tools", "ai_search_project, ai_ask_rag, ai_create_session, ai_create_plan, ai_get_current_task, ai_get_next_subtask, ai_create_handoff, ai_run_check"], ["Blocked by default", "raw shell execution, arbitrary file writes"]]), 6),
      renderCard("Recent Calls", `<div class="list">${calls.length > 0 ? calls.map((call) => `<a href="/mcp/calls/${encodeURIComponent(call.id)}" style="display:block"><div class="list-item"><div class="row"><strong>${escapeHtml(call.toolName)}</strong><span class="badge" data-tone="${call.blocked ? "bad" : "good"}">${call.blocked ? "blocked" : "allowed"}</span></div><div class="tiny">${escapeHtml(call.inputJson)}</div></div></a>`).join("") : renderEmptyState("No calls yet", "MCP calls will be logged here.")}</div>`, 6),
    ].join(""),
    rightPanelHtml: renderCard("Recent Trace", renderEventFeed(store.listEvents(undefined, 40))),
    projects: store.listProjects(),
    projectCount: store.listProjects().length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: "ready",
  });
}

export function renderMcpCallDetailPage(store: Store, callId: string): string {
  const call = store.getMcpCall(callId);
  if (!call) {
    return renderNotFoundPage(store, `/mcp/calls/${callId}`, "Missing call", `No MCP call found for <code>${escapeHtml(callId)}</code>.`);
  }
  const session = call.sessionId ? store.getSession(call.sessionId) : null;
  const project = call.projectId ? store.getProject(call.projectId) : null;
  return pageShell(`MCP ${call.toolName}`, `/mcp/calls/${call.id}`, {
    contentHtml: [
      renderCard("Call Summary", renderKeyValueList([["Tool", call.toolName], ["Blocked", call.blocked ? "yes" : "no"], ["Project", project ? project.name : (call.projectId ?? "none")], ["Session", session ? session.title : (call.sessionId ?? "none")], ["Created", call.createdAt]]), 6),
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
  });
}

export function renderSettingsPage(store: Store, config: ConfigSnapshot): string {
  const settings = store.getSettings(config);
  return pageShell("Settings", "/settings", {
    contentHtml: [
      renderCard("Settings Snapshot", `<pre>${escapeHtml(JSON.stringify(settings, null, 2))}</pre>`, 12),
      renderCard("Runtime Notes", renderEmptyState("Current defaults", "The bootstrap uses local SQLite, local runtime directories, and no cloud routing by default."), 12),
    ].join(""),
    rightPanelHtml: renderCard("Recent Trace", renderEventFeed(store.listEvents(undefined, 40))),
    projects: store.listProjects(),
    projectCount: store.listProjects().length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: "ready",
  });
}

// Error pages used by server.ts 404/error handlers
export function renderNotFoundPage(store: Store, route: string, title: string, messageHtml: string): string {
  return pageShell("Not Found", route, {
    contentHtml: renderCard(title, messageHtml),
    projects: store.listProjects(),
    projectCount: store.listProjects().length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: "missing",
  });
}

export function renderErrorPage(store: Store, route: string, message: string): string {
  return pageShell("Error", route, {
    contentHtml: renderCard("Request failed", `<pre>${escapeHtml(message)}</pre>`),
    projects: store.listProjects(),
    projectCount: store.listProjects().length,
    sessionCount: store.listSessions(1000).length,
    activeSessionCount: store.dashboardSnapshot().activeSessions,
    liveStatus: "error",
  });
}
