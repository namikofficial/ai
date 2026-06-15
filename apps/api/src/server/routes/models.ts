import type { Router } from "express";
import { createStore } from "../../../../../packages/db/src/store.ts";
import { asyncRoute, isHtmlRequest, readJsonBody, readTextBody } from "../http.ts";
import { json, sendHtml, sendJson } from "../response.ts";
import { renderModelsPage } from "./ssr.ts";

type Store = ReturnType<typeof createStore>;

export function registerModelRoutes(router: Router, deps: { store: Store; config: Parameters<Store["getSettings"]>[0] }) {
  router.get("/models", (req, res) => {
    if (!isHtmlRequest(req)) {
      sendJson(res, json("ok", { usage: deps.store.listModelUsage(50), settings: deps.store.getSettings(deps.config) }));
      return;
    }
    sendHtml(res, renderModelsPage(deps.store, deps.config));
  });

  router.get("/models/providers", (_req, res) => {
    sendJson(res, json("ok", { providers: deps.store.models.listProviders(), profiles: deps.store.models.listProfiles() }));
  });
  router.get("/models/routes", (_req, res) => sendJson(res, json("ok", deps.store.listModelRoutes(100))));
  router.get("/models/calls", (req, res) => sendJson(res, json("ok", deps.store.models.listAllCalls(Number(req.query.limit ?? "50") || 50))));

  router.post("/models/route", asyncRoute(async (req, res) => {
    const body = (
      req.headers["content-type"]?.includes("application/json")
        ? await readJsonBody(req)
        : Object.fromEntries(new URLSearchParams(await readTextBody(req)))
    ) as Record<string, unknown>;
    const selectedProfileId = deps.store.recommendModelProfile(
      body.mode === "cloud" || body.mode === "hybrid" || body.mode === "local" ? body.mode : "any",
      {
        risk: body.risk === "low" || body.risk === "medium" || body.risk === "high" ? body.risk : undefined,
        depth: body.depth === "shallow" || body.depth === "standard" || body.depth === "deep" ? body.depth : undefined,
        question: body.question ? String(body.question) : undefined,
        goal: body.goal ? String(body.goal) : undefined,
      }
    );
    const route = deps.store.recordModelRoute({
      taskPattern: String(body.taskPattern ?? body.task ?? "ask"),
      mode: body.mode === "cloud" || body.mode === "hybrid" || body.mode === "local" ? body.mode : "any",
      selectedProfileId,
      fallbackProfileId: body.fallbackProfileId ? String(body.fallbackProfileId) : null,
      reason: body.reason ? String(body.reason) : null,
    });
    sendJson(res, json("ok", { route, profile: deps.store.models.getProfile(selectedProfileId) }));
  }));

  router.post("/models/health/check", asyncRoute(async (req, res) => {
    const body = (
      req.headers["content-type"]?.includes("application/json")
        ? await readJsonBody(req)
        : Object.fromEntries(new URLSearchParams(await readTextBody(req)))
    ) as Record<string, unknown>;
    const providerId = String(body.providerId ?? "");
    if (!providerId) {
      sendJson(res, json("error", undefined, { message: "providerId is required" }), 400);
      return;
    }
    const check = deps.store.models.recordHealthCheck({
      providerId,
      profileId: body.profileId ? String(body.profileId) : null,
      status: body.status === "healthy" || body.status === "degraded" || body.status === "unreachable" || body.status === "disabled" ? body.status : "healthy",
      latencyMs: body.latencyMs == null ? null : Number(body.latencyMs),
      detail: body.detail ? String(body.detail) : null,
    });
    sendJson(res, json("ok", check));
  }));

  router.get("/models/health", (_req, res) => {
    const providers = deps.store.models.listProviders();
    const profiles = deps.store.models.listProfiles();
    const recentCalls = deps.store.models.listAllCalls(20);
    const profileById = new Map(profiles.map((p) => [p.id, p]));
    const lastByProvider = new Map<string, (typeof recentCalls)[number]>();
    for (const call of recentCalls) {
      const profile = profileById.get(call.profileId);
      if (profile && !lastByProvider.has(profile.providerId)) lastByProvider.set(profile.providerId, call);
    }
    sendJson(res, json("ok", {
      providers: providers.map((provider) => ({ ...provider, lastCall: lastByProvider.get(provider.id) ?? null })),
      recentCalls,
    }));
  });
}
