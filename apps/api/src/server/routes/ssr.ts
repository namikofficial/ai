import type { Router } from "express";
import { redirect, sendHtml } from "../response.ts";
import { escapeHtml, pageShell } from "../render-pages.ts";

export { escapeHtml, pageShell };

export function registerSsrRoutes(router: Router, deps: { renderDashboard: () => string }) {
  router.get("/", (_req, res) => redirect(res, "/dashboard"));
  router.get("/dashboard", (_req, res) => sendHtml(res, deps.renderDashboard()));
}
