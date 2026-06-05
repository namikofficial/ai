import { mkdir } from "node:fs/promises";
import { resolveConfig } from "../../../packages/config/src/index.ts";
import { initializeStore, createStore } from "../../../packages/db/src/store.ts";
import type { ConfigSnapshot } from "../../../packages/shared/src/index.ts";
import { createEvent } from "../../../packages/shared/src/index.ts";
import { isLikelyJsonOutput, parseJsonFragment } from "../../../packages/shared/src/model-output.ts";
import { compilePrompt } from "../../../packages/prompt-compiler/src/index.ts";
import {
  reflect as reflectEngine,
  type ReflectionOutput,
} from "../../../packages/reflection-engine/src/index.ts";
import type { ReflectInput } from "../../../packages/reflection-engine/src/index.ts";

interface WorkerOptions {
  config?: Partial<ConfigSnapshot>;
  pollIntervalMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePayload(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore malformed payloads and let the worker fail the job.
  }
  return {};
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((item) => typeof item === "string")) return null;
  return value;
}

function parseReflectionOutput(value: unknown): ReflectionOutput | null {
  if (!isObjectRecord(value)) return null;
  const notes = toStringArray(value.notes);
  if (!notes) return null;
  const output: ReflectionOutput = {
    memoryCandidates: [],
    skillCandidates: [],
    facts: [],
    staleFacts: [],
    retrievalFeedback: [],
    notes,
  };
  if (Array.isArray(value.memoryCandidates)) {
    output.memoryCandidates = value.memoryCandidates.filter((entry: unknown) => isObjectRecord(entry) && typeof entry.kind === "string" &&
      typeof entry.title === "string" && typeof entry.body === "string")
      .map((entry: Record<string, unknown>) => ({
        kind: entry.kind as ReflectionOutput["memoryCandidates"][number]["kind"],
        title: String(entry.title),
        body: String(entry.body),
        confidence: typeof entry.confidence === "number" ? Math.max(0, Math.min(1, entry.confidence)) : 0.5,
        evidence: Array.isArray(entry.evidence) ? entry.evidence.filter((ev: unknown) => isObjectRecord(ev)).map((ev: Record<string, unknown>) => ({
          kind: typeof ev.kind === "string" ? ev.kind as ReflectionOutput["memoryCandidates"][number]["evidence"][number]["kind"] : "conversation",
          refId: typeof ev.refId === "string" ? ev.refId : "",
          excerpt: typeof ev.excerpt === "string" ? ev.excerpt : "",
          meta: isObjectRecord(ev.meta) ? ev.meta : undefined,
        })) : [],
        scope: entry.scope === "global" ? "global" : "project",
      }));
  }
  if (Array.isArray(value.skillCandidates)) {
    output.skillCandidates = value.skillCandidates.filter((entry: unknown) => isObjectRecord(entry) && typeof entry.title === "string")
      .map((entry: Record<string, unknown>) => ({
        title: String(entry.title),
        triggerTerms: toStringArray(entry.triggerTerms) ?? [],
        steps: toStringArray(entry.steps) ?? [],
        requiredContext: toStringArray(entry.requiredContext) ?? [],
        commands: toStringArray(entry.commands) ?? [],
        safetyNotes: typeof entry.safetyNotes === "string" ? entry.safetyNotes : null,
        validation: toStringArray(entry.validation) ?? [],
        confidence: typeof entry.confidence === "number" ? Math.max(0, Math.min(1, entry.confidence)) : 0.5,
        sourceKind: entry.sourceKind === "manual" || entry.sourceKind === "imported" ? entry.sourceKind : "reflection",
        exampleSessionId: typeof entry.exampleSessionId === "string" ? entry.exampleSessionId : null,
        evidence: Array.isArray(entry.evidence) ? entry.evidence.filter((ev: unknown) => isObjectRecord(ev)).map((ev: Record<string, unknown>) => ({
          kind: typeof ev.kind === "string" ? ev.kind as ReflectionOutput["skillCandidates"][number]["evidence"][number]["kind"] : "conversation",
          refId: typeof ev.refId === "string" ? ev.refId : "",
          excerpt: typeof ev.excerpt === "string" ? ev.excerpt : "",
          meta: isObjectRecord(ev.meta) ? ev.meta : undefined,
        })) : [],
      }));
  }
  if (Array.isArray(value.facts)) {
    output.facts = value.facts.filter((entry: unknown) => isObjectRecord(entry) && typeof entry.key === "string" && typeof entry.value === "string")
      .map((entry: Record<string, unknown>) => ({
        key: String(entry.key),
        value: String(entry.value),
        kind: typeof entry.kind === "string" ? entry.kind : "reflection",
        confidence: typeof entry.confidence === "number" ? Math.max(0, Math.min(1, entry.confidence)) : 0.5,
        sourceKind: typeof entry.sourceKind === "string" ? entry.sourceKind : "reflection",
        sources: Array.isArray(entry.sources) ? entry.sources.filter((source: unknown) => isObjectRecord(source)).map((source: Record<string, unknown>) => ({
          kind: typeof source.kind === "string" ? source.kind : "session",
          ref: typeof source.ref === "string" ? source.ref : "",
          excerpt: typeof source.excerpt === "string" ? source.excerpt : null,
        })) : [],
        evidence: Array.isArray(entry.evidence) ? entry.evidence.filter((ev: unknown) => isObjectRecord(ev)).map((ev: Record<string, unknown>) => ({
          kind: typeof ev.kind === "string" ? ev.kind as ReflectionOutput["facts"][number]["evidence"][number]["kind"] : "conversation",
          refId: typeof ev.refId === "string" ? ev.refId : "",
          excerpt: typeof ev.excerpt === "string" ? ev.excerpt : "",
          meta: isObjectRecord(ev.meta) ? ev.meta : undefined,
        })) : [],
      }));
  }
  if (Array.isArray(value.staleFacts)) {
    output.staleFacts = value.staleFacts.filter((entry: unknown) => isObjectRecord(entry) && typeof entry.factId === "string" &&
      typeof entry.reason === "string")
      .map((entry: Record<string, unknown>) => ({
        factId: String(entry.factId),
        reason: String(entry.reason),
        evidence: Array.isArray(entry.evidence) ? entry.evidence.filter((ev: unknown) => isObjectRecord(ev)).map((ev: Record<string, unknown>) => ({
          kind: typeof ev.kind === "string" ? ev.kind as ReflectionOutput["staleFacts"][number]["evidence"][number]["kind"] : "review",
          refId: typeof ev.refId === "string" ? ev.refId : "",
          excerpt: typeof ev.excerpt === "string" ? ev.excerpt : "",
          meta: isObjectRecord(ev.meta) ? ev.meta : undefined,
        })) : [],
      }));
  }
  if (Array.isArray(value.retrievalFeedback)) {
    output.retrievalFeedback = value.retrievalFeedback.filter((entry: unknown) => isObjectRecord(entry) && typeof entry.retrievalQueryId === "string")
      .map((entry: Record<string, unknown>) => ({
        retrievalQueryId: String(entry.retrievalQueryId),
        chunkId: typeof entry.chunkId === "string" ? entry.chunkId : null,
        rating: entry.rating === "good" || entry.rating === "bad" ? entry.rating : "missed",
        missedPath: typeof entry.missedPath === "string" ? entry.missedPath : null,
        notes: typeof entry.notes === "string" ? entry.notes : null,
        evidence: Array.isArray(entry.evidence) ? entry.evidence.filter((ev: unknown) => isObjectRecord(ev)).map((ev: Record<string, unknown>) => ({
          kind: typeof ev.kind === "string" ? ev.kind as ReflectionOutput["retrievalFeedback"][number]["evidence"][number]["kind"] : "query",
          refId: typeof ev.refId === "string" ? ev.refId : "",
          excerpt: typeof ev.excerpt === "string" ? ev.excerpt : "",
          meta: isObjectRecord(ev.meta) ? ev.meta : undefined,
        })) : [],
      }));
  }
  return output;
}

function mergeReflectionOutput(base: ReflectionOutput, modelOutput: ReflectionOutput | null): ReflectionOutput {
  if (!modelOutput) return base;
  const merged: ReflectionOutput = {
    memoryCandidates: [...base.memoryCandidates],
    skillCandidates: [...base.skillCandidates],
    facts: [...base.facts],
    staleFacts: [...base.staleFacts],
    retrievalFeedback: [...base.retrievalFeedback],
    notes: [...base.notes],
  };
  const memoryKeys = new Set(merged.memoryCandidates.map((entry) => `${entry.kind}:${entry.title}:${entry.body}`));
  for (const entry of modelOutput.memoryCandidates) {
    const key = `${entry.kind}:${entry.title}:${entry.body}`;
    if (memoryKeys.has(key)) continue;
    memoryKeys.add(key);
    merged.memoryCandidates.push(entry);
  }
  const skillKeys = new Set(merged.skillCandidates.map((entry) => entry.title));
  for (const entry of modelOutput.skillCandidates) {
    if (skillKeys.has(entry.title)) continue;
    skillKeys.add(entry.title);
    merged.skillCandidates.push(entry);
  }
  const factKeys = new Set(merged.facts.map((entry) => `${entry.key}:${entry.value}`));
  for (const entry of modelOutput.facts) {
    const key = `${entry.key}:${entry.value}`;
    if (factKeys.has(key)) continue;
    factKeys.add(key);
    merged.facts.push(entry);
  }
  const staleKeys = new Set(merged.staleFacts.map((entry) => entry.factId));
  for (const entry of modelOutput.staleFacts) {
    if (staleKeys.has(entry.factId)) continue;
    staleKeys.add(entry.factId);
    merged.staleFacts.push(entry);
  }
  const retrievalKeys = new Set(merged.retrievalFeedback.map((entry) => `${entry.retrievalQueryId}:${entry.chunkId ?? ""}:${entry.rating}:${entry.missedPath ?? ""}`));
  for (const entry of modelOutput.retrievalFeedback) {
    const key = `${entry.retrievalQueryId}:${entry.chunkId ?? ""}:${entry.rating}:${entry.missedPath ?? ""}`;
    if (retrievalKeys.has(key)) continue;
    retrievalKeys.add(key);
    merged.retrievalFeedback.push(entry);
  }
  const noteSet = new Set(merged.notes);
  for (const note of modelOutput.notes) {
    if (noteSet.has(note)) continue;
    noteSet.add(note);
    merged.notes.push(note);
  }
  return merged;
}

function buildReflectionInput(store: ReturnType<typeof createStore>, sessionId: string): ReflectInput {
  const session = store.getSession(sessionId);
  if (!session) {
    throw new Error(`Unknown session: ${sessionId}`);
  }
  const projectId = session.projectId ?? undefined;
  const conversation = store.conversation.listMessages(sessionId);
  const retrievals = store.retrieval.listQueriesForSession(sessionId, 50);
  const retrievalResults = new Map<string, ReturnType<typeof store.retrieval.listResults>>();
  const retrievalSelectedContext = new Map<string, ReturnType<typeof store.retrieval.listSelectedContext>>();
  const allFeedback: ReturnType<typeof store.retrieval.listFeedback> extends Array<infer T> ? T[] : never = [];
  const allMisses: ReturnType<typeof store.retrieval.listMisses> extends Array<infer T> ? T[] : never = [];
  for (const query of retrievals) {
    retrievalResults.set(query.id, store.retrieval.listResults(query.id, 200));
    retrievalSelectedContext.set(query.id, store.retrieval.listSelectedContext(query.id));
    for (const fb of store.retrieval.listFeedback(query.id, 50)) {
      allFeedback.push(fb);
    }
    for (const miss of store.retrieval.listMisses(query.id)) {
      allMisses.push(miss);
    }
  }
  const contextPackRecords = store.context.listPacksForSession(sessionId, 50);
  const contextPacks = contextPackRecords.map((pack) => ({
    id: pack.id,
    usedTokens: pack.usedTokens,
    budgetTokens: pack.budgetTokens,
    retrievalQueryId: pack.retrievalQueryId,
  }));
  const agentRuns = store.agents.listRuns(sessionId, 200);
  const modelCalls = store.models.listCalls(sessionId, 200);
  const checks = store.listCheckRuns(50);
  const reviews = projectId ? store.listReviews(projectId, 50) : store.listReviews(null, 50);
  const answerEvaluations = store.evals.listAnswerEvaluations(50);
  const outcomes = store.evals.listOutcomes(sessionId, 20);
  const outcome = outcomes.at(-1) ?? null;
  const existingFacts = projectId ? store.memory.listFacts(projectId, 200) : store.memory.listFacts(null, 200);
  const existingRules = projectId
    ? store.memory.listProjectRules(projectId, 200)
    : [];
  const existingSkills = store.skills.listSkills(undefined, 200);
  return {
    session,
    conversation,
    retrievals,
    retrievalResults,
    retrievalSelectedContext,
    retrievalFeedback: allFeedback,
    retrievalMisses: allMisses,
    contextPacks,
    agentRuns,
    modelCalls,
    checks,
    reviews,
    answerEvaluations,
    outcome,
    existingFacts,
    existingRules,
    existingSkills,
  };
}

async function recordReflectionModelTrace(
  store: ReturnType<typeof createStore>,
  sessionId: string,
  input: ReflectInput,
): Promise<{
  compiledId: string;
  modelCallId: string | null;
  parsedOutput: ReflectionOutput | null;
  parseStatus: "parsed" | "repaired" | "deterministic_fallback";
}> {
  const contextItems = input.contextPacks.flatMap((pack) =>
    store.context.listItems(pack.id)
      .filter((item) => item.included)
      .map((item) => ({
        kind: item.kind,
        rank: item.rank,
        tokenCount: item.tokenCount,
        excerpt: item.excerpt,
        sourceId: item.sourceId,
      })),
  );
  const compiled = compilePrompt({
    mode: "reflection",
    role: "reflection",
    contextPackId: input.contextPacks.at(-1)?.id ?? undefined,
    userRequest: `Reflect on completed session ${sessionId}: ${input.session.userGoal}`,
    previousMessages: input.conversation,
    projectRules: input.existingRules,
    facts: input.existingFacts,
    contextPackItems: contextItems,
    taskConstraints: [
      `Outcome: ${input.outcome?.outcome ?? input.session.status}`,
      `Retrieval queries: ${input.retrievals.length}`,
      `Model calls: ${input.modelCalls.length}`,
      "Create reviewable candidates only. Do not auto-accept memory or skills.",
      "Redact secrets and cite source ids in evidence.",
    ],
    outputSchema: {
      type: "object",
      properties: {
        memoryCandidates: { type: "array" },
        skillCandidates: { type: "array" },
        facts: { type: "array" },
        staleFacts: { type: "array" },
        retrievalFeedback: { type: "array" },
        notes: { type: "array", items: { type: "string" } },
      },
      required: ["memoryCandidates", "skillCandidates", "facts", "staleFacts", "retrievalFeedback", "notes"],
    },
    metadata: { sessionId, projectId: input.session.projectId },
    tokenBudget: 4096,
  });
  store.recordCompiledPrompt({
    compiledPrompt: compiled,
    sessionId,
    contextPackId: input.contextPacks.at(-1)?.id ?? undefined,
  });
  const reflectionResult = await store.invokeModel(
    "reflection-local",
    {
      role: "reflection",
      messages: compiled.messages,
      temperature: 0,
      metadata: {
        compiledPrompt: compiled,
        responseTrace: {
          deterministicReflection: true,
          sessionId,
          retrievalQueries: input.retrievals.length,
          modelCalls: input.modelCalls.length,
          contextPacks: input.contextPacks.length,
        },
      },
    },
    { sessionId },
  );
  const parseReflectionResult = (text: string): ReflectionOutput | null => {
    try {
      return parseReflectionOutput(parseJsonFragment(text));
    } catch {
      return null;
    }
  };
  let parsedOutput = parseReflectionResult(reflectionResult.text);
  let parseStatus: "parsed" | "repaired" | "deterministic_fallback" = "deterministic_fallback";
  if (parsedOutput) {
    parseStatus = "parsed";
  } else if (isLikelyJsonOutput(reflectionResult.text)) {
    const repaired = await store.invokeModel(
      "reflection-local",
      {
        role: "reflection",
        messages: [
          ...compiled.messages,
          { role: "assistant", content: reflectionResult.text },
          { role: "user", content: "Return ONLY valid JSON matching the output schema. No markdown fences." },
        ],
        temperature: 0,
        metadata: {
          compiledPrompt: compiled,
          responseTrace: {
            repairAttempt: true,
            sessionId,
          },
        },
      },
      { sessionId },
    );
    parsedOutput = parseReflectionResult(repaired.text);
    if (parsedOutput) {
      parseStatus = "repaired";
    }
  }
  const modelCallId = store.models.listCalls(sessionId, 200)
    .filter((call) => call.role === "reflection" && call.profileId === "reflection-local")
    .at(-1)?.id ?? null;
  return { compiledId: compiled.id, modelCallId, parsedOutput, parseStatus };
}

interface ReflectionCounts {
  memoryCandidates: number;
  skillCandidates: number;
  facts: number;
  staleFacts: number;
  retrievalFeedback: number;
}

function applyReflectionOutput(
  store: ReturnType<typeof createStore>,
  sessionId: string,
  output: ReflectionOutput,
): ReflectionCounts {
  const session = store.getSession(sessionId);
  const projectId = session?.projectId ?? null;
  let memoryCandidates = 0;
  let skillCandidates = 0;
  let facts = 0;
  let retrievalFeedback = 0;
  store.db.exec("BEGIN");
  try {
    for (const candidate of output.memoryCandidates) {
      store.memory.createCandidate({
        projectId,
        sessionId,
        kind: candidate.kind,
        title: candidate.title,
        body: candidate.body,
        evidence: candidate.evidence as unknown as Array<Record<string, unknown>>,
        confidence: candidate.confidence,
        scope: candidate.scope,
      });
      memoryCandidates += 1;
    }
    for (const candidate of output.skillCandidates) {
      store.skills.createCandidate({
        projectId,
        title: candidate.title,
        triggerTerms: candidate.triggerTerms,
        applicableProjects: projectId ? [projectId] : [],
        steps: candidate.steps,
        requiredContext: candidate.requiredContext,
        commands: candidate.commands,
        safetyNotes: candidate.safetyNotes,
        validation: candidate.validation,
        exampleSessionId: candidate.exampleSessionId,
        sourceKind: candidate.sourceKind,
        confidence: candidate.confidence,
      });
      skillCandidates += 1;
    }
    for (const fact of output.facts) {
      store.memory.recordFact({
        projectId,
        key: fact.key,
        value: fact.value,
        kind: fact.kind,
        confidence: fact.confidence,
        sourceKind: fact.sourceKind,
        sources: fact.sources.map((source) => ({ kind: source.kind, ref: source.ref, excerpt: source.excerpt })),
      });
      facts += 1;
    }
    for (const feedback of output.retrievalFeedback) {
      store.retrieval.recordFeedback({
        retrievalQueryId: feedback.retrievalQueryId,
        chunkId: feedback.chunkId,
        rating: feedback.rating,
        missedPath: feedback.missedPath,
        notes: feedback.notes,
      });
      retrievalFeedback += 1;
    }
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
  return { memoryCandidates, skillCandidates, facts, staleFacts: output.staleFacts.length, retrievalFeedback };
}

export async function processNextJob(store: ReturnType<typeof createStore>): Promise<boolean> {
  const job = store.claimNextJob();
  if (!job) {
    return false;
  }

  try {
    const payload = parsePayload(job.payloadJson);
    let output: unknown;

    if (job.type === "plan.review") {
      const projectId = typeof payload.projectId === "string" ? payload.projectId : null;
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : null;
      const goal = typeof payload.goal === "string" ? payload.goal : "unknown goal";
      const taskGraph = Array.isArray(payload.taskGraph) ? payload.taskGraph : [];
      const editedFiles = taskGraph.flatMap((task) => {
        if (typeof task !== "object" || task === null) return [];
        const files = (task as { expectedFiles?: unknown }).expectedFiles;
        return Array.isArray(files) ? files.filter((file): file is string => typeof file === "string") : [];
      });
      let counts: ReflectionCounts = { memoryCandidates: 0, skillCandidates: 0, facts: 0, staleFacts: 0, retrievalFeedback: 0 };
      let notes: string[] = [];
      if (sessionId) {
        const reflectInput = buildReflectionInput(store, sessionId);
        const trace = await recordReflectionModelTrace(store, sessionId, reflectInput);
        const deterministicReflection = reflectEngine(reflectInput);
        const reflection = mergeReflectionOutput(deterministicReflection, trace.parsedOutput);
        counts = applyReflectionOutput(store, sessionId, reflection);
        notes = reflection.notes;
        store.appendEvent(
          createEvent(
            "plan.reviewed",
            {
              sessionId,
              projectId,
              goal,
              taskCount: taskGraph.length,
              counts,
              noteCount: notes.length,
              compiledId: trace.compiledId,
              modelCallId: trace.modelCallId,
              parseStatus: trace.parseStatus,
            },
            { sessionId, projectId, agent: "reflection" },
          ),
        );
      }
      output = {
        review: store.createReview({
          project: projectId ?? "",
          sessionId,
          title: `Plan review: ${goal}`,
          plannedFiles: [],
          editedFiles,
          checks: ["typecheck", "tests"],
          notes: notes.length > 0
            ? notes.join("\n")
            : `Reviewed a generated plan with ${taskGraph.length} tasks for ${goal}.`,
        }),
        lesson: store.createLesson({
          projectId,
          sessionId,
          title: `Plan review: ${goal}`,
          body: notes.length > 0
            ? notes.join("\n")
            : `Reviewed a generated plan with ${taskGraph.length} tasks for ${goal}.`,
          tags: ["worker", "review", "plan"],
          importance: 2,
        }),
        counts,
      };
    } else if (job.type === "handoff.archive") {
      const projectId = typeof payload.projectId === "string" ? payload.projectId : null;
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : null;
      const target = typeof payload.target === "string" ? payload.target : "manual";
      const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
      let counts: ReflectionCounts = { memoryCandidates: 0, skillCandidates: 0, facts: 0, staleFacts: 0, retrievalFeedback: 0 };
      let notes: string[] = [];
      if (sessionId) {
        const reflectInput = buildReflectionInput(store, sessionId);
        const trace = await recordReflectionModelTrace(store, sessionId, reflectInput);
        const deterministicReflection = reflectEngine(reflectInput);
        const reflection = mergeReflectionOutput(deterministicReflection, trace.parsedOutput);
        counts = applyReflectionOutput(store, sessionId, reflection);
        notes = reflection.notes;
        store.appendEvent(
          createEvent(
            "handoff.archived",
            {
              sessionId,
              projectId,
              target,
              counts,
              noteCount: notes.length,
              compiledId: trace.compiledId,
              modelCallId: trace.modelCallId,
              parseStatus: trace.parseStatus,
            },
            { sessionId, projectId, agent: "reflection" },
          ),
        );
      }
      const reflectionBody = notes.length > 0 ? notes.join("\n") : prompt.slice(0, 500);
      output = {
        review: store.createReview({
          project: projectId ?? "",
          sessionId,
          title: `Handoff archive: ${target}`,
          plannedFiles: [],
          editedFiles: [],
          checks: ["typecheck", "tests"],
          notes: reflectionBody,
        }),
        lesson: store.createLesson({
          projectId,
          sessionId,
          title: `Handoff archive: ${target}`,
          body: reflectionBody,
          tags: ["worker", "handoff"],
          importance: 2,
        }),
        counts,
      };
    } else if (job.type === "session.reflect") {
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : null;
      if (!sessionId) {
        throw new Error("session.reflect requires sessionId");
      }
      const session = store.getSession(sessionId);
      if (!session) {
        throw new Error(`Unknown session: ${sessionId}`);
      }
      const reflectInput = buildReflectionInput(store, sessionId);
      const trace = await recordReflectionModelTrace(store, sessionId, reflectInput);
      const deterministicReflection = reflectEngine(reflectInput);
      const reflection = mergeReflectionOutput(deterministicReflection, trace.parsedOutput);
      const counts = applyReflectionOutput(store, sessionId, reflection);
      const lesson = store.createLesson({
        projectId: session.projectId,
        sessionId: session.id,
        title: `Reflection: ${session.title}`,
        body: reflection.notes.length > 0 ? reflection.notes.join("\n") : session.finalSummary ?? session.userGoal,
        tags: ["worker", "reflection", "engine"],
        importance: 3,
      });
      store.appendEvent(
        createEvent(
          "session.reflected",
          {
            sessionId,
            projectId: session.projectId,
            counts,
            noteCount: reflection.notes.length,
            compiledId: trace.compiledId,
            modelCallId: trace.modelCallId,
            parseStatus: trace.parseStatus,
          },
          { sessionId, projectId: session.projectId, agent: "reflection" },
        ),
      );
      output = { lesson, counts, notes: reflection.notes };
    } else if (job.type === "review.reflect") {
      const reviewId = typeof payload.reviewId === "string" ? payload.reviewId : null;
      const review = reviewId ? store.getReview(reviewId) : null;
      if (!review) {
        throw new Error(`Unknown review: ${reviewId ?? "missing"}`);
      }
      const sessionId = review.sessionId;
      let counts: ReflectionCounts = { memoryCandidates: 0, skillCandidates: 0, facts: 0, staleFacts: 0, retrievalFeedback: 0 };
      if (sessionId) {
        const reflectInput = buildReflectionInput(store, sessionId);
        const trace = await recordReflectionModelTrace(store, sessionId, reflectInput);
        const deterministicReflection = reflectEngine(reflectInput);
        const reflection = mergeReflectionOutput(deterministicReflection, trace.parsedOutput);
        counts = applyReflectionOutput(store, sessionId, reflection);
        store.appendEvent(
          createEvent(
            "review.reflected",
            { reviewId, sessionId, counts, compiledId: trace.compiledId, modelCallId: trace.modelCallId, parseStatus: trace.parseStatus },
            { sessionId, projectId: review.projectId, agent: "reflection" },
          ),
        );
      }
      output = store.createLesson({
        projectId: review.projectId,
        sessionId: review.sessionId,
        title: `Review reflection: ${review.title}`,
        body: `${review.summary}\n\nReflect on follow-up actions and keep the scope tight.`,
        tags: ["worker", "review", "reflection", "engine"],
        importance: 3,
      });
    } else {
      output = { skipped: true, reason: `No worker for job type ${job.type}` };
    }

    store.completeJob(job.id, output);
    return true;
  } catch (error) {
    store.failJob(job.id, error instanceof Error ? error.message : String(error));
    return true;
  }
}

export async function startWorkbenchWorker(options: WorkerOptions = {}): Promise<void> {
  const config = resolveConfig(options.config ?? {});
  await mkdir(config.runtimeDir, { recursive: true });
  const store = createStore(initializeStore(config.databasePath));
  await store.ensureRuntimeDirs(config.runtimeDir);

  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  let stopped = false;

  process.on("SIGINT", () => {
    stopped = true;
  });
  process.on("SIGTERM", () => {
    stopped = true;
  });

  while (!stopped) {
    const processed = await processNextJob(store);
    if (!processed) {
      await sleep(pollIntervalMs);
    }
  }
}
