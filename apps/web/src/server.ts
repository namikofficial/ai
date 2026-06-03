import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
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

const clientScriptAsset = await readFile(new URL("../public/client.js", import.meta.url), "utf8");

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

// Browser client is served from apps/web/public/client.js.

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
  if (/^\/reviews\/[^/]+$/.test(path)) return true;
  if (/^\/mcp\/calls\/[^/]+$/.test(path)) return true;
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
        sendText(res, clientScriptAsset, 200, "application/javascript; charset=utf-8");
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
