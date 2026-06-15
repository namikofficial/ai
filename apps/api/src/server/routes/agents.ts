import type { Router } from "express";
import { createStore } from "../../../../../packages/db/src/store.ts";
import { asyncRoute, readJsonBody } from "../http.ts";
import { json, sendJson } from "../response.ts";
import { parsePagination, buildPaginatedResponse } from "../pagination.ts";

type Store = ReturnType<typeof createStore>;

export function registerAgentRoutes(router: Router, deps: { store: Store }) {
  router.get("/agents/runs", (req, res) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : null;
    const pagination = parsePagination(req, 50);
    const runs = sessionId ? deps.store.agents.listRuns(sessionId, pagination.limit + 1) : [];
    const response = buildPaginatedResponse(runs, pagination);
    sendJson(res, json("ok", response));
  });

  router.get("/agents/runs/:id", (req, res) => {
    const run = deps.store.agents.getRun(decodeURIComponent(String(req.params.id ?? "")));
    if (!run) {
      sendJson(res, json("error", undefined, { message: "agent run not found" }), 404);
      return;
    }
    sendJson(res, json("ok", { run, messages: deps.store.agents.listMessages(run.id) }));
  });

  router.get("/agents/handoffs", (req, res) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : null;
    sendJson(res, json("ok", sessionId ? deps.store.agents.listHandoffs(sessionId, 100) : deps.store.agents.listAllHandoffs(100)));
  });

  router.get("/context/packs", (req, res) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : null;
    const pagination = parsePagination(req, 50);
    const packs = sessionId ? deps.store.context.listPacksForSession(sessionId, pagination.limit + 1) : [];
    const response = buildPaginatedResponse(packs, pagination);
    sendJson(res, json("ok", response));
  });

  router.get("/context/packs/:id", (req, res) => {
    const id = decodeURIComponent(String(req.params.id ?? ""));
    const pack = deps.store.context.getPack(id);
    if (!pack) {
      sendJson(res, json("error", undefined, { message: "context pack not found" }), 404);
      return;
    }
    sendJson(res, json("ok", { pack, items: deps.store.context.listItems(id), budgetEvents: deps.store.context.listBudgetEvents(id) }));
  });

  router.get("/conversations/:sessionId", (req, res) => {
    sendJson(res, json("ok", deps.store.conversation.listMessages(decodeURIComponent(String(req.params.sessionId ?? "")), 200)));
  });

  router.get("/skills/candidates", (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status as "pending" | "active" | "deprecated" | "rejected" : undefined;
    sendJson(res, json("ok", deps.store.skills.listCandidates(status, 100)));
  });

  const reviewSkillCandidate = asyncRoute(async (req, res) => {
    const id = decodeURIComponent(String(req.params.id ?? ""));
    const action = req.path.endsWith("/accept") ? "accept" : "reject";
    if (action === "accept") {
      sendJson(res, json("ok", deps.store.skills.acceptCandidate(id)));
      return;
    }
    const body = (await readJsonBody(req)) as { reason?: string } | null;
    deps.store.skills.reviewCandidate(id, "rejected");
    sendJson(res, json("ok", { id, status: "rejected", reason: body?.reason ?? null }));
  });
  router.post("/skills/candidates/:id/accept", reviewSkillCandidate);
  router.post("/skills/candidates/:id/reject", reviewSkillCandidate);

  router.get("/skills", (_req, res) => sendJson(res, json("ok", deps.store.skills.listSkills())));
}
