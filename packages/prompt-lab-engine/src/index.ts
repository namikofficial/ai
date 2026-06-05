import type { CompiledPromptRecord, ModelProfileRecord, ModelProviderKind, PromptLabResultRecord, PromptLabRunRecord } from "../../shared/src/index.ts";
import { createId } from "../../shared/src/index.ts";
import { createModelRuntime, type ModelInvokeMessage, type ModelRuntime } from "../../model-runtime/src/index.ts";

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
  listProviders(): Array<{ id: string; kind: ModelProviderKind; enabled: boolean }>;
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
}

export interface PromptLabEngineResult {
  run: PromptLabRunRecord;
  prompt: CompiledPromptRecord | null;
  results: PromptLabResultRecord[];
}

function validateMessages(messagesJson: string): { ok: true; messages: ModelInvokeMessage[] } | { ok: false; error: string } {
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
    if (!msg || typeof msg !== "object" || !["system", "user", "assistant"].includes((msg as Record<string, unknown>).role as string) || typeof (msg as Record<string, unknown>).content !== "string") {
      return { ok: false, error: `compiled prompt message at index ${i} has invalid role or content` };
    }
  }
  return { ok: true, messages: parsed as ModelInvokeMessage[] };
}

function buildRuntime(store: PromptLabEngineStore, cloudEnabled: boolean): ModelRuntime {
  return createModelRuntime({
    providers: store.listProviders().map((provider) => ({
      id: provider.id,
      kind: provider.kind,
      displayName: "",
      baseUrl: null,
      apiKeyEnv: null,
      enabled: provider.enabled,
    })),
    profiles: store.listProfiles(),
    cloudEnabled,
  });
}

export async function runPromptLab(
  store: PromptLabEngineStore,
  input: PromptLabEngineInput,
  options: PromptLabEngineOptions,
): Promise<PromptLabEngineResult> {
  const { projectId, promptId, selectedProfiles, notes, dryRun } = input;
  const { cloudEnabled } = options;

  if (!projectId || !promptId || selectedProfiles.length === 0) {
    throw Object.assign(new Error("projectId, promptId, and modelProfileIds are required"), { statusCode: 400 });
  }
  if (selectedProfiles.length > 3) {
    throw Object.assign(new Error("a maximum of 3 model profiles can be selected"), { statusCode: 400 });
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

  const runtime = buildRuntime(store, cloudEnabled);
  const promptPayload = {
    messages: validation.messages,
    modelName: null as string | null,
  };
  const results: PromptLabResultRecord[] = [];

  for (const profileId of selectedProfiles) {
    const profile = store.getProfile(profileId);
    if (!profile) {
      const result = store.createResult({
        id: createId("plres"),
        runId,
        profileId,
        profileName: profileId,
        modelName: profileId,
        status: "failed",
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: 0,
        outputText: null,
        error: "unknown profile",
        approxCost: null,
        createdAt: ts,
      });
      results.push(result);
      continue;
    }
    if (dryRun) {
      const result = store.createResult({
        id: createId("plres"),
        runId,
        profileId: profile.id,
        profileName: profile.displayName ?? profile.modelName,
        modelName: profile.modelName,
        status: "blocked",
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: 0,
        outputText: null,
        error: "dry run",
        approxCost: null,
        createdAt: ts,
      });
      results.push(result);
      continue;
    }
    const provider = store.listProviders().find((item) => item.id === profile.providerId) ?? null;
    if (provider && /cloud_openai_compat/i.test(provider.kind) && !cloudEnabled) {
      const result = store.createResult({
        id: createId("plres"),
        runId,
        profileId: profile.id,
        profileName: profile.displayName ?? profile.modelName,
        modelName: profile.modelName,
        status: "blocked",
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: 0,
        outputText: null,
        error: "cloud disabled",
        approxCost: null,
        createdAt: ts,
      });
      results.push(result);
      continue;
    }
    try {
      const invocation = await runtime.invoke(profile.id, {
        role: "answer",
        messages: promptPayload.messages,
        metadata: {
          source: "prompt-lab",
          promptId,
          runId,
        },
      });
      const result = store.createResult({
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
        error: null,
        approxCost: null,
        createdAt: ts,
      });
      results.push(result);
    } catch (error) {
      const result = store.createResult({
        id: createId("plres"),
        runId,
        profileId: profile.id,
        profileName: profile.displayName ?? profile.modelName,
        modelName: profile.modelName,
        status: "failed",
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: 0,
        outputText: null,
        error: error instanceof Error ? error.message : String(error),
        approxCost: null,
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
