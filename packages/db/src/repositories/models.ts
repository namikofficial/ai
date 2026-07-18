import type { DatabaseSync } from "node:sqlite";
import type {
  ModelCallRecord,
  ModelCallStatus,
  ModelHealthCheckRecord,
  ModelHealthStatus,
  ModelProfileRecord,
  ModelProviderKind,
  ModelProviderRecord,
  ModelRole,
  ModelRouteRecord,
} from "../../../shared/src/index.ts";
import { asBool, asNumber, asString, asStringOrNull, newId, now, safeParseJson } from "./_shared.ts";

interface ModelProviderRow {
  id: string;
  kind: string;
  display_name: string;
  base_url: string | null;
  api_key_env: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface ModelProfileRow {
  id: string;
  provider_id: string;
  role: string;
  model_name: string;
  display_name: string | null;
  context_window: number;
  max_output_tokens: number;
  local_only: number;
  enabled: number;
  fallback_profile_id: string | null;
  quality_score: number;
  latency_score: number;
  cost_score: number;
  meta_json: string;
  created_at: string;
  updated_at: string;
}

interface ModelCallRow {
  id: string;
  session_id: string | null;
  task_id: string | null;
  retrieval_query_id: string | null;
  profile_id: string;
  role: string;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  status: string;
  error: string | null;
  request_json: string;
  response_json: string;
  ts: string;
  created_at: string;
}

interface ModelHealthRow {
  id: string;
  provider_id: string;
  profile_id: string | null;
  status: string;
  latency_ms: number | null;
  detail: string | null;
  checked_at: string;
}

interface ModelRouteRow {
  id: string;
  task_pattern: string;
  mode: string;
  selected_profile_id: string;
  fallback_profile_id: string | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

interface ModelUsageDailyRow {
  day: string;
  model_name: string;
  prompt_tokens: number;
  completion_tokens: number;
  requests: number;
  created_at: string;
  updated_at: string;
}

function rowToProvider(row: ModelProviderRow): ModelProviderRecord {
  return {
    id: asString(row.id),
    kind: asString(row.kind) as ModelProviderKind,
    displayName: asString(row.display_name),
    baseUrl: asStringOrNull(row.base_url),
    apiKeyEnv: asStringOrNull(row.api_key_env),
    enabled: asBool(row.enabled),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function rowToProfile(row: ModelProfileRow): ModelProfileRecord {
  return {
    id: asString(row.id),
    providerId: asString(row.provider_id),
    role: asString(row.role) as ModelRole,
    modelName: asString(row.model_name),
    displayName: asStringOrNull(row.display_name),
    contextWindow: asNumber(row.context_window),
    maxOutputTokens: asNumber(row.max_output_tokens),
    localOnly: asBool(row.local_only),
    enabled: asBool(row.enabled),
    fallbackProfileId: asStringOrNull(row.fallback_profile_id),
    qualityScore: asNumber(row.quality_score),
    latencyScore: asNumber(row.latency_score),
    costScore: asNumber(row.cost_score),
    meta: safeParseJson(asString(row.meta_json)),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function rowToCall(row: ModelCallRow): ModelCallRecord {
  return {
    id: asString(row.id),
    sessionId: asStringOrNull(row.session_id),
    taskId: asStringOrNull(row.task_id),
    retrievalQueryId: asStringOrNull(row.retrieval_query_id),
    profileId: asString(row.profile_id),
    role: asString(row.role) as ModelRole,
    promptTokens: asNumber(row.prompt_tokens),
    completionTokens: asNumber(row.completion_tokens),
    latencyMs: asNumber(row.latency_ms),
    status: asString(row.status) as ModelCallStatus,
    error: asStringOrNull(row.error),
    request: safeParseJson(asString(row.request_json)),
    response: safeParseJson(asString(row.response_json)),
    ts: asString(row.ts),
    createdAt: asString(row.created_at),
  };
}

function rowToHealth(row: ModelHealthRow): ModelHealthCheckRecord {
  return {
    id: asString(row.id),
    providerId: asString(row.provider_id),
    profileId: asStringOrNull(row.profile_id),
    status: asString(row.status) as ModelHealthStatus,
    latencyMs: row.latency_ms == null ? null : asNumber(row.latency_ms),
    detail: asStringOrNull(row.detail),
    checkedAt: asString(row.checked_at),
  };
}

function rowToRoute(row: ModelRouteRow): ModelRouteRecord {
  return {
    id: asString(row.id),
    taskPattern: asString(row.task_pattern),
    mode: asString(row.mode) as ModelRouteRecord["mode"],
    selectedProfileId: asString(row.selected_profile_id),
    fallbackProfileId: asStringOrNull(row.fallback_profile_id),
    reason: asStringOrNull(row.reason),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

export function createModelsRepo(db: DatabaseSync) {
  return {
    upsertProvider(input: {
      id?: string | null;
      kind: ModelProviderKind;
      displayName: string;
      baseUrl?: string | null;
      apiKeyEnv?: string | null;
      enabled?: boolean;
    }): ModelProviderRecord {
      const ts = now();
      if (input.id) {
        const existing = db.prepare("SELECT * FROM model_providers WHERE id = ? LIMIT 1").get(input.id) as
          | ModelProviderRow
          | undefined;
        if (existing) {
          db.prepare(
            `UPDATE model_providers
               SET kind = ?, display_name = ?, base_url = ?, api_key_env = ?, enabled = ?, updated_at = ?
             WHERE id = ?`
          ).run(
            input.kind,
            input.displayName,
            input.baseUrl ?? null,
            input.apiKeyEnv ?? null,
            input.enabled === false ? 0 : 1,
            ts,
            input.id
          );
          const row = db.prepare("SELECT * FROM model_providers WHERE id = ?").get(input.id) as ModelProviderRow;
          return rowToProvider(row);
        }
      }
      const id = input.id ?? newId("mp");
      db.prepare(
        `INSERT INTO model_providers (
          id, kind, display_name, base_url, api_key_env, enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        input.kind,
        input.displayName,
        input.baseUrl ?? null,
        input.apiKeyEnv ?? null,
        input.enabled === false ? 0 : 1,
        ts,
        ts
      );
      return {
        id,
        kind: input.kind,
        displayName: input.displayName,
        baseUrl: input.baseUrl ?? null,
        apiKeyEnv: input.apiKeyEnv ?? null,
        enabled: input.enabled !== false,
        createdAt: ts,
        updatedAt: ts,
      };
    },
    listProviders(limit = 50): ModelProviderRecord[] {
      const rows = db
        .prepare("SELECT * FROM model_providers ORDER BY updated_at DESC LIMIT ?")
        .all(limit) as ModelProviderRow[];
      return rows.map(rowToProvider);
    },
    getProvider(id: string): ModelProviderRecord | null {
      const row = db.prepare("SELECT * FROM model_providers WHERE id = ? LIMIT 1").get(id) as
        | ModelProviderRow
        | undefined;
      return row ? rowToProvider(row) : null;
    },
    upsertProfile(input: {
      id?: string | null;
      providerId: string;
      role: ModelRole;
      modelName: string;
      displayName?: string | null;
      contextWindow?: number;
      maxOutputTokens?: number;
      localOnly?: boolean;
      enabled?: boolean;
      fallbackProfileId?: string | null;
      qualityScore?: number;
      latencyScore?: number;
      costScore?: number;
      meta?: Record<string, unknown>;
    }): ModelProfileRecord {
      const ts = now();
      const meta = input.meta ?? {};
      if (input.id) {
        const existing = db.prepare("SELECT * FROM model_profiles WHERE id = ? LIMIT 1").get(input.id) as
          | ModelProfileRow
          | undefined;
        if (existing) {
          db.prepare(
            `UPDATE model_profiles SET
               provider_id = ?, role = ?, model_name = ?, display_name = ?,
               context_window = ?, max_output_tokens = ?, local_only = ?, enabled = ?,
               fallback_profile_id = ?, quality_score = ?, latency_score = ?, cost_score = ?,
               meta_json = ?, updated_at = ?
             WHERE id = ?`
          ).run(
            input.providerId,
            input.role,
            input.modelName,
            input.displayName ?? null,
            input.contextWindow ?? 8192,
            input.maxOutputTokens ?? 1024,
            input.localOnly === false ? 0 : 1,
            input.enabled === false ? 0 : 1,
            input.fallbackProfileId ?? null,
            input.qualityScore ?? 0.5,
            input.latencyScore ?? 0.5,
            input.costScore ?? 0.5,
            JSON.stringify(meta),
            ts,
            input.id
          );
          const row = db.prepare("SELECT * FROM model_profiles WHERE id = ?").get(input.id) as ModelProfileRow;
          return rowToProfile(row);
        }
      }
      const id = input.id ?? newId("mpr");
      db.prepare(
        `INSERT INTO model_profiles (
          id, provider_id, role, model_name, display_name, context_window, max_output_tokens,
          local_only, enabled, fallback_profile_id, quality_score, latency_score, cost_score,
          meta_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        input.providerId,
        input.role,
        input.modelName,
        input.displayName ?? null,
        input.contextWindow ?? 8192,
        input.maxOutputTokens ?? 1024,
        input.localOnly === false ? 0 : 1,
        input.enabled === false ? 0 : 1,
        input.fallbackProfileId ?? null,
        input.qualityScore ?? 0.5,
        input.latencyScore ?? 0.5,
        input.costScore ?? 0.5,
        JSON.stringify(meta),
        ts,
        ts
      );
      return {
        id,
        providerId: input.providerId,
        role: input.role,
        modelName: input.modelName,
        displayName: input.displayName ?? null,
        contextWindow: input.contextWindow ?? 8192,
        maxOutputTokens: input.maxOutputTokens ?? 1024,
        localOnly: input.localOnly !== false,
        enabled: input.enabled !== false,
        fallbackProfileId: input.fallbackProfileId ?? null,
        qualityScore: input.qualityScore ?? 0.5,
        latencyScore: input.latencyScore ?? 0.5,
        costScore: input.costScore ?? 0.5,
        meta,
        createdAt: ts,
        updatedAt: ts,
      };
    },
    listProfiles(role?: ModelRole): ModelProfileRecord[] {
      const rows = role
        ? (db
            .prepare(
              "SELECT * FROM model_profiles WHERE role = ? AND enabled = 1 ORDER BY quality_score DESC, latency_score DESC"
            )
            .all(role) as ModelProfileRow[])
        : (db
            .prepare("SELECT * FROM model_profiles WHERE enabled = 1 ORDER BY role ASC, quality_score DESC")
            .all() as ModelProfileRow[]);
      return rows.map(rowToProfile);
    },
    getProfile(id: string): ModelProfileRecord | null {
      const row = db.prepare("SELECT * FROM model_profiles WHERE id = ? LIMIT 1").get(id) as
        | ModelProfileRow
        | undefined;
      return row ? rowToProfile(row) : null;
    },
    listRoutes(limit = 100): ModelRouteRecord[] {
      const rows = db
        .prepare("SELECT * FROM model_routes ORDER BY created_at DESC LIMIT ?")
        .all(limit) as ModelRouteRow[];
      return rows.map(rowToRoute);
    },
    recordRoute(input: {
      taskPattern: string;
      mode: ModelRouteRecord["mode"];
      selectedProfileId: string;
      fallbackProfileId?: string | null;
      reason?: string | null;
    }): ModelRouteRecord {
      const id = newId("mroute");
      const ts = now();
      db.prepare(
        `INSERT INTO model_routes (
          id, task_pattern, mode, selected_profile_id, fallback_profile_id, reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        input.taskPattern,
        input.mode,
        input.selectedProfileId,
        input.fallbackProfileId ?? null,
        input.reason ?? null,
        ts,
        ts
      );
      return {
        id,
        taskPattern: input.taskPattern,
        mode: input.mode,
        selectedProfileId: input.selectedProfileId,
        fallbackProfileId: input.fallbackProfileId ?? null,
        reason: input.reason ?? null,
        createdAt: ts,
        updatedAt: ts,
      };
    },
    recordCall(input: {
      sessionId?: string | null;
      taskId?: string | null;
      retrievalQueryId?: string | null;
      profileId: string;
      role: ModelRole;
      promptTokens?: number;
      completionTokens?: number;
      latencyMs?: number;
      status: ModelCallStatus;
      error?: string | null;
      request?: Record<string, unknown>;
      response?: Record<string, unknown>;
    }): ModelCallRecord {
      const id = newId("mc");
      const ts = now();
      db.prepare(
        `INSERT INTO model_calls (
          id, session_id, task_id, retrieval_query_id, profile_id, role,
          prompt_tokens, completion_tokens, latency_ms, status, error,
          request_json, response_json, ts, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        input.sessionId ?? null,
        input.taskId ?? null,
        input.retrievalQueryId ?? null,
        input.profileId,
        input.role,
        input.promptTokens ?? 0,
        input.completionTokens ?? 0,
        input.latencyMs ?? 0,
        input.status,
        input.error ?? null,
        JSON.stringify(input.request ?? {}),
        JSON.stringify(input.response ?? {}),
        ts,
        ts
      );
      const record: ModelCallRecord = {
        id,
        sessionId: input.sessionId ?? null,
        taskId: input.taskId ?? null,
        retrievalQueryId: input.retrievalQueryId ?? null,
        profileId: input.profileId,
        role: input.role,
        promptTokens: input.promptTokens ?? 0,
        completionTokens: input.completionTokens ?? 0,
        latencyMs: input.latencyMs ?? 0,
        status: input.status,
        error: input.error ?? null,
        request: input.request ?? {},
        response: input.response ?? {},
        ts,
        createdAt: ts,
      };
      const day = ts.slice(0, 10);
      const updated = db
        .prepare(
          `UPDATE model_usage_daily
           SET prompt_tokens = prompt_tokens + ?,
               completion_tokens = completion_tokens + ?,
               requests = requests + ?,
               updated_at = ?
         WHERE day = ? AND model_name = ?`
        )
        .run(record.promptTokens, record.completionTokens, 1, ts, day, input.profileId);
      if (updated.changes === 0) {
        try {
          db.prepare(
            `INSERT INTO model_usage_daily (
              day, model_name, prompt_tokens, completion_tokens, requests, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).run(day, input.profileId, record.promptTokens, record.completionTokens, 1, ts, ts);
        } catch (_error) {
          db.prepare(
            `UPDATE model_usage_daily
               SET prompt_tokens = prompt_tokens + ?,
                   completion_tokens = completion_tokens + ?,
                   requests = requests + ?,
                   updated_at = ?
             WHERE day = ? AND model_name = ?`
          ).run(record.promptTokens, record.completionTokens, 1, ts, day, input.profileId);
        }
      }
      return record;
    },
    bumpDailyUsage(input: {
      modelName: string;
      promptTokens?: number;
      completionTokens?: number;
      requests?: number;
      day?: string;
    }): void {
      const day = input.day ?? now().slice(0, 10);
      const ts = now();
      // Use UPSERT (INSERT ON CONFLICT DO UPDATE) to avoid race condition between
      // concurrent requests that both find no existing row and try to insert.
      db.prepare(
        `INSERT INTO model_usage_daily (
          day, model_name, prompt_tokens, completion_tokens, requests, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(day, model_name) DO UPDATE SET
          prompt_tokens = prompt_tokens + excluded.prompt_tokens,
          completion_tokens = completion_tokens + excluded.completion_tokens,
          requests = requests + excluded.requests,
          updated_at = excluded.updated_at`
      ).run(day, input.modelName, input.promptTokens ?? 0, input.completionTokens ?? 0, input.requests ?? 0, ts, ts);
    },
    listUsageDaily(limit = 50): Array<{
      day: string;
      modelName: string;
      promptTokens: number;
      completionTokens: number;
      requests: number;
    }> {
      const rows = db
        .prepare("SELECT * FROM model_usage_daily ORDER BY day DESC, model_name ASC LIMIT ?")
        .all(limit) as ModelUsageDailyRow[];
      return rows.map((row) => ({
        day: asString(row.day),
        modelName: asString(row.model_name),
        promptTokens: asNumber(row.prompt_tokens),
        completionTokens: asNumber(row.completion_tokens),
        requests: asNumber(row.requests),
      }));
    },
    listCalls(sessionId: string, limit = 200): ModelCallRecord[] {
      const rows = db
        .prepare("SELECT * FROM model_calls WHERE session_id = ? ORDER BY ts ASC LIMIT ?")
        .all(sessionId, limit) as ModelCallRow[];
      return rows.map(rowToCall);
    },
    listAllCalls(limit = 200): ModelCallRecord[] {
      const rows = db.prepare("SELECT * FROM model_calls ORDER BY ts DESC LIMIT ?").all(limit) as ModelCallRow[];
      return rows.map(rowToCall);
    },
    recordHealthCheck(input: {
      providerId: string;
      profileId?: string | null;
      status: ModelHealthStatus;
      latencyMs?: number | null;
      detail?: string | null;
    }): ModelHealthCheckRecord {
      const id = newId("mhc");
      const ts = now();
      db.prepare(
        `INSERT INTO model_health_checks (
          id, provider_id, profile_id, status, latency_ms, detail, checked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        input.providerId,
        input.profileId ?? null,
        input.status,
        input.latencyMs ?? null,
        input.detail ?? null,
        ts
      );
      return {
        id,
        providerId: input.providerId,
        profileId: input.profileId ?? null,
        status: input.status,
        latencyMs: input.latencyMs ?? null,
        detail: input.detail ?? null,
        checkedAt: ts,
      };
    },
    listHealthChecks(providerId?: string, limit = 50): ModelHealthCheckRecord[] {
      const rows = providerId
        ? (db
            .prepare("SELECT * FROM model_health_checks WHERE provider_id = ? ORDER BY checked_at DESC LIMIT ?")
            .all(providerId, limit) as ModelHealthRow[])
        : (db
            .prepare("SELECT * FROM model_health_checks ORDER BY checked_at DESC LIMIT ?")
            .all(limit) as ModelHealthRow[]);
      return rows.map(rowToHealth);
    },
  };
}

export type ModelsRepo = ReturnType<typeof createModelsRepo>;
