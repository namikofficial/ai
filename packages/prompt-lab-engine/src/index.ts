import {
  createModelRuntime,
  type ModelCallRecordedHook,
  type ModelInvokeMessage,
  type ModelRuntime,
} from "../../model-runtime/src/index.ts";
import type {
  CompiledPromptRecord,
  ModelProfileRecord,
  ModelProviderRecord,
  PromptLabResultRecord,
  PromptLabRunRecord,
} from "../../shared/src/index.ts";
import { createId } from "../../shared/src/index.ts";

export type PromptLabRunStatus = "ok" | "failed" | "blocked" | "fallback";

export interface PromptLabEngineStore {
  getProject(id: string): { id: string; path: string; name: string } | null;
  getCompiledPrompt(id: string): CompiledPromptRecord | null;
  createRun(input: {
    id: string;
    sessionId?: string | null;
    projectId: string;
    promptId: string;
    mode: string;
    selectedProfiles: string[];
    notes?: string | null;
    createdAt?: string;
    updatedAt?: string;
  }): PromptLabRunRecord;
  createResult(input: {
    id: string;
    runId: string;
    profileId: string;
    profileName: string;
    modelName: string;
    status: string;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
    outputText?: string | null;
    error?: string | null;
    approxCost?: number | null;
    createdAt?: string;
  }): PromptLabResultRecord;
  getProfile(id: string): ModelProfileRecord | null;
  listProfiles(): ModelProfileRecord[];
  listProviders(): Array<
    Pick<ModelProviderRecord, "id" | "kind" | "displayName" | "baseUrl" | "apiKeyEnv" | "enabled">
  >;
  recordModelCall?: ModelCallRecordedHook;
}

export interface PromptLabEngineInput {
  projectId: string;
  promptId: string;
  selectedProfiles: string[];
  notes: string | null;
  dryRun: boolean;
}

export interface PromptLabEngineOptions {
  cloudEnabled: boolean;
  recordModelCall?: ModelCallRecordedHook;
}

export interface PromptLabEngineResult {
  run: PromptLabRunRecord;
  prompt: CompiledPromptRecord | null;
  results: PromptLabResultRecord[];
}

function validateMessages(
  messagesJson: string
): { ok: true; messages: ModelInvokeMessage[] } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(messagesJson);
  } catch {
    return { ok: false, error: "compiled prompt messages_json is not valid JSON" };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, error: "compiled prompt messages_json is not a valid JSON array" };
  }
  for (let i = 0; i < parsed.length; i++) {
    const msg = parsed[i];
    if (
      !msg ||
      typeof msg !== "object" ||
      !["system", "user", "assistant"].includes((msg as Record<string, unknown>).role as string) ||
      typeof (msg as Record<string, unknown>).content !== "string"
    ) {
      return {
        ok: false,
        error: `compiled prompt message at index ${i} has invalid role or content`,
      };
    }
  }
  return { ok: true, messages: parsed as ModelInvokeMessage[] };
}

export function normalizeProfileIds(input: unknown[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of input) {
    const profileId = String(value).trim();
    if (!profileId || seen.has(profileId)) continue;
    seen.add(profileId);
    normalized.push(profileId);
  }
  return normalized;
}

function buildRuntime(store: PromptLabEngineStore, options: PromptLabEngineOptions): ModelRuntime {
  return createModelRuntime({
    providers: store.listProviders(),
    profiles: store.listProfiles(),
    cloudEnabled: options.cloudEnabled,
    recordCall: options.recordModelCall ?? store.recordModelCall,
  });
}

function createPromptLabResult(
  store: PromptLabEngineStore,
  input: {
    id: string;
    runId: string;
    profileId: string;
    profileName: string;
    modelName: string;
    status: string;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
    outputText?: string | null;
    error?: string | null;
    approxCost?: number | null;
    createdAt: string;
  }
): PromptLabResultRecord {
  return store.createResult({
    id: input.id,
    runId: input.runId,
    profileId: input.profileId,
    profileName: input.profileName,
    modelName: input.modelName,
    status: input.status,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    latencyMs: input.latencyMs,
    outputText: input.outputText ?? null,
    error: input.error ?? null,
    approxCost: input.approxCost ?? null,
    createdAt: input.createdAt,
  });
}

export async function runPromptLab(
  store: PromptLabEngineStore,
  input: PromptLabEngineInput,
  options: PromptLabEngineOptions
): Promise<PromptLabEngineResult> {
  const { projectId, promptId, notes, dryRun } = input;
  const { cloudEnabled } = options;
  const selectedProfiles = normalizeProfileIds(input.selectedProfiles);

  if (!projectId || !promptId || selectedProfiles.length === 0) {
    throw Object.assign(new Error("projectId, promptId, and modelProfileIds are required"), {
      statusCode: 400,
    });
  }
  if (selectedProfiles.length > 3) {
    throw Object.assign(new Error("a maximum of 3 model profiles can be selected"), {
      statusCode: 400,
    });
  }

  const project = store.getProject(projectId);
  if (!project) {
    throw Object.assign(new Error("project not found"), { statusCode: 404 });
  }

  const prompt = store.getCompiledPrompt(promptId);
  if (!prompt) {
    throw Object.assign(new Error("compiled prompt not found"), { statusCode: 404 });
  }

  const validation = validateMessages(prompt.messagesJson);
  if (!validation.ok) {
    throw Object.assign(new Error(validation.error), { statusCode: 400 });
  }

  const runId = createId("plr");
  const ts = new Date().toISOString();
  store.createRun({
    id: runId,
    sessionId: prompt.sessionId ?? null,
    projectId,
    promptId,
    mode: prompt.mode,
    selectedProfiles,
    notes,
    createdAt: ts,
    updatedAt: ts,
  });

  const runtime = buildRuntime(store, options);
  const promptPayload = {
    messages: validation.messages,
    modelName: null as string | null,
  };
  const results: PromptLabResultRecord[] = [];

  for (const profileId of selectedProfiles) {
    const profile = store.getProfile(profileId);
    if (!profile) {
      const result = createPromptLabResult(store, {
        id: createId("plres"),
        runId,
        profileId,
        profileName: profileId,
        modelName: profileId,
        status: "failed",
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: 0,
        error: "unknown profile",
        createdAt: ts,
      });
      results.push(result);
      continue;
    }
    if (dryRun) {
      const result = createPromptLabResult(store, {
        id: createId("plres"),
        runId,
        profileId: profile.id,
        profileName: profile.displayName ?? profile.modelName,
        modelName: profile.modelName,
        status: "blocked",
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: 0,
        error: "dry run",
        createdAt: ts,
      });
      results.push(result);
      continue;
    }
    const provider = store.listProviders().find((item) => item.id === profile.providerId) ?? null;
    if (provider && /cloud_openai_compat/i.test(provider.kind) && !cloudEnabled) {
      const result = createPromptLabResult(store, {
        id: createId("plres"),
        runId,
        profileId: profile.id,
        profileName: profile.displayName ?? profile.modelName,
        modelName: profile.modelName,
        status: "blocked",
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: 0,
        error: "cloud disabled",
        createdAt: ts,
      });
      results.push(result);
      continue;
    }
    try {
      const invocation = await runtime.invoke(
        profile.id,
        {
          role: "answer",
          messages: promptPayload.messages,
          metadata: {
            source: "prompt-lab",
            promptId,
            runId,
          },
        },
        {
          sessionId: prompt.sessionId ?? null,
          recordCall: options.recordModelCall ?? store.recordModelCall,
        }
      );
      const result = createPromptLabResult(store, {
        id: createId("plres"),
        runId,
        profileId: profile.id,
        profileName: profile.displayName ?? profile.modelName,
        modelName: profile.modelName,
        status: invocation.status ?? "ok",
        promptTokens: invocation.promptTokens,
        completionTokens: invocation.completionTokens,
        latencyMs: invocation.latencyMs,
        outputText: invocation.text,
        createdAt: ts,
      });
      results.push(result);
    } catch (error) {
      const result = createPromptLabResult(store, {
        id: createId("plres"),
        runId,
        profileId: profile.id,
        profileName: profile.displayName ?? profile.modelName,
        modelName: profile.modelName,
        status: "failed",
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: 0,
        error: error instanceof Error ? error.message : String(error),
        createdAt: ts,
      });
      results.push(result);
    }
  }

  return {
    run: {
      id: runId,
      sessionId: prompt.sessionId ?? null,
      projectId,
      promptId,
      mode: prompt.mode,
      selectedProfiles,
      notes,
      createdAt: ts,
      updatedAt: ts,
    },
    prompt,
    results,
  };
}
