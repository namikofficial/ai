import type { Router } from "express";
import { createStore } from "../../../../../packages/db/src/store.ts";
import { isHtmlRequest } from "../http.ts";
import { json, sendHtml, sendJson } from "../response.ts";
import { renderSettingsPage } from "./ssr.ts";

type Store = ReturnType<typeof createStore>;

export function registerSettingsRoutes(router: Router, deps: { store: Store; config: Parameters<Store["getSettings"]>[0] }) {
  router.get("/settings", (req, res) => {
    if (!isHtmlRequest(req)) {
      sendJson(res, json("ok", deps.store.getSettings(deps.config)));
      return;
    }
    sendHtml(res, renderSettingsPage(deps.store, deps.config));
  });
}
