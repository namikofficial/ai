import { createServer } from "node:http";
import { resolveConfig } from "../../../packages/config/src/index.ts";
import {
  renderCard,
  renderEmptyState,
  renderEventFeed,
  renderKeyValueList,
  renderProjectItem,
  renderSessionItem,
  renderShell,
  renderTaskItem,
} from "../../../packages/ui/src/index.ts";
import type { ConfigSnapshot, ProjectSummary, SessionRecord, TaskRecord } from "../../../packages/shared/src/index.ts";

export interface WebServerOptions {
  config?: Partial<ConfigSnapshot>;
}

export interface WebServerHandle {
  url: string;
  close(): Promise<void>;
}

interface ApiResponse<T = unknown> {
  status: "ok" | "error";
  data?: T;
  error?: { message: string; code?: string };
}

function sendHtml(res: any, html: string, statusCode = 200): void {
  res.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    connection: "close",
  });
  res.end(html);
}

function sendText(res: any, body: string, statusCode = 200, contentType = "text/plain; charset=utf-8"): void {
  res.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store",
    connection: "close",
  });
  res.end(body);
}

async function readBody(req: any): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function fetchApi<T>(apiUrl: string, path: string, init?: RequestInit): Promise<ApiResponse<T>> {
  const response = await fetch(new URL(path, apiUrl), {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  return (await response.json()) as ApiResponse<T>;
}

function clientScript(): string {
  return `
const API_BASE = '/api';
const pageState = Object.create(null);

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function list(items, renderer) {
  return '<div class="list">' + (items.length ? items.map(renderer).join('') : '<div class="list-item"><div class="tiny">No items</div></div>') + '</div>';
}

async function api(path, init) {
  const response = await fetch(API_BASE + path, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init && init.headers ? init.headers : {}),
    },
  });
  const data = await response.json();
  if (!response.ok || data.status !== 'ok') {
    throw new Error((data && data.error && data.error.message) || response.statusText || 'Request failed');
  }
  return data.data;
}

function formDataObject(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function setState(key, value) {
  pageState[key] = value;
}

function getState(key) {
  return pageState[key];
}

function renderSection(root, html) {
  root.innerHTML = html;
  attachFormHandlers(root);
}

function attachFormHandlers(root) {
  root.querySelectorAll('form[data-endpoint]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const endpoint = form.dataset.endpoint;
      const method = form.dataset.method || 'POST';
      const isJson = form.dataset.json === 'true';
      const payload = formDataObject(form);
      const result = await api(endpoint, {
        method,
        headers: isJson ? { 'content-type': 'application/json' } : { 'content-type': 'application/x-www-form-urlencoded' },
        body: isJson ? JSON.stringify(payload) : new URLSearchParams(payload),
      });
      if (form.dataset.stateKey) {
        setState(form.dataset.stateKey, result);
      }
      if (form.dataset.redirectTemplate) {
        const field = form.dataset.redirectField || 'id';
        const raw = result && typeof result === 'object' ? result[field] : null;
        const value = raw == null ? '' : String(raw);
        if (value) {
          location.href = form.dataset.redirectTemplate.replace('{id}', encodeURIComponent(value));
          return;
        }
      }
      if (form.dataset.redirectPrefix) {
        const field = form.dataset.redirectField || 'id';
        const raw = result && typeof result === 'object' ? result[field] : null;
        const value = raw == null ? '' : String(raw);
        if (value) {
          location.href = form.dataset.redirectPrefix + encodeURIComponent(value);
          return;
        }
      }
      if (form.dataset.reload === 'false' || form.dataset.stateKey) {
        await renderApp();
      } else {
        location.reload();
      }
    });
  });
}

async function renderDashboard(root) {
  const status = await api('/status');
  root.innerHTML = [
    '<section class="panel" data-span="4"><h3>Projects</h3><div class="kpi"><div class="value">' + status.summary.projects + '</div><div class="label">Indexed projects</div></div></section>',
    '<section class="panel" data-span="4"><h3>Active Sessions</h3><div class="kpi"><div class="value">' + status.summary.activeSessions + '</div><div class="label">Live work</div></div></section>',
    '<section class="panel" data-span="4"><h3>Checks</h3><div class="kpi"><div class="value">' + status.summary.checks + '</div><div class="label">Recent checks</div></div></section>',
    '<section class="panel" data-span="6"><h3>Projects</h3>' + list(status.projects, (project) => '<a href="/projects/' + esc(project.id) + '" style="display:block"><div class="list-item"><div class="row"><div><div><strong>' + esc(project.name) + '</strong></div><div class="tiny">' + esc(project.path) + '</div></div><span class="badge">' + esc(project.status) + '</span></div><div class="tiny">' + esc(project.language || "unknown") + ' · ' + esc(project.framework || "unknown") + ' · ' + project.fileCount + ' files · ' + project.chunkCount + ' chunks</div></div></a>') + '</section>',
    '<section class="panel" data-span="6"><h3>Sessions</h3>' + list(status.sessions, (session) => '<a href="/sessions/' + esc(session.id) + '" style="display:block"><div class="list-item"><div class="row"><div><div><strong>' + esc(session.title) + '</strong></div><div class="tiny">' + esc(session.userGoal) + '</div></div><span class="badge">' + esc(session.status) + '</span></div><div class="tiny">' + esc(session.startedAt) + '</div></div></a>') + '</section>',
    '<section class="panel" data-span="12"><h3>Settings</h3>' + '<div class="list">' +
      Object.entries(status.settings).map(([key, value]) => '<div class="list-item"><div class="tiny">' + esc(key) + '</div><div>' + esc(value) + '</div></div>').join('') +
      '</div></section>',
  ].join('');
}

async function renderProjects(root) {
  const projects = await api('/projects');
  root.innerHTML = [
    '<section class="panel" data-span="8"><h3>Projects</h3>' + list(projects, (project) => '<a href="/projects/' + esc(project.id) + '" style="display:block"><div class="list-item">' +
      '<div class="row"><div><div><strong>' + esc(project.name) + '</strong></div><div class="tiny">' + esc(project.path) + '</div></div><span class="badge">' + esc(project.status) + '</span></div>' +
      '<div class="tiny">' + esc(project.language || 'unknown') + ' · ' + esc(project.framework || 'unknown') + ' · ' + project.fileCount + ' files · ' + project.chunkCount + ' chunks</div>' +
    '</div></a>') + '</section>',
    '<section class="panel" data-span="4"><h3>Add Project</h3><form data-endpoint="/projects" data-reload="true" class="stack"><input name="path" placeholder="/home/namik/Documents/code/noxcrm" /><input name="name" placeholder="optional display name" /><button type="submit">Add project</button></form></section>',
  ].join('');
  attachFormHandlers(root);
}

async function renderSessions(root) {
  const sessions = await api('/sessions');
  root.innerHTML = '<section class="panel" data-span="12"><h3>Sessions</h3>' + list(sessions, (session) => '<a href="/sessions/' + esc(session.id) + '" style="display:block"><div class="list-item"><div class="row"><div><div><strong>' + esc(session.title) + '</strong></div><div class="tiny">' + esc(session.userGoal) + '</div></div><span class="badge">' + esc(session.status) + '</span></div><div class="tiny">' + esc(session.startedAt) + '</div></div></a>') + '</section>';
}

async function renderTasks(root) {
  const tasks = await api('/tasks');
  const counts = tasks.reduce((acc, task) => { acc[task.status] = (acc[task.status] || 0) + 1; return acc; }, {});
  root.innerHTML = [
    '<section class="panel" data-span="4"><h3>Queued</h3><div class="kpi"><div class="value">' + (counts.queued || 0) + '</div><div class="label">Queued tasks</div></div></section>',
    '<section class="panel" data-span="4"><h3>Running</h3><div class="kpi"><div class="value">' + (counts.running || 0) + '</div><div class="label">Running tasks</div></div></section>',
    '<section class="panel" data-span="4"><h3>Completed</h3><div class="kpi"><div class="value">' + (counts.completed || 0) + '</div><div class="label">Completed tasks</div></div></section>',
    '<section class="panel" data-span="12"><h3>Task Graph</h3>' + list(tasks, (task) => '<a href="/tasks/' + esc(task.id) + '" style="display:block"><div class="list-item"><div class="row"><div><div><strong>' + esc(task.title) + '</strong></div><div class="tiny">' + esc(task.type) + ' · session ' + esc(task.sessionId) + '</div></div><span class="badge">' + esc(task.status) + '</span></div><div class="tiny">Priority ' + task.priority + '</div></div></a>') + '</section>',
  ].join('');
}

async function renderSettings(root) {
  const settings = await api('/settings');
  root.innerHTML = '<section class="panel" data-span="12"><h3>Settings</h3>' +
    '<div class="list">' + Object.entries(settings).map(([key, value]) => '<div class="list-item"><div class="tiny">' + esc(key) + '</div><div>' + esc(Array.isArray(value) ? value.join(', ') : value) + '</div></div>').join('') + '</div></section>';
}

async function renderProjectDetail(root, projectId) {
  const [project, memory, retrieval, sessions] = await Promise.all([
    api('/projects/' + encodeURIComponent(projectId)),
    api('/projects/' + encodeURIComponent(projectId) + '/memory'),
    api('/projects/' + encodeURIComponent(projectId) + '/retrieval'),
    api('/sessions'),
  ]);
  const projectSessions = sessions.filter((session) => session.projectId === projectId);
  const indexResult = getState('projectIndexResult');
  renderSection(root, [
    '<section class="panel" data-span="6"><h3>Project Summary</h3>' + list([
      ['Path', project.path],
      ['Language', project.language || 'unknown'],
      ['Framework', project.framework || 'unknown'],
      ['Status', project.status],
      ['Files', String(project.fileCount)],
      ['Chunks', String(project.chunkCount)],
    ], ([label, value]) => '<div class="list-item"><div class="tiny">' + esc(label) + '</div><div>' + esc(value) + '</div></div>') + '</section>',
    '<section class="panel" data-span="6"><h3>Actions</h3><form data-endpoint="/projects/' + esc(project.id) + '/index" data-state-key="projectIndexResult" data-reload="false" class="stack"><button type="submit">Reindex project</button></form>' + (indexResult ? '<div class="list-item"><strong>Last index</strong><div class="tiny">Files ' + indexResult.filesIndexed + ' · chunks ' + indexResult.chunksIndexed + '</div><div class="tiny">Session ' + esc(indexResult.session.id) + '</div></div>' : '') + '</section>',
    '<section class="panel" data-span="8"><h3>Recent Chunks</h3>' + list(retrieval, (chunk) => '<div class="list-item"><div class="row"><strong>' + esc(chunk.path) + '</strong><span class="badge">score ' + chunk.score.toFixed(1) + '</span></div><div class="tiny">Lines ' + chunk.startLine + '-' + chunk.endLine + '</div><pre>' + esc(chunk.content.slice(0, 260)) + '</pre></div>') + '</section>',
    '<section class="panel" data-span="4"><h3>Memory</h3>' + list((memory.lessons || []).concat(memory.rules || []).concat(memory.memory || []), (entry) => '<div class="list-item"><strong>' + esc(entry.title || entry.body || entry.id) + '</strong><div class="tiny">' + esc(entry.body || entry.source || '') + '</div></div>') + '</section>',
    '<section class="panel" data-span="12"><h3>Sessions</h3>' + list(projectSessions, (session) => '<a href="/sessions/' + esc(session.id) + '" style="display:block"><div class="list-item"><div class="row"><div><div><strong>' + esc(session.title) + '</strong></div><div class="tiny">' + esc(session.mode) + '</div></div><span class="badge">' + esc(session.status) + '</span></div></div></a>') + '</section>',
  ].join(''));
}

async function renderSessionDetail(root, sessionId) {
  const [session, events, tasks] = await Promise.all([
    api('/sessions/' + encodeURIComponent(sessionId)),
    api('/sessions/' + encodeURIComponent(sessionId) + '/events'),
    api('/tasks'),
  ]);
  const relatedTasks = tasks.filter((task) => task.sessionId === sessionId);
  renderSection(root, [
    '<section class="panel" data-span="6"><h3>Session Summary</h3>' + list([
      ['Title', session.title],
      ['Goal', session.userGoal],
      ['Mode', session.mode],
      ['Status', session.status],
      ['Source', session.source],
      ['Started', session.startedAt],
      ['Finished', session.finishedAt || 'running'],
    ], ([label, value]) => '<div class="list-item"><div class="tiny">' + esc(label) + '</div><div>' + esc(value) + '</div></div>') + '</section>',
    '<section class="panel" data-span="6"><h3>Final Summary</h3>' + (session.finalSummary ? '<pre>' + esc(session.finalSummary) + '</pre>' : '<div class="list-item"><div class="tiny">No final summary yet.</div></div>') + '</section>',
    '<section class="panel" data-span="12"><h3>Tasks</h3>' + list(relatedTasks, (task) => '<a href="/tasks/' + esc(task.id) + '" style="display:block"><div class="list-item"><div class="row"><strong>' + esc(task.title) + '</strong><span class="badge">' + esc(task.status) + '</span></div><div class="tiny">' + esc(task.type) + ' · ' + esc(task.risk) + '</div></div></a>') + '</section>',
    '<section class="panel" data-span="12"><h3>Events</h3>' + list(events, (event) => '<div class="list-item"><div class="row"><strong>' + esc(event.type) + '</strong><span class="badge">' + esc(event.ts) + '</span></div><div class="tiny">' + esc(JSON.stringify(event.payload || {})) + '</div></div>') + '</section>',
  ].join(''));
}

async function renderTaskDetail(root, taskId) {
  const task = await api('/tasks/' + encodeURIComponent(taskId));
  const session = task.sessionId ? await api('/sessions/' + encodeURIComponent(task.sessionId)) : null;
  const events = task.sessionId ? await api('/sessions/' + encodeURIComponent(task.sessionId) + '/events') : [];
  const actionResult = getState('taskActionResult');
  renderSection(root, [
    '<section class="panel" data-span="6"><h3>Task Summary</h3>' + list([
      ['Title', task.title],
      ['Description', task.description],
      ['Type', task.type],
      ['Status', task.status],
      ['Risk', task.risk],
      ['Priority', String(task.priority)],
      ['Session', session ? session.title : task.sessionId],
    ], ([label, value]) => '<div class="list-item"><div class="tiny">' + esc(label) + '</div><div>' + esc(value) + '</div></div>') + '</section>',
    '<section class="panel" data-span="6"><h3>Actions</h3><div class="stack"><form data-endpoint="/tasks/' + esc(task.id) + '/start" data-state-key="taskActionResult" data-reload="false"><button type="submit">Start task</button></form><form data-endpoint="/tasks/' + esc(task.id) + '/complete" data-state-key="taskActionResult" data-reload="false" class="stack"><textarea name="result" placeholder="completion notes"></textarea><button type="submit">Complete task</button></form><form data-endpoint="/tasks/' + esc(task.id) + '/fail" data-state-key="taskActionResult" data-reload="false" class="stack"><textarea name="error" placeholder="failure notes"></textarea><button type="submit">Fail task</button></form></div>' + (actionResult ? '<div class="list-item"><strong>Last action</strong><div class="tiny">' + esc(JSON.stringify(actionResult)) + '</div></div>' : '') + '</section>',
    '<section class="panel" data-span="12"><h3>Result</h3><pre>' + esc(task.resultJson && task.resultJson !== '{}' ? task.resultJson : 'No result recorded yet.') + '</pre></section>',
    '<section class="panel" data-span="12"><h3>Events</h3>' + list(events, (event) => '<div class="list-item"><div class="row"><strong>' + esc(event.type) + '</strong><span class="badge">' + esc(event.ts) + '</span></div><div class="tiny">' + esc(JSON.stringify(event.payload || {})) + '</div></div>') + '</section>',
  ].join(''));
}

async function renderAsk(root) {
  const projects = await api('/projects');
  const result = getState('askResult');
  renderSection(root, [
    '<section class="panel" data-span="6"><h3>Ask a Question</h3><form data-endpoint="/ask" data-state-key="askResult" data-reload="false" class="stack"><select name="project">' + (projects.length ? projects.map((project) => '<option value="' + esc(project.id) + '">' + esc(project.name) + '</option>').join('') : '<option value="">Add a project first</option>') + '</select><textarea name="question" placeholder="where is auth handled?"></textarea><select name="depth"><option value="standard">Standard depth</option><option value="shallow">Shallow</option><option value="deep">Deep</option></select><button type="submit">Ask</button></form></section>',
    '<section class="panel" data-span="6"><h3>Answer</h3>' + (result ? '<div class="list-item"><div class="badge">confidence ' + Math.round(result.confidence * 100) + '%</div><pre>' + esc(result.answer) + '</pre><div class="tiny">Session ' + esc(result.sessionId) + '</div></div>' : '<div class="list-item"><div class="tiny">Submit a question to see retrieved context and citations.</div></div>') + '</section>',
    '<section class="panel" data-span="12"><h3>Citations</h3>' + (result && result.citations.length ? list(result.citations, (citation) => '<div class="list-item"><strong>' + esc(citation.path) + '</strong><div class="tiny">Lines ' + citation.startLine + '-' + citation.endLine + ' · score ' + citation.score.toFixed(1) + '</div><pre>' + esc(citation.excerpt) + '</pre></div>') : '<div class="list-item"><div class="tiny">No citations yet.</div></div>') + '</section>',
  ].join(''));
}

async function renderResearch(root) {
  const projects = await api('/projects');
  const result = getState('researchResult');
  renderSection(root, [
    '<section class="panel" data-span="6"><h3>Research Topic</h3><form data-endpoint="/research" data-state-key="researchResult" data-reload="false" class="stack"><select name="project">' + (projects.length ? projects.map((project) => '<option value="' + esc(project.id) + '">' + esc(project.name) + '</option>').join('') : '<option value="">Add a project first</option>') + '</select><input name="topic" placeholder="authentication architecture" /><select name="mode"><option value="local">Local only</option><option value="hybrid">Hybrid</option><option value="web">Web</option></select><button type="submit">Research</button></form></section>',
    '<section class="panel" data-span="6"><h3>Summary</h3>' + (result ? '<pre>' + esc(result.summary) + '</pre>' : '<div class="list-item"><div class="tiny">Run a topic search to gather a brief.</div></div>') + '</section>',
    '<section class="panel" data-span="6"><h3>Sources</h3>' + (result && result.sources.length ? list(result.sources, (source) => '<div class="list-item"><strong>' + esc(source.path) + '</strong><div class="tiny">score ' + source.score.toFixed(1) + '</div><pre>' + esc(source.excerpt) + '</pre></div>') : '<div class="list-item"><div class="tiny">Sources appear here.</div></div>') + '</section>',
    '<section class="panel" data-span="6"><h3>Brief</h3>' + (result ? '<pre>' + esc(result.brief) + '</pre>' : '<div class="list-item"><div class="tiny">The final brief will be suitable for handoff.</div></div>') + '</section>',
  ].join(''));
}

async function renderPlanner(root) {
  const data = await api('/planner');
  const result = getState('plannerResult');
  renderSection(root, [
    '<section class="panel" data-span="6"><h3>Generate Plan</h3><form data-endpoint="/plan" data-state-key="plannerResult" data-reload="false" class="stack"><select name="project">' + (data.projects.length ? data.projects.map((project) => '<option value="' + esc(project.id) + '">' + esc(project.name) + '</option>').join('') : '<option value="">Add a project first</option>') + '</select><textarea name="goal" placeholder="Refactor auth flow without breaking login"></textarea><select name="risk"><option value="medium">Medium</option><option value="low">Low</option><option value="high">High</option></select><button type="submit">Generate plan</button></form></section>',
    '<section class="panel" data-span="6"><h3>Plan Summary</h3>' + (result ? list([
      ['Risk', result.risk],
      ['Model', result.modelRecommendation],
      ['Depth', result.researchDepth],
      ['Checks', result.checks.join(', ')],
    ], ([label, value]) => '<div class="list-item"><div class="tiny">' + esc(label) + '</div><div>' + esc(value) + '</div></div>') : '<div class="list-item"><div class="tiny">Generate a task graph for a project goal.</div></div>') + '</section>',
    '<section class="panel" data-span="12"><h3>Task Graph</h3>' + (result && result.taskGraph.length ? list(result.taskGraph, (task) => '<div class="list-item"><div class="row"><strong>' + esc(task.title) + '</strong><span class="badge">' + esc(task.status) + '</span></div><div class="tiny">' + esc(task.description) + '</div><div class="tiny">Checks: ' + esc(task.checks.join(', ')) + '</div><div class="tiny">Files: ' + esc(task.expectedFiles.join(', ') || 'none') + '</div></div>') : '<div class="list-item"><div class="tiny">The plan will appear here after generation.</div></div>') + '</section>',
    '<section class="panel" data-span="6"><h3>Recent Tasks</h3>' + list(data.tasks, (task) => '<a href="/tasks/' + esc(task.id) + '" style="display:block"><div class="list-item"><div class="row"><strong>' + esc(task.title) + '</strong><span class="badge">' + esc(task.status) + '</span></div><div class="tiny">' + esc(task.description) + '</div></div></a>') + '</section>',
    '<section class="panel" data-span="6"><h3>Plan Sessions</h3>' + list(data.recentSessions, (session) => '<a href="/sessions/' + esc(session.id) + '" style="display:block"><div class="list-item"><div class="row"><strong>' + esc(session.title) + '</strong><span class="badge">' + esc(session.status) + '</span></div><div class="tiny">' + esc(session.userGoal) + '</div></div></a>') + '</section>',
  ].join(''));
}

async function renderHandoff(root) {
  const data = await api('/handoff');
  const result = getState('handoffResult');
  renderSection(root, [
    '<section class="panel" data-span="6"><h3>Create Handoff</h3><form data-endpoint="/handoff" data-state-key="handoffResult" data-reload="false" class="stack"><select name="sessionId">' + (data.sessions.length ? data.sessions.map((session) => '<option value="' + esc(session.id) + '">' + esc(session.title) + '</option>').join('') : '<option value="">Run a session first</option>') + '</select><select name="project">' + (data.projects.length ? data.projects.map((project) => '<option value="' + esc(project.id) + '">' + esc(project.name) + '</option>').join('') : '<option value="">Add a project first</option>') + '</select><select name="target"><option value="opencode">OpenCode</option><option value="codex">Codex</option><option value="manual">Manual</option><option value="clipboard">Clipboard</option><option value="file">File</option></select><textarea name="subtask" placeholder="Implement the next smallest change"></textarea><button type="submit">Generate handoff</button></form></section>',
    '<section class="panel" data-span="6"><h3>Prompt</h3>' + (result ? '<pre>' + esc(result.prompt) + '</pre>' : '<div class="list-item"><div class="tiny">Generate a target-specific prompt from a live session.</div></div>') + '</section>',
    '<section class="panel" data-span="12"><h3>Selected Context</h3>' + (result ? list([
      ['Files to inspect', result.selectedContext.filesToInspect.join(', ') || 'none'],
      ['Files likely to edit', result.selectedContext.filesLikelyToEdit.join(', ') || 'none'],
      ['Checks to run', result.selectedContext.checksToRun.join(', ') || 'none'],
      ['Constraints', result.selectedContext.constraints.join(' | ') || 'none'],
    ], ([label, value]) => '<div class="list-item"><div class="tiny">' + esc(label) + '</div><div>' + esc(value) + '</div></div>') : '<div class="list-item"><div class="tiny">The handoff will include files, checks, and constraints.</div></div>') + '</section>',
    '<section class="panel" data-span="12"><h3>Recent Handoffs</h3>' + list(data.handoffs, (handoff) => '<div class="list-item"><div class="row"><strong>' + esc(handoff.target) + '</strong><span class="badge">' + esc(handoff.id) + '</span></div><div class="tiny">' + esc(handoff.prompt.slice(0, 180)) + '</div></div>') + '</section>',
  ].join(''));
}

async function renderChecks(root) {
  const checks = await api('/checks');
  const result = getState('checkResult');
  renderSection(root, [
    '<section class="panel" data-span="4"><h3>Allowed Checks</h3>' + list(['typecheck', 'tests', 'build', 'lint'], (name) => '<div class="list-item"><strong>' + esc(name) + '</strong><div class="tiny">Allowlisted validation check</div></div>') + '</section>',
    '<section class="panel" data-span="4"><h3>Run Check</h3><form data-endpoint="/checks/run" data-state-key="checkResult" data-reload="false" class="stack"><input name="name" placeholder="typecheck" /><input name="projectId" placeholder="optional project id" /><button type="submit">Record check run</button></form>' + (result ? '<div class="list-item"><strong>Last run</strong><div class="tiny">' + esc(result.name) + ' · ' + esc(result.status) + '</div></div>' : '') + '</section>',
    '<section class="panel" data-span="8"><h3>Recent Runs</h3>' + list(checks, (check) => '<div class="list-item"><div class="row"><strong>' + esc(check.name) + '</strong><span class="badge">' + esc(check.status) + '</span></div><div class="tiny">' + esc(check.command || 'no command') + '</div><div class="tiny">' + esc(check.output || check.errorOutput || 'no output') + '</div></div>') + '</section>',
  ].join(''));
}

async function renderMemory(root) {
  const data = await api('/memory');
  const result = getState('memoryResult');
  renderSection(root, [
    '<section class="panel" data-span="6"><h3>Add Memory Lesson</h3><form data-endpoint="/memory/lesson" data-state-key="memoryResult" data-reload="false" class="stack"><select name="projectId">' + (data.projects.length ? data.projects.map((entry) => '<option value="' + esc(entry.project.id) + '">' + esc(entry.project.name) + '</option>').join('') : '<option value="">Add a project first</option>') + '</select><input name="title" placeholder="memory title" /><textarea name="body" placeholder="lesson body"></textarea><input name="importance" placeholder="3" /><button type="submit">Save lesson</button></form></section>',
    '<section class="panel" data-span="6"><h3>Reflect Session</h3><form data-endpoint="/memory/reflect" data-state-key="memoryResult" data-reload="false" class="stack"><input name="sessionId" placeholder="session id" /><button type="submit">Reflect</button></form>' + (result ? '<div class="list-item"><strong>Latest memory write</strong><div class="tiny">' + esc(result.title || result.body || 'saved') + '</div></div>' : '') + '</section>',
    '<section class="panel" data-span="12"><h3>Project Memory</h3>' + list(data.projects, (entry) => '<div class="list-item"><div class="row"><strong>' + esc(entry.project.name) + '</strong><span class="badge">' + esc(entry.project.status) + '</span></div><div class="tiny">Lessons: ' + entry.lessons.length + ' · Rules: ' + entry.rules.length + ' · Memory: ' + entry.memory.length + '</div></div>') + '</section>',
  ].join(''));
}

async function renderRetrieval(root) {
  const data = await api('/retrieval');
  const result = getState('retrievalResult') || [];
  renderSection(root, [
    '<section class="panel" data-span="6"><h3>Search Retrieval</h3><form data-endpoint="/retrieval/search" data-state-key="retrievalResult" data-reload="false" class="stack"><select name="project">' + (data.projects.length ? data.projects.map((project) => '<option value="' + esc(project.id) + '">' + esc(project.name) + '</option>').join('') : '<option value="">Add a project first</option>') + '</select><textarea name="query" placeholder="where is auth handled?"></textarea><button type="submit">Search</button></form></section>',
    '<section class="panel" data-span="6"><h3>Results</h3>' + (result.length ? list(result, (chunk) => '<div class="list-item"><div class="row"><strong>' + esc(chunk.path) + '</strong><span class="badge">score ' + chunk.score.toFixed(1) + '</span></div><div class="tiny">Lines ' + chunk.startLine + '-' + chunk.endLine + '</div><pre>' + esc(chunk.content.slice(0, 260)) + '</pre></div>') : '<div class="list-item"><div class="tiny">Run a retrieval search against a project.</div></div>') + '</section>',
    '<section class="panel" data-span="12"><h3>Recent Lessons</h3>' + list(data.recentLessons, (lesson) => '<div class="list-item"><strong>' + esc(lesson.title) + '</strong><div class="tiny">' + esc(lesson.body) + '</div></div>') + '</section>',
  ].join(''));
}

async function renderReviews(root) {
  const reviews = await api('/reviews');
  const result = getState('reviewResult');
  const projects = await api('/projects');
  renderSection(root, [
    '<section class="panel" data-span="6"><h3>Create Review</h3><form data-endpoint="/reviews" data-state-key="reviewResult" data-reload="false" class="stack"><select name="project">' + (projects.length ? projects.map((project) => '<option value="' + esc(project.id) + '">' + esc(project.name) + '</option>').join('') : '<option value="">Add a project first</option>') + '</select><input name="sessionId" placeholder="optional session id" /><input name="title" placeholder="review title" /><input name="plannedFiles" placeholder="planned/file1.ts, planned/file2.ts" /><input name="editedFiles" placeholder="edited/file1.ts, edited/file2.ts" /><input name="checks" placeholder="typecheck, tests" /><textarea name="notes" placeholder="review notes"></textarea><button type="submit">Create review</button></form></section>',
    '<section class="panel" data-span="6"><h3>Latest Review</h3>' + (result ? '<div class="list-item"><strong>' + esc(result.title) + '</strong><div class="tiny">' + esc(result.summary) + '</div><div class="tiny">Next: ' + esc(result.nextStep) + '</div></div>' : '<div class="list-item"><div class="tiny">Create a review to capture scope creep, missing tests, and risks.</div></div>') + '</section>',
    '<section class="panel" data-span="12"><h3>Review History</h3>' + list(reviews, (review) => '<div class="list-item"><div class="row"><strong>' + esc(review.title) + '</strong><span class="badge">' + esc(review.createdAt) + '</span></div><div class="tiny">' + esc(review.summary) + '</div></div>') + '</section>',
  ].join(''));
}

async function renderModels(root) {
  const models = await api('/models');
  renderSection(root, [
    '<section class="panel" data-span="6"><h3>Local Model Status</h3>' +
      list(Object.entries(models.settings), ([key, value]) => '<div class="list-item"><div class="tiny">' + esc(key) + '</div><div>' + esc(Array.isArray(value) ? value.join(', ') : value) + '</div></div>') + '</section>',
    '<section class="panel" data-span="6"><h3>Usage History</h3>' + list(models.usage, (entry) => '<div class="list-item"><div class="row"><strong>' + esc(entry.modelName) + '</strong><span class="badge">' + esc(entry.day) + '</span></div><div class="tiny">Prompt ' + entry.promptTokens + ' · completion ' + entry.completionTokens + ' · requests ' + entry.requests + '</div></div>') + '</section>',
  ].join(''));
}

async function renderMcp(root) {
  const calls = await api('/mcp');
  renderSection(root, [
    '<section class="panel" data-span="6"><h3>MCP Safety</h3>' + list([
      ['Allowed tools', 'ai_search_project, ai_ask_rag, ai_create_session, ai_create_plan, ai_get_current_task, ai_get_next_subtask, ai_create_handoff, ai_run_check'],
      ['Blocked by default', 'raw shell execution, arbitrary file writes'],
    ], ([label, value]) => '<div class="list-item"><div class="tiny">' + esc(label) + '</div><div>' + esc(value) + '</div></div>') + '</section>',
    '<section class="panel" data-span="6"><h3>Recent Calls</h3>' + list(calls, (call) => '<div class="list-item"><div class="row"><strong>' + esc(call.toolName) + '</strong><span class="badge">' + (call.blocked ? 'blocked' : 'allowed') + '</span></div><div class="tiny">' + esc(call.inputJson) + '</div></div>') + '</section>',
  ].join(''));
}

async function renderFallback(root) {
  renderSection(root, '<section class="panel" data-span="12"><h3>Loading</h3><div class="tiny">This route is handled by the API server fallback.</div></section>');
}

async function renderApp() {
  const root = document.getElementById('spa');
  if (!root) return;
  const path = location.pathname;
  const parts = path.split('/').filter(Boolean);
  if (path === '/' || path === '/dashboard') {
    await renderDashboard(root);
    return;
  }
  if (path === '/projects') {
    await renderProjects(root);
    return;
  }
  if (parts[0] === 'projects' && parts.length === 2) {
    await renderProjectDetail(root, decodeURIComponent(parts[1]));
    return;
  }
  if (path === '/sessions') {
    await renderSessions(root);
    return;
  }
  if (parts[0] === 'sessions' && parts.length === 2) {
    await renderSessionDetail(root, decodeURIComponent(parts[1]));
    return;
  }
  if (path === '/tasks') {
    await renderTasks(root);
    return;
  }
  if (parts[0] === 'tasks' && parts.length === 2) {
    await renderTaskDetail(root, decodeURIComponent(parts[1]));
    return;
  }
  if (path === '/ask') {
    await renderAsk(root);
    return;
  }
  if (path === '/research') {
    await renderResearch(root);
    return;
  }
  if (path === '/planner') {
    await renderPlanner(root);
    return;
  }
  if (path === '/handoff') {
    await renderHandoff(root);
    return;
  }
  if (path === '/checks') {
    await renderChecks(root);
    return;
  }
  if (path === '/memory') {
    await renderMemory(root);
    return;
  }
  if (path === '/retrieval') {
    await renderRetrieval(root);
    return;
  }
  if (path === '/reviews') {
    await renderReviews(root);
    return;
  }
  if (path === '/models') {
    await renderModels(root);
    return;
  }
  if (path === '/mcp') {
    await renderMcp(root);
    return;
  }
  if (path === '/settings') {
    await renderSettings(root);
    return;
  }
  await renderFallback(root);
}

renderApp().catch((error) => {
  const root = document.getElementById('spa');
  if (root) {
    root.innerHTML = '<section class="panel" data-span="12"><h3>Failed to load</h3><pre>' + esc(error && error.message ? error.message : String(error)) + '</pre></section>';
  }
});
`;
}

function renderAppShell(apiUrl: string, route: string, status: ApiResponse<any>): string {
  const data = status.data ?? {};
  const projects = Array.isArray(data.projects) ? data.projects : [];
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  const activeSessions = typeof data.summary?.activeSessions === "number" ? data.summary.activeSessions : 0;
  const projectCount = typeof data.summary?.projects === "number" ? data.summary.projects : projects.length;
  const contentHtml = `<section class="panel" data-span="12"><div id="spa" data-route="${route}"><div class="tiny">Loading ${route}...</div></div><script src="/client.js"></script></section>`;
  const rightPanelHtml = renderCard("Recent Trace", `<div class="event-log" data-event-log></div>`);
  return renderShell({
    title: route === "/" ? "Dashboard" : route.slice(1).replaceAll("/", " / ").replaceAll("-", " "),
    route,
    activeProjectId: null,
    contentHtml,
    rightPanelHtml,
    projects: projects as ProjectSummary[],
    sessionCount: sessions.length,
    activeSessionCount: activeSessions,
    liveStatus: "ready",
  });
}

function isSpaRoute(path: string): boolean {
  if (path === "/" || path === "/dashboard") return true;
  if (path === "/projects" || path === "/sessions" || path === "/tasks") return true;
  if (path === "/ask" || path === "/research" || path === "/planner" || path === "/handoff") return true;
  if (path === "/checks" || path === "/memory" || path === "/retrieval" || path === "/reviews") return true;
  if (path === "/models" || path === "/mcp" || path === "/settings") return true;
  if (/^\/projects\/[^/]+$/.test(path)) return true;
  if (/^\/sessions\/[^/]+$/.test(path)) return true;
  if (/^\/tasks\/[^/]+$/.test(path)) return true;
  return false;
}

export async function startWorkbenchWeb(options: WebServerOptions = {}): Promise<WebServerHandle> {
  const config = resolveConfig(options.config ?? {});
  const apiUrl = config.apiUrl;

  const server = createServer((req: any, res: any) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;

      if (path === "/client.js") {
        sendText(res, clientScript(), 200, "application/javascript; charset=utf-8");
        return;
      }

      if (path.startsWith("/api/") || path === "/events/stream") {
        const targetPath = path === "/events/stream" ? path : path.slice(4);
        const target = new URL(targetPath + url.search, apiUrl);
        const method = String(req.method ?? "GET").toUpperCase();
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers ?? {})) {
          if (Array.isArray(value)) {
            headers.set(key, value.join(", "));
          } else if (typeof value === "string") {
            headers.set(key, value);
          }
        }
        headers.delete("host");
        headers.delete("content-length");
        const init: RequestInit = { method, headers };
        if (method !== "GET" && method !== "HEAD") {
          init.body = (await readBody(req)) as unknown as BodyInit;
        }
        const response = await fetch(target, init);
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        if (!response.body) {
          res.end();
          return;
        }
        const reader = response.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        res.end();
        return;
      }

      if (req.method === "GET" && isSpaRoute(path)) {
        const status = await fetchApi(apiUrl, "/status");
        sendHtml(res, renderAppShell(apiUrl, path, status));
        return;
      }

      const method = String(req.method ?? "GET").toUpperCase();
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers ?? {})) {
        if (Array.isArray(value)) {
          headers.set(key, value.join(", "));
        } else if (typeof value === "string") {
          headers.set(key, value);
        }
      }
      headers.delete("host");
      headers.delete("content-length");
      const init: RequestInit = { method, headers };
      if (method !== "GET" && method !== "HEAD") {
        init.body = (await readBody(req)) as unknown as BodyInit;
      }
      const response = await fetch(new URL(path + url.search, apiUrl), init);
      const body = await response.arrayBuffer();
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      res.end(Buffer.from(body));
    })().catch((error) => {
      sendText(res, error instanceof Error ? error.message : String(error), 500);
    });
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
