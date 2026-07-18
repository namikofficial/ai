import type { Router } from "express";
import type { RuntimeHealth } from "../../../../../packages/contracts/src/index.ts";
import type { ConfigSnapshot, EventEnvelope } from "../../../../../packages/shared/src/index.ts";
import { json, sendJson } from "../response.ts";

export function registerHealthRoutes(
  router: Router,
  deps: {
    buildHealthSnapshot: () => Record<string, unknown>;
    buildDeepHealthSnapshot: () => Promise<Record<string, unknown>>;
    buildRuntimeHealth: () => Promise<RuntimeHealth>;
    config: ConfigSnapshot;
    listProjects: () => unknown[];
    dashboardSnapshot: () => {
      activeSessions: number;
      projects: number;
      recentSessions: unknown[];
      recentLessons: unknown[];
      recentChecks: unknown[];
    };
    getSettings: () => unknown;
    listRecentEvents: () => EventEnvelope[];
  }
) {
  router.get("/health", (_req, res) => sendJson(res, json("ok", deps.buildHealthSnapshot())));
  router.get("/ready", (_req, res) => {
    const snapshot = deps.buildHealthSnapshot();
    const ready = snapshot.databaseReachable === true;
    sendJson(res, json(ready ? "ok" : "error", { ready, databaseReachable: ready }), ready ? 200 : 503);
  });
  router.get("/runtime/health", async (_req, res) => {
    const runtime = await deps.buildRuntimeHealth();
    sendJson(res, json(runtime.ready ? "ok" : "error", runtime), runtime.ready ? 200 : 503);
  });
  router.get("/diagnostics", async (_req, res) => {
    const runtime = await deps.buildRuntimeHealth();
    const recentFailures = deps
      .listRecentEvents()
      .filter(
        (event) =>
          event.severity === "error" ||
          event.severity === "critical" ||
          event.type.endsWith(".failed") ||
          event.type === "runtime.degraded"
      )
      .slice(-20)
      .map((event) => ({
        id: event.id,
        type: event.type,
        occurredAt: event.occurredAt,
        severity: event.severity,
        summary: event.summary,
        projectId: event.projectId,
        sessionId: event.sessionId,
        taskId: event.taskId,
        runId: event.runId,
        correlationId: event.correlationId,
      }));
    sendJson(
      res,
      json("ok", {
        generatedAt: new Date().toISOString(),
        core: deps.buildHealthSnapshot(),
        runtime,
        eventStream: runtime.components.find((component) => component.id === "event-stream") ?? null,
        recentFailures,
      })
    );
  });
  router.get("/health/deep", async (_req, res) => {
    const snapshot = await deps.buildDeepHealthSnapshot();
    const dependencies = snapshot.dependencies as
      | { qdrant?: { ok?: boolean }; models?: { ok?: boolean }; worker?: { ok?: boolean } }
      | undefined;
    const ready = Boolean(snapshot.databaseReachable);
    const optionalReady =
      dependencies?.qdrant?.ok !== false && dependencies?.models?.ok === true && dependencies?.worker?.ok === true;
    sendJson(res, json("ok", { ...snapshot, ready, healthStatus: ready && optionalReady ? "ok" : "degraded" }), 200);
  });
  router.get("/version", (_req, res) => sendJson(res, json("ok", { version: "0.1.0", build: "bootstrap" })));
  router.get("/config", (_req, res) =>
    sendJson(
      res,
      json("ok", {
        ...deps.config,
        projects: deps.listProjects().length,
        activeSessions: deps.dashboardSnapshot().activeSessions,
      })
    )
  );
  router.get("/status", (_req, res) => {
    const dashboard = deps.dashboardSnapshot();
    sendJson(
      res,
      json("ok", {
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
      })
    );
  });
}
