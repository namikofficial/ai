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

function attachFormHandlers(root) {
  root.querySelectorAll('form[data-endpoint]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const endpoint = form.dataset.endpoint;
      const method = form.dataset.method || 'POST';
      const body = new URLSearchParams(formDataObject(form));
      const result = await api(endpoint, {
        method,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (form.dataset.reload === 'false') {
        form.dispatchEvent(new CustomEvent('ai:submitted', { detail: result }));
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

async function renderFallback(root) {
  root.innerHTML = '<section class="panel" data-span="12"><h3>Loading</h3><div class="tiny">This route is handled by the API server fallback.</div></section>';
}

async function renderApp() {
  const root = document.getElementById('spa');
  if (!root) return;
  const path = location.pathname;
  if (path === '/' || path === '/dashboard') {
    await renderDashboard(root);
    return;
  }
  if (path === '/projects') {
    await renderProjects(root);
    return;
  }
  if (path === '/sessions') {
    await renderSessions(root);
    return;
  }
  if (path === '/tasks') {
    await renderTasks(root);
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
  return path === "/" || path === "/dashboard" || path === "/projects" || path === "/sessions" || path === "/tasks" || path === "/settings";
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
