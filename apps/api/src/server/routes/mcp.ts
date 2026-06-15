import type { Router } from "express";
import { createStore } from "../../../../../packages/db/src/store.ts";
import { isHtmlRequest } from "../http.ts";
import { json, sendHtml, sendJson } from "../response.ts";
import { renderMcpCallDetailPage, renderMcpPage } from "./ssr.ts";

type Store = ReturnType<typeof createStore>;

export function registerMcpRoutes(router: Router, deps: { store: Store }) {
  router.get("/mcp", (req, res) => {
    if (!isHtmlRequest(req)) {
      sendJson(res, json("ok", deps.store.listMcpCalls(50)));
      return;
    }
    sendHtml(res, renderMcpPage(deps.store));
  });
  router.get("/mcp/calls", (_req, res) => sendJson(res, json("ok", deps.store.listMcpCalls(50))));
  router.get("/mcp/calls/:callId", (req, res) => {
    const callId = decodeURIComponent(String(req.params.callId ?? ""));
    if (!isHtmlRequest(req)) {
      sendJson(res, json("ok", deps.store.getMcpCall(callId)));
      return;
    }
    const call = deps.store.getMcpCall(callId);
    if (!call) {
      sendHtml(res, renderMcpCallDetailPage(deps.store, callId), 404);
      return;
    }
    sendHtml(res, renderMcpCallDetailPage(deps.store, callId));
  });
}
