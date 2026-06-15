import type { Router } from "express";
import { resolveProjectConfig } from "../../../../../packages/config/src/index.ts";
import { createStore } from "../../../../../packages/db/src/store.ts";
import { asyncRoute, isHtmlRequest, readJsonBody, readTextBody } from "../http.ts";
import { json, sendHtml, sendJson } from "../response.ts";
import { renderRetrievalPage } from "../render-pages.ts";
import { parsePagination, buildPaginatedResponse } from "../pagination.ts";

type Store = ReturnType<typeof createStore>;

export function registerRetrievalRoutes(router: Router, deps: {
  store: Store;
  readProjectGraph: (projectId: string) => unknown;
  runExplainWithStore: (input: { projectId: string; query: string; mode: "local" | "hybrid" | "cloud"; depth: "shallow" | "standard" | "deep"; limit: number }) => unknown;
}) {
  router.get("/retrieval", (req, res) => {
    if (!isHtmlRequest(req)) {
      sendJson(res, json("ok", { projects: deps.store.listProjects(), recentLessons: deps.store.listRecentLessons(20) }));
      return;
    }
    sendHtml(res, renderRetrievalPage(deps.store));
  });

  router.post("/retrieval/search", asyncRoute(async (req, res) => {
    const body = (
      req.headers["content-type"]?.includes("application/json")
        ? await readJsonBody(req)
        : Object.fromEntries(new URLSearchParams(await readTextBody(req)))
    ) as Record<string, unknown>;
    const projectId = String(body.project ?? body.projectId ?? "");
    const query = String(body.query ?? "");
    const chunks = deps.store.searchChunks(projectId, query, { limit: Number(body.limit ?? 8) || 8 });
    if (isHtmlRequest(req)) {
      sendHtml(res, renderRetrievalPage(deps.store, { projectId, query, chunks }));
      return;
    }
    sendJson(res, json("ok", chunks));
  }));

  router.post("/retrieval/explain", asyncRoute(async (req, res) => {
    const body = (
      req.headers["content-type"]?.includes("application/json")
        ? await readJsonBody(req)
        : Object.fromEntries(new URLSearchParams(await readTextBody(req)))
    ) as Record<string, unknown>;
    const projectId = String(body.project ?? body.projectId ?? "");
    const query = String(body.query ?? "");
    const mode = body.mode === "cloud" || body.mode === "hybrid" ? body.mode : "local";
    const depth = body.depth === "shallow" || body.depth === "deep" ? body.depth : "standard";
    const limit = Number(body.limit ?? 8) || 8;
    if (!projectId || !query) {
      sendJson(res, json("error", undefined, { message: "project and query are required" }));
      return;
    }
    if (!deps.store.getProject(projectId)) {
      sendJson(res, json("error", undefined, { message: `Unknown project: ${projectId}` }));
      return;
    }
    sendJson(res, json("ok", deps.runExplainWithStore({ projectId, query, mode, depth, limit })));
  }));

  router.post("/context/explain", asyncRoute(async (req, res) => {
    const body = (
      req.headers["content-type"]?.includes("application/json")
        ? await readJsonBody(req)
        : Object.fromEntries(new URLSearchParams(await readTextBody(req)))
    ) as Record<string, unknown>;
    const projectId = String(body.project ?? body.projectId ?? "");
    const query = String(body.query ?? "");
    const mode = body.mode === "cloud" || body.mode === "hybrid" ? body.mode : "local";
    const depth = body.depth === "shallow" || body.depth === "deep" ? body.depth : "standard";
    const limit = Number(body.limit ?? 8) || 8;
    const project = deps.store.getProject(projectId);
    if (!project) {
      sendJson(res, json("error", undefined, { message: `Unknown project: ${projectId}` }), 404);
      return;
    }
    const explanation = deps.runExplainWithStore({ projectId, query, mode, depth, limit }) as { selected: Array<{ path: string; finalScore: number }>; ranked: Array<{ path: string; rerankReason?: string }> };
    sendJson(res, json("ok", {
      project,
      config: resolveProjectConfig(project.path),
      graph: deps.readProjectGraph(project.id),
      explanation,
      selectionReasons: explanation.selected.map((entry) => ({
        path: entry.path,
        finalScore: entry.finalScore,
        rerankReason: explanation.ranked.find((ranked) => ranked.path === entry.path)?.rerankReason ?? "selected",
      })),
    }));
  }));

  router.post("/retrieval/context", asyncRoute(async (req, res) => {
    const body = (
      req.headers["content-type"]?.includes("application/json")
        ? await readJsonBody(req)
        : Object.fromEntries(new URLSearchParams(await readTextBody(req)))
    ) as Record<string, unknown>;
    const projectId = String(body.project ?? body.projectId ?? "");
    const query = String(body.query ?? "");
    const chunks = deps.store.searchChunks(projectId, query, { limit: Number(body.limit ?? 8) || 8 });
    sendJson(res, json("ok", { query, selectedFiles: [...new Set(chunks.map((chunk) => chunk.path))], chunks }));
  }));

  router.get("/retrieval/queries", (req, res) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : null;
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
    const pagination = parsePagination(req, 50);
    const limit = pagination.limit + 1;
    const queries = sessionId
      ? deps.store.retrieval.listQueriesForSession(sessionId, limit)
      : projectId
        ? deps.store.retrieval.listQueriesForProject(projectId, limit)
        : deps.store.retrieval.listQueriesForProject(deps.store.listProjects()[0]?.id ?? "", limit).slice(0, 0);
    const response = buildPaginatedResponse(queries, pagination);
    sendJson(res, json("ok", response));
  });

  router.get("/retrieval/queries/:id", (req, res) => {
    const id = decodeURIComponent(String(req.params.id ?? ""));
    const query = deps.store.retrieval.getQuery(id);
    if (!query) {
      sendJson(res, json("error", undefined, { message: "retrieval query not found" }), 404);
      return;
    }
    sendJson(res, json("ok", {
      query,
      rewrites: deps.store.retrieval.listRewrites(id),
      results: deps.store.retrieval.listResults(id),
      selected: deps.store.retrieval.listSelectedContext(id),
      misses: deps.store.retrieval.listMisses(id),
      feedback: deps.store.retrieval.listFeedback(id),
    }));
  });
}
