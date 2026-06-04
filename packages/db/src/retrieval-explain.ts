import { runRetrievalPipeline } from "../../retrieval-engine/src/index.ts";
import type {
  RetrievalDepth,
  RetrievalIntentKind,
  RetrievalMode,
} from "../../shared/src/index.ts";
import type { createStore } from "./store.ts";

type Store = ReturnType<typeof createStore>;

export interface RetrievalExplainInput {
  projectId: string;
  query: string;
  mode: RetrievalMode;
  depth: RetrievalDepth;
  limit: number;
}

export interface RetrievalExplainOutput {
  query: string;
  projectId: string;
  intent: ReturnType<typeof runRetrievalPipeline>["analysis"];
  rewrites: ReturnType<typeof runRetrievalPipeline>["rewrites"];
  confidence: number;
  confidenceNotes: string[];
  usedTokens: number;
  boost: { good: number; missed: number; bad: number };
  miss: { path: string; notes: string } | null;
  ranked: Array<{ chunkId: string; path: string; finalScore: number; rerankReason: string; boosters: string[] }>;
  selected: Array<{ chunkId: string; path: string; excerpt: string; finalScore: number }>;
  dropped: Array<{ chunkId: string; path: string; finalScore: number; reason: string }>;
}

function classifyIntentFromQuery(query: string): RetrievalIntentKind {
  if (/how|why|explain/i.test(query)) return "explain";
  if (/fix|error|bug|fail/i.test(query)) return "debug";
  if (/plan|design|architect/i.test(query)) return "plan";
  return "lookup";
}

export interface BuildRetrievalPipelineInputArgs {
  projectId: string;
  query: string;
  intent: RetrievalIntentKind;
  mode: RetrievalMode;
  depth: RetrievalDepth;
  ftsLimit: number;
}

export function buildRetrievalPipelineInput(
  store: Store,
  args: BuildRetrievalPipelineInputArgs,
): Parameters<typeof runRetrievalPipeline>[0] {
  const ftsChunks = store.searchChunks(args.projectId, args.query, { limit: args.ftsLimit });
  const heuristicChunks = store.searchChunks(args.projectId, "", { limit: 4 });
  const queries = store.retrieval.listQueriesForProject(args.projectId, 200);
  const feedback: ReturnType<Store["retrieval"]["listFeedback"]> = [];
  const misses: ReturnType<Store["retrieval"]["listMisses"]> = [];
  for (const q of queries) {
    for (const fb of store.retrieval.listFeedback(q.id, 50)) feedback.push(fb);
    for (const miss of store.retrieval.listMisses(q.id)) misses.push(miss);
  }
  const memoryEntries = store.memory.listEntries(args.projectId, "project", 50);
  const facts = store.memory.listFacts(args.projectId, 50);
  const rules = store.memory.listProjectRules(args.projectId, 50);
  const recentSessionPaths = store.listProjectFiles(args.projectId, 25).map((file) => file.path);
  const feedbackChunkPaths = new Map<string, string>();
  for (const fb of feedback) {
    if (fb.chunkId) feedbackChunkPaths.set(fb.chunkId, fb.missedPath ?? "");
  }
  const pathBoosts = new Map<string, number>();
  for (const boost of store.retrieval.listPathBoosts(args.projectId, 200)) {
    pathBoosts.set(boost.path, boost.weight);
  }
  return {
    query: args.query,
    intent: args.intent,
    mode: args.mode,
    depth: args.depth,
    ftsChunks,
    vectorChunks: [],
    heuristicChunks,
    feedback,
    feedbackChunkPaths,
    missRecords: misses,
    pathBoosts,
    memoryEntries,
    facts: facts.map((f) => ({ key: f.key, value: f.value, confidence: f.confidence, status: f.status })),
    rules,
    priorSessionPaths: recentSessionPaths,
    budgetTokens: 4096,
    secretTerms: [],
  };
}

export function runRetrievalExplain(store: Store, input: RetrievalExplainInput): RetrievalExplainOutput {
  const pipelineInput = buildRetrievalPipelineInput(store, {
    projectId: input.projectId,
    query: input.query,
    intent: classifyIntentFromQuery(input.query),
    mode: input.mode,
    depth: input.depth,
    ftsLimit: input.depth === "deep" ? 12 : input.depth === "shallow" ? 4 : input.limit,
  });
  const output = runRetrievalPipeline(pipelineInput);
  return {
    query: input.query,
    projectId: input.projectId,
    intent: output.analysis,
    rewrites: output.rewrites,
    confidence: output.confidence,
    confidenceNotes: output.confidenceNotes,
    usedTokens: output.usedTokens,
    boost: output.boost,
    miss: output.miss ?? null,
    ranked: output.ranked.map((entry) => ({
      chunkId: entry.chunk.id,
      path: entry.chunk.path,
      finalScore: entry.finalScore,
      rerankReason: entry.rerankReason,
      boosters: entry.boosters,
    })),
    selected: output.selected.map((entry) => ({
      chunkId: entry.chunk.id,
      path: entry.chunk.path,
      excerpt: entry.chunk.content.split("\n").slice(0, 4).join("\n"),
      finalScore: entry.finalScore,
    })),
    dropped: output.dropped.map((entry) => ({
      chunkId: entry.chunk.id,
      path: entry.chunk.path,
      finalScore: entry.finalScore,
      reason: entry.rerankReason,
    })),
  };
}
