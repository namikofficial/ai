import { createStore } from "../../../../../packages/db/src/store.ts";
import { createId, type SessionReplayRequest } from "../../../../../packages/shared/src/index.ts";
import { runAskWorkflow } from "../../../../../packages/ask-engine/src/index.ts";
import { createModelRuntime } from "../../../../../packages/model-runtime/src/index.ts";
import { asyncRoute, isHtmlRequest, readJsonBody, readTextBody } from "../http.ts";
import { json, sendHtml, sendJson } from "../response.ts";
import { parsePagination, buildPaginatedResponse, DEFAULT_LIMIT, MAX_LIMIT } from "../pagination.ts";
import { renderSessionDetailPage, renderSessionsPage } from "../render-pages.ts";
import type { Router } from "express";

type Store = ReturnType<typeof createStore>;

export function registerSessionRoutes(router: Router, deps: {
  store: Store;
  config: { cloudEnabled: boolean };
  buildRuntimeForStore: () => ReturnType<typeof createModelRuntime>;
  buildSessionTraceData: (sessionId: string) => Record<string, unknown>;
  buildSessionTimeline: (sessionId: string) => unknown | null;
}) {
  router.get("/sessions", (req, res) => {
    if (!isHtmlRequest(req)) {
      sendJson(res, json("ok", deps.store.listSessions(100)));
      return;
    }
    sendHtml(res, renderSessionsPage(deps.store));
  });

  router.get("/sessions/:sessionId", (req, res) => {
    const sessionId = decodeURIComponent(String(req.params.sessionId ?? ""));
    if (!isHtmlRequest(req)) {
      sendJson(res, json("ok", deps.store.getSession(sessionId)));
      return;
    }
    sendHtml(res, renderSessionDetailPage(deps.store, sessionId));
  });

  router.get("/sessions/:sessionId/events", (req, res) => {
    const sessionId = decodeURIComponent(String(req.params.sessionId ?? ""));
    const pagination = parsePagination(req, 100);
    const events = deps.store.listEvents(sessionId, pagination.limit + 1); // fetch one extra to check hasMore
    const response = buildPaginatedResponse(events, pagination);
    sendJson(res, json("ok", response));
  });

  router.get("/sessions/:sessionId/timeline", (req, res) => {
    const sessionId = decodeURIComponent(String(req.params.sessionId ?? ""));
    if (!deps.store.getSession(sessionId)) {
      sendJson(res, json("error", undefined, { message: "session not found" }), 404);
      return;
    }
    sendJson(res, json("ok", deps.buildSessionTimeline(sessionId)));
  });

  router.get("/sessions/:sessionId/trace", (req, res) => {
    const sessionId = decodeURIComponent(String(req.params.sessionId ?? ""));
    const trace = deps.buildSessionTraceData(sessionId);
    if (!trace.session) {
      sendJson(res, json("error", undefined, { message: "session not found" }), 404);
      return;
    }
    sendJson(res, json("ok", trace));
  });

  router.post("/sessions/:sessionId/replay", asyncRoute(async (req, res) => {
    const sessionId = decodeURIComponent(String(req.params.sessionId ?? ""));
    const body = (
      req.headers["content-type"]?.includes("application/json")
        ? await readJsonBody(req)
        : Object.fromEntries(new URLSearchParams(await readTextBody(req)))
    ) as Record<string, unknown>;
    const input: SessionReplayRequest = {
      fromTimelineItemId: typeof body.fromTimelineItemId === "string" ? body.fromTimelineItemId : undefined,
      editedUserRequest: typeof body.editedUserRequest === "string" ? body.editedUserRequest : undefined,
      editedSystemPrompt: typeof body.editedSystemPrompt === "string" ? body.editedSystemPrompt : undefined,
      editedContextPackId: typeof body.editedContextPackId === "string" ? body.editedContextPackId : undefined,
      selectedPromptId: typeof body.selectedPromptId === "string" ? body.selectedPromptId : undefined,
      modelProfileId: typeof body.modelProfileId === "string" ? body.modelProfileId : undefined,
      mode: body.mode === "local" || body.mode === "hybrid" || body.mode === "cloud" ? body.mode : undefined,
      dryRun: body.dryRun === true || body.dryRun === "true",
    };
    const parentSession = deps.store.getSession(sessionId);
    if (!parentSession) {
      sendJson(res, json("error", undefined, { message: "session not found" }), 404);
      return;
    }
    const replayQuestion = input.editedUserRequest ?? parentSession.userGoal;
    const replayMode =
      input.mode ??
      (parentSession.mode === "plan" || parentSession.mode === "handoff" || parentSession.mode === "check" || parentSession.mode === "reflect"
        ? "local"
        : parentSession.mode);
    const branchSession = deps.store.createSession({
      projectId: parentSession.projectId,
      title: `Replay: ${parentSession.title}`,
      userGoal: replayQuestion,
      mode: replayMode === "local" || replayMode === "hybrid" || replayMode === "cloud" ? replayMode : "local",
      source: "replay",
      modelProfile: input.modelProfileId ?? parentSession.modelProfile,
    });
    deps.store.db.prepare(`INSERT INTO session_replays (
      id, parent_session_id, child_session_id, source_session_id, mode, request_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      createId("srep"),
      parentSession.id,
      branchSession.id,
      input.fromTimelineItemId ?? null,
      replayMode === "local" || replayMode === "hybrid" || replayMode === "cloud" ? replayMode : "local",
      JSON.stringify(input),
      new Date().toISOString(),
      new Date().toISOString()
    );
    if (input.dryRun) {
      sendJson(res, json("ok", { parentSessionId: parentSession.id, childSession: branchSession, replay: { dryRun: true, request: input } }));
      return;
    }
    const result = await runAskWorkflow({
      store: deps.store,
      runtime: deps.buildRuntimeForStore(),
      cloudEnabled: deps.config.cloudEnabled,
      input: {
        project: parentSession.projectId ?? "",
        question: replayQuestion,
        mode: replayMode === "local" || replayMode === "hybrid" || replayMode === "cloud" ? replayMode : "local",
        depth: "standard",
      },
      preferredAnswerProfileId: input.modelProfileId ?? parentSession.modelProfile,
      sessionId: branchSession.id,
    });
    sendJson(res, json("ok", {
      parentSessionId: parentSession.id,
      childSession: deps.store.getSession(branchSession.id),
      replay: { request: input, result },
    }));
  }));
}
