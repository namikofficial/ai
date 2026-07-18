import type { Router } from "express";
import type { createStore } from "../../../../../packages/db/src/store.ts";
import { asyncRoute, readJsonBody } from "../http.ts";
import { json, sendJson } from "../response.ts";

type Store = ReturnType<typeof createStore>;

export function registerEvalRoutes(router: Router, deps: { store: Store }) {
  router.get("/eval/cases", (req, res) => {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
    sendJson(
      res,
      json(
        "ok",
        projectId
          ? deps.store.evals.listCases().filter((item) => item.projectId === projectId)
          : deps.store.evals.listCases()
      )
    );
  });

  router.post(
    "/eval/cases",
    asyncRoute(async (req, res) => {
      const body = (await readJsonBody(req)) as {
        projectId?: string;
        question: string;
        expectedAnswerContains?: string;
        expectedFiles?: string[];
        tags?: string[];
      };
      if (!body.question) {
        sendJson(res, json("error", undefined, { message: "question is required" }), 400);
        return;
      }
      sendJson(
        res,
        json(
          "ok",
          deps.store.evals.addCase({
            projectId: body.projectId ?? null,
            question: body.question,
            expectedAnswerContains: body.expectedAnswerContains ?? null,
            expectedFiles: body.expectedFiles ?? [],
            tags: body.tags ?? [],
          })
        )
      );
    })
  );

  router.get("/eval/answers", (_req, res) => sendJson(res, json("ok", deps.store.evals.listAnswerEvaluations(100))));
  router.get("/eval/outcomes", (req, res) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : null;
    sendJson(
      res,
      json("ok", sessionId ? deps.store.evals.listOutcomes(sessionId) : deps.store.evals.listAllOutcomes(100))
    );
  });
}
