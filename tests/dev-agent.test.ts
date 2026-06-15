import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runDevWorkflow } from "../packages/dev-agent/src/index.ts";
import { createId } from "../packages/shared/src/index.ts";

test("runDevWorkflow records each model call once", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-dev-agent-"));
  const projectPath = join(workspace, "repo");
  await mkdir(projectPath, { recursive: true });

  const calls: any[] = [];
  const runtime: any = {
    devRuns: {
      createRun: (input: any) => ({ id: createId("run"), ...input }),
      updateRun: () => {},
      getRun: (id: string) => ({ id, status: "failed", errorMessage: "model output was not a valid plan" }),
      addEdit: () => ({}),
    },
    execution: {
      createWorkspace: () => {
        throw new Error("workspace should not be created for an invalid plan");
      },
    },
    retrieval: {
      listQueriesForSession: () => [],
      createQuery: (input: any) => ({ id: createId("rq"), ...input }),
      listResults: () => [],
      listSelectedContext: () => [],
      listFeedback: () => [],
      listMisses: () => [],
      listPathBoosts: () => [],
    },
    models: {
      recordCall: (input: any) => {
        calls.push(input);
        return { id: createId("mc"), ...input };
      },
      getProfile: () => ({ maxOutputTokens: 1024 }),
    },
    conversation: {
      appendMessage: () => {},
    },
    modelRuntime: {
      invoke: async (_profileId: string, request: any, options: any) => {
        runtime.models.recordCall({
          sessionId: options?.sessionId ?? null,
          taskId: options?.taskId ?? null,
          retrievalQueryId: options?.retrievalQueryId ?? null,
          profileId: "planner-balanced-local",
          role: request.role,
          promptTokens: 10,
          completionTokens: 3,
          latencyMs: 1,
          status: "ok",
          request: { kind: "dev-plan", runId: "run_1" },
          response: { text: "{}" },
        });
        return {
          text: "{}",
          promptTokens: 10,
          completionTokens: 3,
          latencyMs: 1,
          status: "ok",
        };
      },
    },
  };

  const result = await runDevWorkflow({
    request: {
      goal: "update auth flow",
      mode: "local",
      project: "repo",
    } as any,
    project: {
      id: "proj_1",
      name: "repo",
      path: projectPath,
      config: {},
    },
    runtime,
    runtimeDir: workspace,
    sessionId: "sess_1",
  });

  assert.equal(result.run.status, "failed");
  assert.equal(calls.length, 1, "planner model call should be recorded exactly once");

  await rm(workspace, { recursive: true, force: true });
});
