import type { Router } from "express";
import type { createStore } from "../../../../../packages/db/src/store.ts";
import { createEvent } from "../../../../../packages/shared/src/index.ts";
import { asyncRoute, isHtmlRequest, readJsonBody, readTextBody } from "../http.ts";
import { renderMemoryPage } from "../render-pages.ts";
import { json, sendHtml, sendJson } from "../response.ts";

type Store = ReturnType<typeof createStore>;

export function registerMemoryRoutes(router: Router, deps: { store: Store }) {
  router.get("/memory", (req, res) => {
    if (!isHtmlRequest(req)) {
      sendJson(
        res,
        json("ok", {
          projects: deps.store.listProjects().map((project) => ({
            project,
            lessons: deps.store.listProjectLessons(project.id, 5),
            rules: deps.store.listProjectRules(project.id, 5),
            memory: deps.store.listProjectMemory(project.id, 5),
          })),
        })
      );
      return;
    }
    sendHtml(res, renderMemoryPage(deps.store));
  });

  router.post(
    "/memory/lesson",
    asyncRoute(async (req, res) => {
      const body = (
        req.headers["content-type"]?.includes("application/json")
          ? await readJsonBody(req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(req)))
      ) as Record<string, unknown>;
      const lesson = deps.store.createLesson({
        projectId: body.projectId ? String(body.projectId) : null,
        sessionId: body.sessionId ? String(body.sessionId) : null,
        title: String(body.title ?? "Memory note"),
        body: String(body.body ?? ""),
        tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
        importance: Number(body.importance ?? 1),
      });
      if (isHtmlRequest(req)) {
        sendHtml(res, renderMemoryPage(deps.store));
        return;
      }
      sendJson(res, json("ok", lesson));
    })
  );

  router.post(
    "/memory/reflect",
    asyncRoute(async (req, res) => {
      const body = (
        req.headers["content-type"]?.includes("application/json")
          ? await readJsonBody(req)
          : Object.fromEntries(new URLSearchParams(await readTextBody(req)))
      ) as Record<string, unknown>;
      const sessionId = String(body.sessionId ?? "");
      const session = deps.store.getSession(sessionId);
      if (!session) throw new Error(`Unknown session: ${sessionId}`);
      const lesson = deps.store.createLesson({
        projectId: session.projectId,
        sessionId,
        title: `Reflection: ${session.title}`,
        body: session.finalSummary ?? session.userGoal,
        tags: ["reflection"],
        importance: 3,
      });
      deps.store.appendEvent(
        createEvent(
          "lesson.created",
          { title: lesson.title, body: lesson.body, tags: ["reflection"], importance: 3 },
          { sessionId, projectId: session.projectId, agent: "learning" }
        )
      );
      if (isHtmlRequest(req)) {
        sendHtml(res, renderMemoryPage(deps.store));
        return;
      }
      sendJson(res, json("ok", lesson));
    })
  );

  router.get("/memory/candidates", (req, res) => {
    const status =
      typeof req.query.status === "string" ? (req.query.status as "pending" | "accepted" | "rejected") : null;
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
    sendJson(res, json("ok", deps.store.memory.listCandidates(status ?? "pending", projectId, 100)));
  });

  const reviewCandidate = asyncRoute(async (req, res) => {
    const id = decodeURIComponent(String(req.params.id ?? ""));
    const action = req.path.endsWith("/accept") ? "accept" : "reject";
    const body = (await readJsonBody(req)) as { notes?: string; reason?: string } | null;
    if (action === "accept") {
      sendJson(res, json("ok", deps.store.memory.acceptCandidate(id, body?.notes ?? null)));
      return;
    }
    deps.store.memory.reviewCandidate(id, "rejected", body?.reason ?? null);
    sendJson(res, json("ok", { id, status: "rejected" }));
  });
  router.post("/memory/candidates/:id/accept", reviewCandidate);
  router.post("/memory/candidates/:id/reject", reviewCandidate);

  router.get("/memory/entries", (req, res) => {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
    const scope =
      typeof req.query.scope === "string" ? (req.query.scope as "global" | "project" | "repo" | "path") : null;
    sendJson(res, json("ok", deps.store.memory.listEntries(projectId, scope ?? undefined, 100)));
  });

  router.get("/memory/facts", (req, res) => {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
    const project = projectId ? deps.store.getProject(projectId) : null;
    if (projectId && !project) {
      sendJson(res, json("ok", []));
      return;
    }
    sendJson(res, json("ok", deps.store.memory.listFacts(project?.id ?? null, 100)));
  });

  router.get("/memory/rules", (req, res) => {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
    sendJson(res, json("ok", projectId ? deps.store.memory.listProjectRules(projectId, 100) : []));
  });
}
