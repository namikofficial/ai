import type { Router } from "express";
import { createStore } from "../../../../../packages/db/src/store.ts";
import { createEvent } from "../../../../../packages/shared/src/index.ts";
import { asyncRoute, isHtmlRequest, readJsonBody, readTextBody, safeParseList } from "../http.ts";
import { json, sendHtml, sendJson } from "../response.ts";
import { renderTaskDetailPage, renderTasksPage } from "../render-pages.ts";

type Store = ReturnType<typeof createStore>;

export function registerTaskRoutes(router: Router, deps: { store: Store }) {
  router.get("/tasks", (req, res) => {
    if (!isHtmlRequest(req)) {
      sendJson(res, json("ok", deps.store.listRecentTasks(100)));
      return;
    }
    sendHtml(res, renderTasksPage(deps.store));
  });

  router.get("/tasks/:taskId", (req, res) => {
    const taskId = decodeURIComponent(String(req.params.taskId ?? ""));
    const task = deps.store.getTask(taskId);
    if (!task) {
      if (isHtmlRequest(req)) {
        sendHtml(res, renderTaskDetailPage(deps.store, taskId), 404);
        return;
      }
      sendJson(res, json("error", undefined, { message: `Unknown task: ${taskId}` }), 404);
      return;
    }
    if (!isHtmlRequest(req)) {
      sendJson(res, json("ok", task));
      return;
    }
    sendHtml(res, renderTaskDetailPage(deps.store, taskId));
  });

  const handleTaskMutation = asyncRoute(async (req, res) => {
    const taskId = decodeURIComponent(String(req.params.taskId ?? ""));
    const action = getTaskAction(req.path);
    const task = deps.store.getTask(taskId);
    if (!task) {
      sendJson(res, json("error", undefined, { message: `Unknown task: ${taskId}` }), 404);
      return;
    }
    const body = (
      req.headers["content-type"]?.includes("application/json")
        ? await readJsonBody(req)
        : Object.fromEntries(new URLSearchParams(await readTextBody(req)))
    ) as Record<string, unknown>;
    const session = deps.store.getSession(task.sessionId);
    const projectId = session?.projectId ?? null;
    let nextTask = task;
    if (action === "start") {
      nextTask = deps.store.updateTask(task.id, { status: "running" });
      if (session) deps.store.updateSession(session.id, { activeTaskId: task.id });
      deps.store.appendEvent(createEvent("task.started", { title: task.title }, { sessionId: task.sessionId, projectId, taskId: task.id, agent: "orchestrator" }));
    } else if (action === "complete") {
      const result = String(body.result ?? body.note ?? "");
      nextTask = deps.store.updateTask(task.id, {
        status: "completed",
        actualFilesJson: JSON.stringify(safeParseList(task.expectedFilesJson)),
        resultJson: JSON.stringify({ result, completedAt: new Date().toISOString() }),
      });
      if (session?.activeTaskId === task.id) deps.store.updateSession(session.id, { activeTaskId: null });
      deps.store.appendEvent(createEvent("task.completed", { title: task.title, result }, { sessionId: task.sessionId, projectId, taskId: task.id, agent: "orchestrator" }));
    } else {
      const error = String(body.error ?? body.note ?? "");
      nextTask = deps.store.updateTask(task.id, {
        status: "failed",
        resultJson: JSON.stringify({ error, failedAt: new Date().toISOString() }),
      });
      if (session?.activeTaskId === task.id) deps.store.updateSession(session.id, { activeTaskId: null });
      deps.store.appendEvent(createEvent("task.failed", { title: task.title, error }, { sessionId: task.sessionId, projectId, taskId: task.id, agent: "orchestrator" }));
    }
    if (isHtmlRequest(req)) {
      sendHtml(res, renderTaskDetailPage(deps.store, nextTask.id));
      return;
    }
    sendJson(res, json("ok", nextTask));
  });

  router.post("/tasks/:taskId/start", handleTaskMutation);
  router.post("/tasks/:taskId/complete", handleTaskMutation);
  router.post("/tasks/:taskId/fail", handleTaskMutation);

  router.get("/checks/:checkId", (req, res) => {
    sendJson(res, json("ok", deps.store.getCheckRun(decodeURIComponent(String(req.params.checkId ?? "")))));
  });
}

function getTaskAction(path: string): "start" | "complete" | "fail" {
  if (path.endsWith("/start")) return "start";
  if (path.endsWith("/complete")) return "complete";
  return "fail";
}
