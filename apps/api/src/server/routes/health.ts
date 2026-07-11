import type { Router } from "express";
import type { ConfigSnapshot } from "../../../../../packages/shared/src/index.ts";
import { json, sendJson } from "../response.ts";

export function registerHealthRoutes(router: Router, deps: {
  buildHealthSnapshot: () => Record<string, unknown>;
  buildDeepHealthSnapshot: () => Promise<Record<string, unknown>>;
  config: ConfigSnapshot;
  listProjects: () => unknown[];
  dashboardSnapshot: () => { activeSessions: number; projects: number; recentSessions: unknown[]; recentLessons: unknown[]; recentChecks: unknown[] };
  getSettings: () => unknown;
}) {
  router.get("/health", (_req, res) => sendJson(res, json("ok", deps.buildHealthSnapshot())));
  router.get("/health/deep", async (_req, res) => {
    const snapshot = await deps.buildDeepHealthSnapshot();
    const dependencies = snapshot.dependencies as { qdrant?: { ok?: boolean }; models?: { ok?: boolean }; worker?: { ok?: boolean } } | undefined;
    const ready = Boolean(snapshot.databaseReachable) &&
      dependencies?.qdrant?.ok !== false &&
      dependencies?.models?.ok === true &&
      dependencies?.worker?.ok === true;
    sendJson(res, json("ok", { ...snapshot, ready, healthStatus: ready ? "ok" : "degraded" }), 200);
  });
  router.get("/version", (_req, res) => sendJson(res, json("ok", { version: "0.1.0", build: "bootstrap" })));
  router.get("/config", (_req, res) =>
    sendJson(res, json("ok", { ...deps.config, projects: deps.listProjects().length, activeSessions: deps.dashboardSnapshot().activeSessions }))
  );
  router.get("/status", (_req, res) => {
    const dashboard = deps.dashboardSnapshot();
    sendJson(res, json("ok", {
      health: deps.buildHealthSnapshot(),
      config: { ...deps.config, projects: deps.listProjects().length, activeSessions: dashboard.activeSessions },
      summary: {
        projects: dashboard.projects,
        activeSessions: dashboard.activeSessions,
        sessions: dashboard.recentSessions.length,
        lessons: dashboard.recentLessons.length,
        checks: dashboard.recentChecks.length,
      },
      projects: deps.listProjects().slice(0, 3),
      sessions: dashboard.recentSessions,
      checks: dashboard.recentChecks,
      settings: deps.getSettings(),
    }));
  });
}
