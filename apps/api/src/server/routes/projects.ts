import type { Router } from "express";
import { resolveProjectConfig } from "../../../../../packages/config/src/index.ts";
import { createStore } from "../../../../../packages/db/src/store.ts";
import { parseProjectCreateInput } from "../../../../../packages/shared/src/index.ts";
import type { EventEnvelope } from "../../../../../packages/shared/src/index.ts";
import { asyncRoute, isHtmlRequest, readJsonBody, readTextBody } from "../http.ts";
import { json, redirect, sendHtml, sendJson } from "../response.ts";
import { renderProjectDetailPage, renderProjectsPage } from "./ssr.ts";

type Store = ReturnType<typeof createStore>;

export function registerProjectRoutes(router: Router, deps: {
  store: Store;
  publish: (event: EventEnvelope) => void;
  readProjectGraph: (projectId: string) => unknown;
}) {
  router.get("/projects", (req, res) => {
    if (!isHtmlRequest(req)) {
      sendJson(res, json("ok", deps.store.listProjects()));
      return;
    }
    sendHtml(res, renderProjectsPage(deps.store));
  });

  router.post("/projects", asyncRoute(async (req, res) => {
    const body = (
      req.headers["content-type"]?.includes("application/json")
        ? await readJsonBody(req)
        : Object.fromEntries(new URLSearchParams(await readTextBody(req)))
    ) as Record<string, unknown>;
    const project = deps.store.createProject(parseProjectCreateInput(body));
    if (isHtmlRequest(req)) {
      redirect(res, `/projects/${project.id}`);
      return;
    }
    sendJson(res, json("ok", project));
  }));

  router.get("/projects/:projectId", (req, res) => {
    const projectId = decodeURIComponent(String(req.params.projectId ?? ""));
    if (!isHtmlRequest(req)) {
      sendJson(res, json("ok", deps.store.getProject(projectId)));
      return;
    }
    sendHtml(res, renderProjectDetailPage(deps.store, projectId, deps.readProjectGraph(projectId) as never));
  });

  router.get("/projects/:projectId/symbols", (req, res) => {
    const projectId = decodeURIComponent(String(req.params.projectId ?? ""));
    const project = deps.store.getProject(projectId);
    if (!project) {
      sendJson(res, json("error", undefined, { message: "project not found" }), 404);
      return;
    }
    const query = req.query.query || req.query.q || null;
    const limit = Number(req.query.limit || 50) || 50;
    const symbols = deps.store.codeIntelligence.listSymbols(project.id, typeof query === "string" ? query : null, limit);
    const total = deps.store.codeIntelligence.countSymbols(project.id);
    sendJson(res, json("ok", { project, symbols, query, limit, total }));
  });

  router.get("/projects/:projectId/graph", (req, res) => {
    const projectId = decodeURIComponent(String(req.params.projectId ?? ""));
    const project = deps.store.getProject(projectId);
    if (!project) {
      sendJson(res, json("error", undefined, { message: "project not found" }), 404);
      return;
    }
    const graph = deps.readProjectGraph(project.id);
    const topSymbols = deps.store.codeIntelligence.listSymbols(project.id, null, 20);
    const topEdges = deps.store.codeIntelligence.listEdges(project.id, 20);
    sendJson(res, json("ok", {
      project,
      config: resolveProjectConfig(project.path),
      graph,
      counts: {
        symbols: deps.store.codeIntelligence.countSymbols(project.id),
        edges: deps.store.codeIntelligence.countEdges(project.id),
        routeFiles: (graph as { routeFiles?: unknown[] } | null)?.routeFiles?.length ?? 0,
        middlewareFiles: (graph as { middlewareFiles?: unknown[] } | null)?.middlewareFiles?.length ?? 0,
        dbFiles: (graph as { dbFiles?: unknown[] } | null)?.dbFiles?.length ?? 0,
        authPaths: (graph as { authPaths?: unknown[] } | null)?.authPaths?.length ?? 0,
      },
      topSymbols,
      topEdges,
      symbols: topSymbols,
      edges: topEdges,
    }));
  });

  router.post("/projects/:projectId/index", asyncRoute(async (req, res) => {
    const projectId = decodeURIComponent(String(req.params.projectId ?? ""));
    const result = await deps.store.indexProject(projectId);
    result.events.forEach(deps.publish);
    if (isHtmlRequest(req)) {
      redirect(res, `/sessions/${result.session.id}`);
      return;
    }
    sendJson(res, json("ok", result));
  }));

  router.get("/projects/:projectId/memory", (req, res) => {
    const projectId = decodeURIComponent(String(req.params.projectId ?? ""));
    sendJson(res, json("ok", {
      lessons: deps.store.listProjectLessons(projectId),
      rules: deps.store.listProjectRules(projectId),
      memory: deps.store.listProjectMemory(projectId),
    }));
  });

  router.get("/projects/:projectId/retrieval", (req, res) => {
    const projectId = decodeURIComponent(String(req.params.projectId ?? ""));
    const query = String(req.query.q ?? "");
    sendJson(res, json("ok", { chunks: deps.store.searchChunks(projectId, query, { limit: 20 }), query }));
  });

  router.get("/symbols/:symbolId", (req, res) => {
    const symbolId = decodeURIComponent(String(req.params.symbolId ?? ""));
    if (!symbolId) {
      sendJson(res, json("error", undefined, { message: "symbol id required" }), 400);
      return;
    }
    const symbol = deps.store.codeIntelligence.getSymbol(symbolId);
    if (!symbol) {
      sendJson(res, json("error", undefined, { message: "symbol not found" }), 404);
      return;
    }
    const project = deps.store.getProject(symbol.projectId);
    const chunks = deps.store.codeIntelligence.listSymbolChunks(symbolId);
    const edges = deps.store.codeIntelligence.listEdgesForSymbol(symbolId);
    const relatedSymbolIds = new Set<string>();
    for (const edge of edges) {
      if (edge.fromSymbolId !== symbolId) relatedSymbolIds.add(edge.fromSymbolId);
      if (edge.toSymbolId !== symbolId) relatedSymbolIds.add(edge.toSymbolId);
    }
    const relatedSymbols = Array.from(relatedSymbolIds)
      .map((id) => deps.store.codeIntelligence.getSymbol(id))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    sendJson(res, json("ok", {
      projectId: symbol.projectId,
      filePath: symbol.path,
      projectPath: project?.path ?? null,
      symbolPath: symbol.path,
      project: project ? { id: project.id, path: project.path, name: project.name } : null,
      symbol,
      chunks,
      edges,
      relatedSymbols,
    }));
  });
}
