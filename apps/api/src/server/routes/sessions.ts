import type { Router } from "express";
import { runAskWorkflow } from "../../../../../packages/ask-engine/src/index.ts";
import type { createStore } from "../../../../../packages/db/src/store.ts";
import type { createModelRuntime } from "../../../../../packages/model-runtime/src/index.ts";
import { compileSessionContextPreview } from "../../../../../packages/session-context/src/index.ts";
import {
  createEvent,
  createId,
  type EventEnvelope,
  type SessionReplayRequest,
  type SharedSessionMessageInput,
} from "../../../../../packages/shared/src/index.ts";
import { asyncRoute, isHtmlRequest, readJsonBody, readTextBody } from "../http.ts";
import { buildPaginatedResponse, parsePagination } from "../pagination.ts";
import { renderSessionDetailPage, renderSessionsPage } from "../render-pages.ts";
import { json, sendHtml, sendJson } from "../response.ts";

type Store = ReturnType<typeof createStore>;

export function registerSessionRoutes(
  router: Router,
  deps: {
    store: Store;
    config: { cloudEnabled: boolean };
    buildRuntimeForStore: () => ReturnType<typeof createModelRuntime>;
    buildSessionTraceData: (sessionId: string) => Record<string, unknown>;
    buildSessionTimeline: (sessionId: string) => unknown | null;
    publish: (event: EventEnvelope) => void;
  }
) {
  const publish = (event: EventEnvelope): void => {
    deps.store.appendEvent(event);
    deps.publish(event);
  };

  const readRequiredString = (
    value: unknown,
    field: string,
    maxLength: number
  ): { value: string | null; error: string | null } => {
    if (typeof value !== "string" || !value.trim()) return { value: null, error: `${field} is required` };
    const normalized = value.trim();
    if (normalized.length > maxLength) {
      return { value: null, error: `${field} exceeds ${maxLength} characters` };
    }
    return { value: normalized, error: null };
  };

  router.post(
    "/sessions",
    asyncRoute(async (req, res) => {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const projectId = typeof body.projectId === "string" && body.projectId.trim() ? body.projectId.trim() : null;
      if (projectId && !deps.store.getProject(projectId)) {
        sendJson(res, json("error", undefined, { message: "project not found" }), 404);
        return;
      }
      const allowedModes = new Set(["local", "cloud", "hybrid", "plan", "handoff", "check", "reflect", "dev"]);
      const requestedMode = typeof body.mode === "string" ? body.mode : "local";
      if (!allowedModes.has(requestedMode)) {
        sendJson(res, json("error", undefined, { message: "unsupported session mode" }), 400);
        return;
      }
      const title = readRequiredString(body.title, "title", 240);
      const userGoal = readRequiredString(body.userGoal, "userGoal", 32_000);
      if (!title.value || !userGoal.value) {
        sendJson(res, json("error", undefined, { message: title.error ?? userGoal.error ?? "invalid session" }), 400);
        return;
      }
      const session = deps.store.createSession({
        projectId,
        title: title.value,
        userGoal: userGoal.value,
        mode: requestedMode as "local" | "cloud" | "hybrid" | "plan" | "handoff" | "check" | "reflect" | "dev",
        source: typeof body.source === "string" && body.source.trim() ? body.source.trim().slice(0, 120) : "api",
        modelProfile:
          typeof body.modelProfile === "string" && body.modelProfile.trim() ? body.modelProfile.trim() : undefined,
      });
      publish(
        createEvent(
          "session.created",
          { title: session.title, mode: session.mode },
          { sessionId: session.id, projectId }
        )
      );
      sendJson(res, json("ok", session), 201);
    })
  );

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
      const session = deps.store.getSession(sessionId);
      if (!session) {
        sendJson(res, json("error", undefined, { message: "session not found" }), 404);
        return;
      }
      sendJson(res, json("ok", session));
      return;
    }
    sendHtml(res, renderSessionDetailPage(deps.store, sessionId));
  });

  router.get("/sessions/:sessionId/messages", (req, res) => {
    const sessionId = decodeURIComponent(String(req.params.sessionId ?? ""));
    if (!deps.store.getSession(sessionId)) {
      sendJson(res, json("error", undefined, { message: "session not found" }), 404);
      return;
    }
    const requestedLimit = Number(req.query.limit ?? 200);
    const limit = Number.isFinite(requestedLimit) ? Math.min(500, Math.max(1, Math.trunc(requestedLimit))) : 200;
    sendJson(res, json("ok", deps.store.conversation.listMessages(sessionId, limit)));
  });

  router.post(
    "/sessions/:sessionId/messages",
    asyncRoute(async (req, res) => {
      const sessionId = decodeURIComponent(String(req.params.sessionId ?? ""));
      const session = deps.store.getSession(sessionId);
      if (!session) {
        sendJson(res, json("error", undefined, { message: "session not found" }), 404);
        return;
      }
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      if (body.role !== "user" && body.role !== "assistant" && body.role !== "agent") {
        sendJson(res, json("error", undefined, { message: "role must be user, assistant, or agent" }), 400);
        return;
      }
      const content = readRequiredString(body.content, "content", 200_000);
      if (!content.value) {
        sendJson(res, json("error", undefined, { message: content.error ?? "invalid content" }), 400);
        return;
      }
      const parentMessageId = typeof body.parentMessageId === "string" ? body.parentMessageId : null;
      if (parentMessageId) {
        const parent = deps.store.conversation.getMessage(parentMessageId);
        if (!parent || parent.sessionId !== sessionId) {
          sendJson(res, json("error", undefined, { message: "parent message does not belong to this session" }), 400);
          return;
        }
      }
      const metadata =
        body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
          ? (body.metadata as Record<string, unknown>)
          : undefined;
      const message = deps.store.conversation.appendMessage({
        sessionId,
        projectId: session.projectId,
        role: body.role as SharedSessionMessageInput["role"],
        agent: typeof body.agent === "string" ? body.agent.slice(0, 120) : null,
        content: content.value,
        parentMessageId,
        meta: metadata,
      });
      publish(
        createEvent(
          "session.message_appended",
          { messageId: message.id, role: message.role, tokenCount: message.tokenCount },
          { sessionId, projectId: session.projectId, agent: message.agent }
        )
      );
      sendJson(res, json("ok", message), 201);
    })
  );

  router.post("/sessions/:sessionId/resume", (req, res) => {
    const sessionId = decodeURIComponent(String(req.params.sessionId ?? ""));
    const session = deps.store.getSession(sessionId);
    if (!session) {
      sendJson(res, json("error", undefined, { message: "session not found" }), 404);
      return;
    }
    if (session.status === "running") {
      sendJson(res, json("ok", session));
      return;
    }
    const resumed = deps.store.updateSession(sessionId, {
      status: "running",
      finishedAt: null,
      durationMs: null,
      errorMessage: null,
    });
    publish(createEvent("session.resumed", {}, { sessionId, projectId: session.projectId }));
    sendJson(res, json("ok", resumed));
  });

  router.post(
    "/sessions/:sessionId/close",
    asyncRoute(async (req, res) => {
      const sessionId = decodeURIComponent(String(req.params.sessionId ?? ""));
      const session = deps.store.getSession(sessionId);
      if (!session) {
        sendJson(res, json("error", undefined, { message: "session not found" }), 404);
        return;
      }
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const status = body.status === "cancelled" ? "cancelled" : "completed";
      const finishedAt = new Date().toISOString();
      const closed = deps.store.updateSession(sessionId, {
        status,
        finishedAt,
        durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(session.startedAt)),
        finalSummary:
          typeof body.summary === "string" && body.summary.trim() ? body.summary.trim().slice(0, 32_000) : null,
      });
      publish(
        createEvent(
          status === "cancelled" ? "session.cancelled" : "session.completed",
          {},
          {
            sessionId,
            projectId: session.projectId,
          }
        )
      );
      sendJson(res, json("ok", closed));
    })
  );

  router.post(
    "/sessions/:sessionId/memory",
    asyncRoute(async (req, res) => {
      const sessionId = decodeURIComponent(String(req.params.sessionId ?? ""));
      const session = deps.store.getSession(sessionId);
      if (!session) {
        sendJson(res, json("error", undefined, { message: "session not found" }), 404);
        return;
      }
      if (!session.projectId) {
        sendJson(res, json("error", undefined, { message: "session has no project scope" }), 409);
        return;
      }
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const memoryBody = readRequiredString(body.body, "body", 100_000);
      if (!memoryBody.value) {
        sendJson(res, json("error", undefined, { message: memoryBody.error ?? "invalid memory" }), 400);
        return;
      }
      const lesson = deps.store.createLesson({
        projectId: session.projectId,
        sessionId,
        title:
          typeof body.title === "string" && body.title.trim()
            ? body.title.trim().slice(0, 240)
            : `Session outcome: ${session.title}`,
        body: memoryBody.value,
        tags: Array.isArray(body.tags)
          ? body.tags
              .map(String)
              .map((tag) => tag.slice(0, 80))
              .slice(0, 20)
          : ["session"],
        importance: Math.min(5, Math.max(1, Number(body.importance ?? 3) || 3)),
      });
      publish(
        createEvent(
          "lesson.created",
          { lessonId: lesson.id, title: lesson.title, source: "shared-session" },
          { sessionId, projectId: session.projectId, agent: "session-memory" }
        )
      );
      sendJson(res, json("ok", lesson), 201);
    })
  );

  router.get(
    "/sessions/:sessionId/context",
    asyncRoute(async (req, res) => {
      const sessionId = decodeURIComponent(String(req.params.sessionId ?? ""));
      const requestedBudget = Number(req.query.tokenBudget ?? 8_000);
      const tokenBudget = Number.isFinite(requestedBudget)
        ? Math.min(32_000, Math.max(1_000, Math.trunc(requestedBudget)))
        : 8_000;
      const query = typeof req.query.query === "string" && req.query.query.trim() ? req.query.query.trim() : null;
      const preview = await compileSessionContextPreview(deps.store, { sessionId, query, tokenBudget });
      if (!preview) {
        sendJson(res, json("error", undefined, { message: "session not found" }), 404);
        return;
      }
      sendJson(res, json("ok", preview));
    })
  );

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

  router.post(
    "/sessions/:sessionId/replay",
    asyncRoute(async (req, res) => {
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
        (parentSession.mode === "plan" ||
        parentSession.mode === "handoff" ||
        parentSession.mode === "check" ||
        parentSession.mode === "reflect"
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
      deps.store.db
        .prepare(`INSERT INTO session_replays (
      id, parent_session_id, child_session_id, source_session_id, mode, request_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
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
        sendJson(
          res,
          json("ok", {
            parentSessionId: parentSession.id,
            childSession: branchSession,
            replay: { dryRun: true, request: input },
          })
        );
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
      sendJson(
        res,
        json("ok", {
          parentSessionId: parentSession.id,
          childSession: deps.store.getSession(branchSession.id),
          replay: { request: input, result },
        })
      );
    })
  );
}
