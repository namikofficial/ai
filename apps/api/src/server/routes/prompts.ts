import type { Router } from "express";
import { runPromptLab } from "../../../../../packages/prompt-lab-engine/src/index.ts";
import type { ModelCallRecordedHook } from "../../../../../packages/model-runtime/src/index.ts";
import { createStore } from "../../../../../packages/db/src/store.ts";
import { asyncRoute, isHtmlRequest, readJsonBody, readTextBody } from "../http.ts";
import { json, sendHtml, sendJson } from "../response.ts";
import { renderCompiledPromptPage, renderPromptsPage } from "../render-pages.ts";

type Store = ReturnType<typeof createStore>;

export function registerPromptRoutes(router: Router, deps: { store: Store; cloudEnabled: boolean }) {
  router.get("/prompts", (req, res) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : null;
    const limit = Number(req.query.limit ?? 100) || 100;
    const prompts = deps.store.listCompiledPrompts(sessionId, limit);
    if (!isHtmlRequest(req)) {
      sendJson(res, json("ok", prompts));
      return;
    }
    sendHtml(res, renderPromptsPage(deps.store, sessionId));
  });

  router.get("/prompts/:promptId", (req, res) => {
    const promptId = decodeURIComponent(String(req.params.promptId ?? ""));
    const prompt = deps.store.getCompiledPrompt(promptId);
    if (!prompt) {
      if (!isHtmlRequest(req)) {
        sendJson(res, json("error", undefined, { message: "prompt not found" }), 404);
        return;
      }
      sendHtml(res, renderCompiledPromptPage(deps.store, promptId), 404);
      return;
    }
    if (!isHtmlRequest(req)) {
      sendJson(res, json("ok", prompt));
      return;
    }
    sendHtml(res, renderCompiledPromptPage(deps.store, promptId));
  });

  router.get("/prompt-lab/runs", (_req, res) => {
    sendJson(res, json("ok", deps.store.promptLab.listRuns(100)));
  });

  router.get("/prompt-lab/runs/:runId", (req, res) => {
    const runId = decodeURIComponent(String(req.params.runId ?? ""));
    const run = deps.store.promptLab.getRun(runId);
    if (!run) {
      sendJson(res, json("error", undefined, { message: "prompt lab run not found" }), 404);
      return;
    }
    sendJson(res, json("ok", {
      run,
      prompt: deps.store.getCompiledPrompt(run.promptId),
      results: deps.store.promptLab.listResults(runId),
    }));
  });

  router.post("/prompt-lab/run", asyncRoute(async (req, res) => {
    const body = (
      req.headers["content-type"]?.includes("application/json")
        ? await readJsonBody(req)
        : Object.fromEntries(new URLSearchParams(await readTextBody(req)))
    ) as Record<string, unknown>;
    const projectId = String(body.projectId ?? body.project ?? "");
    const promptId = String(body.promptId ?? body.prompt ?? "");
    const selectedProfiles = Array.isArray(body.modelProfileIds)
      ? body.modelProfileIds
      : Array.isArray(body.modelProfiles)
        ? body.modelProfiles
        : [];
    const notes = typeof body.notes === "string" ? body.notes : null;
    const dryRun = body.dryRun === true || body.dryRun === "true";
    try {
      const engineResult = await runPromptLab(
        {
          getProject: (id) => deps.store.getProject(id),
          getCompiledPrompt: (id) => deps.store.getCompiledPrompt(id),
          createRun: (input) => deps.store.promptLab.createRun(input),
          createResult: (input) => deps.store.promptLab.createResult(input),
          getProfile: (id) => deps.store.models.getProfile(id),
          listProfiles: () => deps.store.models.listProfiles(),
          listProviders: () => deps.store.models.listProviders(),
        },
        { projectId, promptId, selectedProfiles, notes, dryRun },
        {
          cloudEnabled: deps.cloudEnabled,
          recordModelCall(input: Parameters<ModelCallRecordedHook>[0]) {
            return deps.store.models.recordCall(input);
          },
        }
      );
      sendJson(res, json("ok", engineResult));
    } catch (error) {
      const statusCode = (error as Error & { statusCode?: number }).statusCode ?? 500;
      sendJson(res, json("error", undefined, { message: (error as Error).message }), statusCode);
    }
  }));
}
