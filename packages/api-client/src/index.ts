import type {
  AskRequest,
  AskResponse,
  CheckRunSummary,
  ConfigSnapshot,
  EventEnvelope,
  HandoffRequest,
  HandoffResponse,
  PlanRequest,
  PlanResponse,
  ReviewRequest,
  ReviewResponse,
  ProjectCreateInput,
  ProjectSummary,
  RetrievalChunk,
  ReviewRecord,
  PromptLabRunRequest,
  PromptLabRunRecord,
  PromptLabResultRecord,
  SessionReplayRequest,
  SessionReplayResponse,
  SessionTimelineResponse,
  TaskRecord,
  SessionRecord,
  SettingsSnapshot,
} from "../../shared/src/index.ts";

export interface ApiClientOptions {
  baseUrl: string;
}

function resolveUrl(baseUrl: string, path: string): URL {
  const url = new URL(baseUrl);
  const basePath = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  const nextPath = path.startsWith("/") ? path : `/${path}`;
  url.pathname = `${basePath}${nextPath}`.replace(/\/{2,}/g, "/");
  return url;
}

async function requestJson<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? {});
  headers.set("accept", "application/json");
  const response = await fetch(resolveUrl(baseUrl, path), {
    ...init,
    headers,
  });

  if (!response.ok) {
    throw new Error(`Request failed for ${path}: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as T;
}

export function createApiClient(options: ApiClientOptions) {
  return {
    health(): Promise<{ status: "ok"; data: { uptime: number } }> {
      return requestJson(options.baseUrl, "/health");
    },
    config(): Promise<{ status: "ok"; data: ConfigSnapshot }> {
      return requestJson(options.baseUrl, "/config");
    },
    status(): Promise<{ status: "ok"; data: unknown }> {
      return requestJson(options.baseUrl, "/status");
    },
    listProjects(): Promise<{ status: "ok"; data: ProjectSummary[] }> {
      return requestJson(options.baseUrl, "/projects");
    },
    getProject(projectId: string): Promise<{ status: "ok"; data: ProjectSummary | null }> {
      return requestJson(options.baseUrl, `/projects/${projectId}`);
    },
    getProjectGraph(projectId: string): Promise<{ status: "ok"; data: Record<string, unknown> | null }> {
      return requestJson(options.baseUrl, `/projects/${projectId}/graph`);
    },
    createProject(input: ProjectCreateInput): Promise<{ status: "ok"; data: ProjectSummary }> {
      return requestJson(options.baseUrl, "/projects", {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "content-type": "application/json" },
      });
    },
    indexProject(projectId: string): Promise<{ status: "ok"; data: { session: SessionRecord; events: EventEnvelope[] } }> {
      return requestJson(options.baseUrl, `/projects/${projectId}/index`, { method: "POST" });
    },
    getProjectMemory(projectId: string): Promise<{ status: "ok"; data: { lessons: Array<Record<string, unknown>>; rules: Array<Record<string, unknown>>; memory: Array<Record<string, unknown>> } }> {
      return requestJson(options.baseUrl, `/projects/${projectId}/memory`);
    },
    getProjectRetrieval(projectId: string, query = ""): Promise<{ status: "ok"; data: { chunks: RetrievalChunk[]; query: string } }> {
      const suffix = query ? `?q=${encodeURIComponent(query)}` : "";
      return requestJson(options.baseUrl, `/projects/${projectId}/retrieval${suffix}`);
    },
    listSessions(): Promise<{ status: "ok"; data: SessionRecord[] }> {
      return requestJson(options.baseUrl, "/sessions");
    },
    getSession(sessionId: string): Promise<{ status: "ok"; data: SessionRecord }> {
      return requestJson(options.baseUrl, `/sessions/${sessionId}`);
    },
    getSessionEvents(sessionId: string): Promise<{ status: "ok"; data: EventEnvelope[] }> {
      return requestJson(options.baseUrl, `/sessions/${sessionId}/events`);
    },
    getSessionTimeline(sessionId: string): Promise<{ status: "ok"; data: SessionTimelineResponse }> {
      return requestJson(options.baseUrl, `/sessions/${sessionId}/timeline`);
    },
    replaySession(sessionId: string, input: SessionReplayRequest): Promise<{ status: "ok"; data: SessionReplayResponse }> {
      return requestJson(options.baseUrl, `/sessions/${sessionId}/replay`, {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "content-type": "application/json" },
      });
    },
    listTasks(): Promise<{ status: "ok"; data: TaskRecord[] }> {
      return requestJson(options.baseUrl, "/tasks");
    },
    getTask(taskId: string): Promise<{ status: "ok"; data: TaskRecord }> {
      return requestJson(options.baseUrl, `/tasks/${taskId}`);
    },
    ask(input: AskRequest): Promise<{ status: "ok"; data: AskResponse }> {
      return requestJson(options.baseUrl, "/ask", {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "content-type": "application/json" },
      });
    },
    plan(input: PlanRequest): Promise<{ status: "ok"; data: PlanResponse }> {
      return requestJson(options.baseUrl, "/plan", {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "content-type": "application/json" },
      });
    },
    research(input: { project: string; topic: string; mode?: "local" | "web" | "hybrid" }): Promise<{ status: "ok"; data: { summary: string; sources: Array<{ path: string; score: number; excerpt: string }>; contradictions: string[]; brief: string } }> {
      return requestJson(options.baseUrl, "/research", {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "content-type": "application/json" },
      });
    },
    handoff(input: HandoffRequest): Promise<{ status: "ok"; data: HandoffResponse }> {
      return requestJson(options.baseUrl, "/handoff", {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "content-type": "application/json" },
      });
    },
    listChecks(): Promise<{ status: "ok"; data: CheckRunSummary[] }> {
      return requestJson(options.baseUrl, "/checks");
    },
    runCheck(input: { name: string; projectId?: string | null }): Promise<{ status: "ok"; data: CheckRunSummary }> {
      return requestJson(options.baseUrl, "/checks/run", {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "content-type": "application/json" },
      });
    },
    searchRetrieval(input: { project: string; query: string; limit?: number }): Promise<{ status: "ok"; data: Array<Record<string, unknown>> }> {
      return requestJson(options.baseUrl, "/retrieval/search", {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "content-type": "application/json" },
      });
    },
    explainContext(input: { project: string; query: string; mode?: "local" | "cloud" | "hybrid"; depth?: "shallow" | "standard" | "deep"; limit?: number }): Promise<{ status: "ok"; data: Record<string, unknown> }> {
      return requestJson(options.baseUrl, "/context/explain", {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "content-type": "application/json" },
      });
    },
    getSettings(): Promise<{ status: "ok"; data: SettingsSnapshot }> {
      return requestJson(options.baseUrl, "/settings");
    },
    listReviews(): Promise<{ status: "ok"; data: Array<Record<string, unknown>> }> {
      return requestJson(options.baseUrl, "/reviews");
    },
    getReview(reviewId: string): Promise<{ status: "ok"; data: ReviewRecord | null }> {
      return requestJson(options.baseUrl, `/reviews/${reviewId}`);
    },
    createReview(input: ReviewRequest): Promise<{ status: "ok"; data: ReviewResponse }> {
      return requestJson(options.baseUrl, "/reviews", {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "content-type": "application/json" },
      });
    },
    listPromptLabRuns(): Promise<{ status: "ok"; data: PromptLabRunRecord[] }> {
      return requestJson(options.baseUrl, "/prompt-lab/runs");
    },
    getPromptLabRun(runId: string): Promise<{ status: "ok"; data: { run: PromptLabRunRecord; prompt: Record<string, unknown> | null; results: PromptLabResultRecord[] } }> {
      return requestJson(options.baseUrl, `/prompt-lab/runs/${encodeURIComponent(runId)}`);
    },
    runPromptLab(input: PromptLabRunRequest): Promise<{ status: "ok"; data: { run: PromptLabRunRecord; prompt: Record<string, unknown> | null; results: PromptLabResultRecord[] } }> {
      return requestJson(options.baseUrl, "/prompt-lab/run", {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "content-type": "application/json" },
      });
    },
    getModels(): Promise<{ status: "ok"; data: { usage: Array<{ day: string; modelName: string; promptTokens: number; completionTokens: number; requests: number }> } }> {
      return requestJson(options.baseUrl, "/models");
    },
    getMcpOverview(): Promise<{ status: "ok"; data: Array<Record<string, unknown>> }> {
      return requestJson(options.baseUrl, "/mcp");
    },
    getMcpCalls(): Promise<{ status: "ok"; data: Array<Record<string, unknown>> }> {
      return requestJson(options.baseUrl, "/mcp/calls");
    },
    getMcpCall(callId: string): Promise<{ status: "ok"; data: Record<string, unknown> | null }> {
      return requestJson(options.baseUrl, `/mcp/calls/${callId}`);
    },
    listRetrievalQueries(input: { sessionId?: string; projectId?: string; limit?: number }): Promise<{ status: "ok"; data: Array<Record<string, unknown>> }> {
      const params = new URLSearchParams();
      if (input.sessionId) params.set("sessionId", input.sessionId);
      if (input.projectId) params.set("projectId", input.projectId);
      if (input.limit) params.set("limit", String(input.limit));
      const suffix = params.toString() ? `?${params.toString()}` : "";
      return requestJson(options.baseUrl, `/retrieval/queries${suffix}`);
    },
    getRetrievalQuery(id: string): Promise<{ status: "ok"; data: Record<string, unknown> }> {
      return requestJson(options.baseUrl, `/retrieval/queries/${id}`);
    },
    listMemoryCandidates(input: { status?: "pending" | "accepted" | "rejected"; projectId?: string }): Promise<{ status: "ok"; data: Array<Record<string, unknown>> }> {
      const params = new URLSearchParams();
      if (input.status) params.set("status", input.status);
      if (input.projectId) params.set("projectId", input.projectId);
      const suffix = params.toString() ? `?${params.toString()}` : "";
      return requestJson(options.baseUrl, `/memory/candidates${suffix}`);
    },
    acceptMemoryCandidate(id: string, notes?: string): Promise<{ status: "ok"; data: Record<string, unknown> }> {
      return requestJson(options.baseUrl, `/memory/candidates/${id}/accept`, {
        method: "POST",
        body: JSON.stringify({ notes: notes ?? null }),
        headers: { "content-type": "application/json" },
      });
    },
    rejectMemoryCandidate(id: string, reason?: string): Promise<{ status: "ok"; data: Record<string, unknown> }> {
      return requestJson(options.baseUrl, `/memory/candidates/${id}/reject`, {
        method: "POST",
        body: JSON.stringify({ reason: reason ?? null }),
        headers: { "content-type": "application/json" },
      });
    },
    listMemoryEntries(input?: { projectId?: string; scope?: "global" | "project" | "repo" | "path" }): Promise<{ status: "ok"; data: Array<Record<string, unknown>> }> {
      const params = new URLSearchParams();
      if (input?.projectId) params.set("projectId", input.projectId);
      if (input?.scope) params.set("scope", input.scope);
      const suffix = params.toString() ? `?${params.toString()}` : "";
      return requestJson(options.baseUrl, `/memory/entries${suffix}`);
    },
    listMemoryFacts(projectId: string): Promise<{ status: "ok"; data: Array<Record<string, unknown>> }> {
      return requestJson(options.baseUrl, `/memory/facts?projectId=${encodeURIComponent(projectId)}`);
    },
    listProjectRules(projectId: string): Promise<{ status: "ok"; data: Array<Record<string, unknown>> }> {
      return requestJson(options.baseUrl, `/memory/rules?projectId=${encodeURIComponent(projectId)}`);
    },
    listSkillCandidates(input?: { status?: "pending" | "active" | "deprecated" | "rejected" }): Promise<{ status: "ok"; data: Array<Record<string, unknown>> }> {
      const params = new URLSearchParams();
      if (input?.status) params.set("status", input.status);
      const suffix = params.toString() ? `?${params.toString()}` : "";
      return requestJson(options.baseUrl, `/skills/candidates${suffix}`);
    },
    acceptSkillCandidate(id: string): Promise<{ status: "ok"; data: Record<string, unknown> }> {
      return requestJson(options.baseUrl, `/skills/candidates/${id}/accept`, { method: "POST" });
    },
    rejectSkillCandidate(id: string, reason?: string): Promise<{ status: "ok"; data: Record<string, unknown> }> {
      return requestJson(options.baseUrl, `/skills/candidates/${id}/reject`, {
        method: "POST",
        body: JSON.stringify({ reason: reason ?? null }),
        headers: { "content-type": "application/json" },
      });
    },
    listSkills(): Promise<{ status: "ok"; data: Array<Record<string, unknown>> }> {
      return requestJson(options.baseUrl, `/skills`);
    },
    getModelProviders(): Promise<{ status: "ok"; data: { providers: Array<Record<string, unknown>>; profiles: Array<Record<string, unknown>> } }> {
      return requestJson(options.baseUrl, `/models/providers`);
    },
    getModelRoutes(): Promise<{ status: "ok"; data: Array<Record<string, unknown>> }> {
      return requestJson(options.baseUrl, `/models/routes`);
    },
    routeModel(input: {
      taskPattern: string;
      mode?: "local" | "cloud" | "hybrid" | "any";
      risk?: "low" | "medium" | "high";
      depth?: "shallow" | "standard" | "deep";
      question?: string;
      goal?: string;
      fallbackProfileId?: string | null;
      reason?: string | null;
    }): Promise<{ status: "ok"; data: { route: Record<string, unknown>; profile: Record<string, unknown> | null } }> {
      return requestJson(options.baseUrl, `/models/route`, {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "content-type": "application/json" },
      });
    },
    getModelCalls(limit = 50): Promise<{ status: "ok"; data: Array<Record<string, unknown>> }> {
      return requestJson(options.baseUrl, `/models/calls?limit=${limit}`);
    },
    getModelHealth(): Promise<{ status: "ok"; data: { providers: Array<Record<string, unknown>>; recentCalls: Array<Record<string, unknown>> } }> {
      return requestJson(options.baseUrl, `/models/health`);
    },
    checkModelHealth(input: {
      providerId: string;
      profileId?: string | null;
      status?: "healthy" | "degraded" | "unreachable" | "disabled";
      latencyMs?: number | null;
      detail?: string | null;
    }): Promise<{ status: "ok"; data: Record<string, unknown> }> {
      return requestJson(options.baseUrl, `/models/health/check`, {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "content-type": "application/json" },
      });
    },
    listAgentRuns(sessionId: string): Promise<{ status: "ok"; data: Array<Record<string, unknown>> }> {
      return requestJson(options.baseUrl, `/agents/runs?sessionId=${encodeURIComponent(sessionId)}`);
    },
    getAgentRun(runId: string): Promise<{ status: "ok"; data: Record<string, unknown> }> {
      return requestJson(options.baseUrl, `/agents/runs/${runId}`);
    },
    listAgentHandoffs(sessionId?: string): Promise<{ status: "ok"; data: Array<Record<string, unknown>> }> {
      const suffix = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
      return requestJson(options.baseUrl, `/agents/handoffs${suffix}`);
    },
    listContextPacks(sessionId: string): Promise<{ status: "ok"; data: Array<Record<string, unknown>> }> {
      return requestJson(options.baseUrl, `/context/packs?sessionId=${encodeURIComponent(sessionId)}`);
    },
    getContextPack(packId: string): Promise<{ status: "ok"; data: Record<string, unknown> }> {
      return requestJson(options.baseUrl, `/context/packs/${packId}`);
    },
    listConversationMessages(sessionId: string): Promise<{ status: "ok"; data: Array<Record<string, unknown>> }> {
      return requestJson(options.baseUrl, `/conversations/${encodeURIComponent(sessionId)}`);
    },
    getSessionTrace(sessionId: string): Promise<{ status: "ok"; data: Record<string, unknown> }> {
      return requestJson(options.baseUrl, `/sessions/${encodeURIComponent(sessionId)}/trace`);
    },
    listCompiledPrompts(input?: { sessionId?: string; limit?: number }): Promise<{ status: "ok"; data: Array<Record<string, unknown>> }> {
      const params = new URLSearchParams();
      if (input?.sessionId) params.set("sessionId", input.sessionId);
      if (input?.limit) params.set("limit", String(input.limit));
      const suffix = params.toString() ? `?${params.toString()}` : "";
      return requestJson(options.baseUrl, `/prompts${suffix}`);
    },
    getCompiledPrompt(promptId: string): Promise<{ status: "ok"; data: Record<string, unknown> }> {
      return requestJson(options.baseUrl, `/prompts/${encodeURIComponent(promptId)}`);
    },
    listEvalCases(projectId?: string): Promise<{ status: "ok"; data: Array<Record<string, unknown>> }> {
      const suffix = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
      return requestJson(options.baseUrl, `/eval/cases${suffix}`);
    },
    addEvalCase(input: { projectId?: string; question: string; expectedAnswerContains?: string; expectedFiles?: string[]; tags?: string[] }): Promise<{ status: "ok"; data: Record<string, unknown> }> {
      return requestJson(options.baseUrl, `/eval/cases`, {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "content-type": "application/json" },
      });
    },
    listAnswerEvaluations(): Promise<{ status: "ok"; data: Array<Record<string, unknown>> }> {
      return requestJson(options.baseUrl, `/eval/answers`);
    },
    listSessionOutcomes(sessionId?: string): Promise<{ status: "ok"; data: Array<Record<string, unknown>> }> {
      const suffix = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
      return requestJson(options.baseUrl, `/eval/outcomes${suffix}`);
    },
    streamEvents(onEvent: (event: EventEnvelope) => void): () => void {
      const controller = new AbortController();
      fetch(resolveUrl(options.baseUrl, "/events/stream"), { signal: controller.signal }).then(async (response) => {
        if (!response.body) {
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const raw = buffer.slice(0, boundary).trim();
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf("\n\n");
            const dataLine = raw
              .split("\n")
              .find((line) => line.startsWith("data: "));
            if (dataLine) {
              onEvent(JSON.parse(dataLine.slice(6)) as EventEnvelope);
            }
          }
        }
      });

      return () => controller.abort();
    },
  };
}
