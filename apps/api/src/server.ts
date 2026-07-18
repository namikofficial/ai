import { mkdir, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import * as path from "node:path";
import express, { type Request } from "express";
import { resolveConfig, resolveEmbeddingConfig } from "../../../packages/config/src/index.ts";
import { createStore, initializeStore } from "../../../packages/db/src/store.ts";
import { createModelRuntime, type ModelRuntime } from "../../../packages/model-runtime/src/index.ts";
import type {
  ConfigSnapshot,
  EventEnvelope,
  ModelProfileRecord,
  ModelProviderRecord,
} from "../../../packages/shared/src/index.ts";
import { buildSessionTimeline } from "../../../packages/timeline/src/index.ts";
import { runExplainWithStore } from "./retrieval-explain.ts";
import { getRequestPath, isHtmlRequest, safeParseJson } from "./server/http.ts";
import { renderDashboard, renderErrorPage, renderNotFoundPage } from "./server/render-pages.ts";
import { json, sendJson } from "./server/response.ts";
import { registerAgentRoutes } from "./server/routes/agents.ts";
import { registerControlPlaneRoutes } from "./server/routes/control-plane.ts";
import { registerEvalRoutes } from "./server/routes/eval.ts";
import { registerHealthRoutes } from "./server/routes/health.ts";
import { registerMcpRoutes } from "./server/routes/mcp.ts";
import { registerMemoryRoutes } from "./server/routes/memory.ts";
import { registerModelRoutes } from "./server/routes/models.ts";
import { registerProjectRoutes } from "./server/routes/projects.ts";
import { registerPromptRoutes } from "./server/routes/prompts.ts";
import { registerRetrievalRoutes } from "./server/routes/retrieval.ts";
import { registerSessionRoutes } from "./server/routes/sessions.ts";
import { registerSettingsRoutes } from "./server/routes/settings.ts";
import { registerSseRoutes } from "./server/routes/sse.ts";
import { registerSsrRoutes } from "./server/routes/ssr.ts";
import { registerTaskRoutes } from "./server/routes/tasks.ts";
import { registerWorkflowRoutes } from "./server/routes/workflows.ts";

export interface IntelligenceStack {
  runtime: ModelRuntime;
  providers: Pick<ModelProviderRecord, "id" | "kind" | "displayName" | "baseUrl" | "apiKeyEnv" | "enabled">[];
  profiles: ModelProfileRecord[];
}

export interface ServerOptions {
  config?: Partial<ConfigSnapshot>;
  inProcess?: boolean;
  intelligenceStack?: IntelligenceStack;
  store?: ReturnType<typeof createStore>;
}

export interface ServerHandle {
  url: string;
  close(): Promise<void>;
  inject(input: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
  }): Promise<{ statusCode: number; body: string }>;
}

function readCount(store: ReturnType<typeof createStore>, sql: string): { count: number; ok: boolean } {
  try {
    const row = store.db.prepare(sql).get() as { count?: number } | undefined;
    return { count: typeof row?.count === "number" ? row.count : 0, ok: true };
  } catch {
    return { count: 0, ok: false };
  }
}

function buildHealthSnapshot(store: ReturnType<typeof createStore>, config: ConfigSnapshot): Record<string, unknown> {
  const migrationsApplied = readCount(store, "SELECT COUNT(*) AS count FROM schema_migrations");
  const projectCount = readCount(store, "SELECT COUNT(*) AS count FROM projects");
  const sessionCount = readCount(store, "SELECT COUNT(*) AS count FROM agent_sessions");
  const modelProviderCount = readCount(store, "SELECT COUNT(*) AS count FROM model_providers");
  const promptCount = readCount(store, "SELECT COUNT(*) AS count FROM compiled_prompts");
  const databaseReachable =
    migrationsApplied.ok && projectCount.ok && sessionCount.ok && modelProviderCount.ok && promptCount.ok;
  return {
    uptime: process.uptime(),
    databasePath: config.databasePath ? `.../${path.basename(config.databasePath)}` : null,
    runtimeDir: config.runtimeDir ? `.../${path.basename(config.runtimeDir)}` : null,
    databaseReachable,
    migrations: { applied: migrationsApplied.count },
    projectCount: projectCount.count,
    sessionCount: sessionCount.count,
    qdrant: {
      enabled: config.qdrantEnabled,
      url: config.qdrantUrl,
      collection: config.qdrantCollection,
    },
    cloudEnabled: config.cloudEnabled,
    modelProviderCount: modelProviderCount.count,
    promptCount: promptCount.count,
  };
}

async function probe(url: string | null): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  if (!url) return { ok: false, latencyMs: 0, error: "not configured" };
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return {
      ok: response.ok,
      latencyMs: Date.now() - started,
      ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readModelIds(url: string): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return [];
    const payload = (await response.json()) as { data?: Array<{ id?: unknown }> };
    return (payload.data ?? []).map((entry) => (typeof entry.id === "string" ? entry.id : "")).filter(Boolean);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function buildDeepHealthSnapshot(
  store: ReturnType<typeof createStore>,
  config: ConfigSnapshot
): Promise<Record<string, unknown>> {
  const base = buildHealthSnapshot(store, config);
  const qdrant = config.qdrantEnabled
    ? await probe(config.qdrantUrl ? `${config.qdrantUrl}/collections` : null)
    : { ok: true, skipped: true, latencyMs: 0 };
  const modelBase = process.env.AI_LOCAL_BASE_URL ?? "http://127.0.0.1:8080/v1";
  const models = await probe(`${modelBase.replace(/\/$/, "")}/models`);
  const exposedModelIds = models.ok ? await readModelIds(`${modelBase.replace(/\/$/, "")}/models`) : [];
  const expectedProfiles = store.models
    .listProfiles()
    .filter((profile) => profile.providerId === "provider_llamacpp_local")
    .map((profile) => profile.modelName);
  let worker: Record<string, unknown> = { ok: false, error: "heartbeat missing" };
  try {
    const heartbeat = await stat(`${config.runtimeDir}/worker-heartbeat`);
    worker = { ok: Date.now() - heartbeat.mtimeMs < 15_000, ageMs: Math.round(Date.now() - heartbeat.mtimeMs) };
  } catch {
    // The worker may not be running yet.
  }
  return {
    ...base,
    deep: true,
    dependencies: {
      qdrant,
      models: {
        ...models,
        exposedModelIds,
        missingProfiles: expectedProfiles.filter((id) => !exposedModelIds.includes(id)),
      },
      worker,
    },
    embedding: resolveEmbeddingConfig(),
  };
}

function buildRuntimeForStore(store: ReturnType<typeof createStore>, cloudEnabled: boolean): ModelRuntime {
  return createModelRuntime({
    providers: store.models.listProviders(),
    profiles: store.models.listProfiles(),
    cloudEnabled,
    recordCall: store.models.recordCall,
  });
}

function readProjectGraph(store: ReturnType<typeof createStore>, projectId: string) {
  try {
    const row = store.db
      .prepare("SELECT summary_json, updated_at FROM project_context_graphs WHERE project_id = ? LIMIT 1")
      .get(projectId) as { summary_json: string; updated_at: string } | undefined;
    if (!row) return null;
    const parsed = safeParseJson(row.summary_json);
    return typeof parsed === "object" && parsed !== null ? { ...(parsed as object), updatedAt: row.updated_at } : null;
  } catch {
    return null;
  }
}

function buildSessionTraceData(store: ReturnType<typeof createStore>, sessionId: string): Record<string, unknown> {
  const session = store.getSession(sessionId);
  if (!session) return {};
  const projectId = session.projectId;
  const compiledPrompts = store.listCompiledPrompts(sessionId, 100);
  return {
    session,
    messages: store.conversation.listMessages(sessionId, 500),
    events: store.listEvents(sessionId, 500),
    retrievalQueries: store.retrieval.listQueriesForSession(sessionId, 100),
    compiledPrompts,
    modelCalls: store.models.listCalls(sessionId, 100),
    agentRuns: store.agents.listRuns(sessionId, 100),
    agentHandoffs: store.agents.listHandoffs(sessionId, 100),
    contextPacks: store.context.listPacksForSession(sessionId, 100).map((pack) => ({
      pack,
      items: store.context.listItems(pack.id),
      budgetEvents: store.context.listBudgetEvents(pack.id),
    })),
    memoryCandidates: store.memory
      .listCandidates(undefined, projectId, 100)
      .filter((candidate) => candidate.sessionId === sessionId || candidate.projectId === projectId),
    skills: store.skills.listSkills(undefined, 100),
    evalOutcomes: store.evals.listOutcomes(sessionId, 100),
  };
}

function buildSessionTimelineForRequest(store: ReturnType<typeof createStore>, sessionId: string) {
  const session = store.getSession(sessionId);
  if (!session) return null;
  return buildSessionTimeline({
    session,
    messages: store.conversation.listMessages(sessionId, 500),
    events: store.listEvents(sessionId, 500),
    agentRuns: store.agents.listRuns(sessionId, 200),
    modelCalls: store.models.listCalls(sessionId, 200),
    compiledPrompts: store.listCompiledPrompts(sessionId, 100),
    retrievalQueries: store.retrieval.listQueriesForSession(sessionId, 100),
    contextPacks: store.context.listPacksForSession(sessionId, 100),
    outcomes: store.evals.listOutcomes(sessionId, 100),
  });
}

export async function startWorkbenchServer(options: ServerOptions = {}): Promise<ServerHandle> {
  const config = resolveConfig(options.config ?? {});
  await mkdir(config.runtimeDir, { recursive: true });
  const store = options.store ?? createStore(initializeStore(config.databasePath));
  await store.ensureRuntimeDirs(config.runtimeDir);
  if (options.intelligenceStack) {
    store.setIntelligenceStack(options.intelligenceStack);
  } else if (process.env.AI_DISABLE_INTELLIGENCE_STACK !== "true") {
    const providers = store.models.listProviders().map((provider) => ({
      id: provider.id,
      kind: provider.kind,
      displayName: provider.displayName,
      baseUrl: provider.baseUrl,
      apiKeyEnv: provider.apiKeyEnv,
      enabled: provider.enabled,
    }));
    const profiles = store.models.listProfiles();
    const runtime = createModelRuntime({ providers, profiles, cloudEnabled: config.cloudEnabled });
    store.setIntelligenceStack({ runtime, providers, profiles });
  }

  const listeners = new Set<{ write(chunk: string): void }>();
  const publish = (event: EventEnvelope) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of listeners) {
      try {
        res.write(payload);
      } catch {
        listeners.delete(res);
      }
    }
  };

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "10mb", type: "application/json" }));
  app.use(express.urlencoded({ extended: false, limit: "10mb", type: "application/x-www-form-urlencoded" }));
  app.use(express.text({ limit: "10mb", type: ["text/plain", "multipart/form-data"] }));

  // Catch JSON parse errors from express.json() and return clean 400
  app.use((err: unknown, _req: Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return;
    const e = err as { type?: string; status?: number; message?: string };
    if (e.type === "entity.parse.failed") {
      res.status(400);
      sendJson(res, json("error", undefined, { message: "Malformed JSON in request body" }), 400);
      return;
    }
    next(err);
  });

  const ssrRouter = express.Router();
  registerSsrRoutes(ssrRouter, { renderDashboard: () => renderDashboard(store) });
  app.use(ssrRouter);

  const healthRouter = express.Router();
  registerHealthRoutes(healthRouter, {
    buildHealthSnapshot: () => buildHealthSnapshot(store, config),
    buildDeepHealthSnapshot: () => buildDeepHealthSnapshot(store, config),
    config,
    listProjects: () => store.listProjects(),
    dashboardSnapshot: () => store.dashboardSnapshot(),
    getSettings: () => store.getSettings(config),
  });
  app.use(healthRouter);

  const sseRouter = express.Router();
  registerSseRoutes(sseRouter, {
    listEvents: () => store.listEvents(undefined, 500),
    listEventsSince: (since: string) => store.listEventsSince(since, undefined, 500),
    listeners,
  });
  app.use(sseRouter);

  const projectRouter = express.Router();
  registerProjectRoutes(projectRouter, {
    store,
    publish,
    readProjectGraph: (projectId) => readProjectGraph(store, projectId),
  });
  app.use(projectRouter);

  const controlPlaneRouter = express.Router();
  registerControlPlaneRoutes(controlPlaneRouter, { store, publish });
  app.use(controlPlaneRouter);

  const sessionRouter = express.Router();
  registerSessionRoutes(sessionRouter, {
    store,
    config,
    publish,
    buildRuntimeForStore: () => buildRuntimeForStore(store, config.cloudEnabled),
    buildSessionTraceData: (sessionId) => buildSessionTraceData(store, sessionId),
    buildSessionTimeline: (sessionId) => buildSessionTimelineForRequest(store, sessionId),
  });
  app.use(sessionRouter);

  const promptRouter = express.Router();
  registerPromptRoutes(promptRouter, { store, cloudEnabled: config.cloudEnabled });
  app.use(promptRouter);

  const taskRouter = express.Router();
  registerTaskRoutes(taskRouter, { store });
  app.use(taskRouter);

  const workflowRouter = express.Router();
  registerWorkflowRoutes(workflowRouter, { store, config, publish });
  app.use(workflowRouter);

  const retrievalRouter = express.Router();
  registerRetrievalRoutes(retrievalRouter, {
    store,
    readProjectGraph: (projectId) => readProjectGraph(store, projectId),
    runExplainWithStore: (input) => runExplainWithStore(store, input),
  });
  app.use(retrievalRouter);

  const memoryRouter = express.Router();
  registerMemoryRoutes(memoryRouter, { store });
  app.use(memoryRouter);

  const modelRouter = express.Router();
  registerModelRoutes(modelRouter, { store, config });
  app.use(modelRouter);

  const agentRouter = express.Router();
  registerAgentRoutes(agentRouter, { store });
  app.use(agentRouter);

  const evalRouter = express.Router();
  registerEvalRoutes(evalRouter, { store });
  app.use(evalRouter);

  const mcpRouter = express.Router();
  registerMcpRoutes(mcpRouter, { store });
  app.use(mcpRouter);

  const settingsRouter = express.Router();
  registerSettingsRoutes(settingsRouter, { store, config });
  app.use(settingsRouter);

  app.use((req, res) => {
    res.status(404);
    if (isHtmlRequest(req)) {
      res.send(
        renderNotFoundPage(
          store,
          getRequestPath(req),
          "Not Found",
          `No route matched <code>${getRequestPath(req)}</code>.`
        )
      );
      return;
    }
    sendJson(res, json("error", undefined, { message: `No route matched ${getRequestPath(req)}` }), 404);
  });

  app.use((error: unknown, req: Request, res: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : String(error);
    if (res.headersSent) return;
    if (isHtmlRequest(req)) {
      res.status(500).send(renderErrorPage(store, getRequestPath(req), message));
      return;
    }
    sendJson(res, json("error", undefined, { message }), 500);
  });

  const inject = async (input: { method: string; url: string; headers?: Record<string, string>; body?: unknown }) => {
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(input.body === undefined ? input.headers : { "content-type": "application/json", ...input.headers }),
    };
    const temporary = await new Promise<import("node:http").Server>((resolve, reject) => {
      const candidate = app.listen(0, "127.0.0.1", () => resolve(candidate));
      candidate.once("error", reject);
    });
    try {
      const address = temporary.address();
      const port = typeof address === "object" && address ? address.port : 0;
      return await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
        const request = httpRequest(
          { hostname: "127.0.0.1", port, path: input.url, method: input.method.toUpperCase(), headers },
          (response) => {
            const chunks: string[] = [];
            response.setEncoding("utf8");
            response.on("data", (chunk: string) => chunks.push(chunk));
            response.on("end", () => resolve({ statusCode: response.statusCode ?? 500, body: chunks.join("") }));
          }
        );
        request.on("error", reject);
        if (input.body !== undefined) {
          const contentType = String(headers["content-type"] ?? "");
          const body =
            typeof input.body === "string"
              ? input.body
              : contentType.includes("application/x-www-form-urlencoded")
                ? new URLSearchParams(
                    Object.entries(input.body as Record<string, unknown>).map(([key, value]) => [key, String(value)])
                  ).toString()
                : JSON.stringify(input.body);
          request.write(body);
        }
        request.end();
      });
    } finally {
      await new Promise<void>((resolve) => temporary.close(() => resolve()));
    }
  };

  if (options.inProcess) {
    return { url: config.apiUrl, inject, async close() {} };
  }

  const server = app.listen(config.apiPort);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });

  return {
    url: config.apiUrl,
    inject,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
