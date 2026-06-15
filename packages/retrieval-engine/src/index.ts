import { redactSecrets } from "../../safety/src/index.ts";
import type {
  MemoryEntryRecord,
  ProjectRuleRecord,
  QueryAnalysis,
  QueryRewriteRecord,
  RetrievalChunk,
  RetrievalDepth,
  RetrievalFeedbackRecord,
  RetrievalIntentKind,
  RetrievalMissRecord,
  RetrievalMode,
  RetrievalResultRecord,
  RetrievalSelectedContextRecord,
} from "../../shared/src/index.ts";

export {
  ftsSearch,
  syncSearchIndexForFile,
  tryEnableSearchIndex,
} from "./fts.ts";
export type { BuildRetrievalPipelineInputArgs, RetrievalPipelineSource } from "./pipeline.ts";
export { buildRetrievalPipelineInput } from "./pipeline.ts";
export type {
  QdrantClientOptions,
  QdrantDimensionState,
  QdrantIndexChunkInput,
  QdrantPoint,
  QdrantRuntimeSettings,
  QueryEmbeddingInput,
} from "./qdrant.ts";
export {
  checkQdrantCollectionDimension,
  embedQueryForQdrant,
  ensureQdrantCollectionSync,
  hashContent,
  QdrantClient,
  qdrantPointForChunk,
  readQdrantRuntimeSettings,
  searchQdrantChunksSync,
  upsertQdrantChunksSync,
} from "./qdrant.ts";
export type { SearchProjectChunksInput } from "./search.ts";
export { searchProjectChunks } from "./search.ts";

const DEFINITION_TOKENS = new Set(["what", "where", "how", "why", "when", "which", "who"]);
const DEBUG_TOKENS = new Set([
  "fix",
  "bug",
  "error",
  "failing",
  "regression",
  "crash",
  "trace",
  "stack",
  "panic",
  "exception",
]);
const SYMBOL_TOKEN = /[A-Za-z_][A-Za-z0-9_]*[A-Z][A-Za-z0-9_]*/g;
const PATH_TOKEN = /[A-Za-z0-9_./-]+\.[a-z]{1,4}(?:\b|$)/g;
const STOP_TOKENS = new Set([
  "the",
  "and",
  "for",
  "are",
  "with",
  "this",
  "that",
  "from",
  "have",
  "has",
  "into",
  "you",
  "your",
  "our",
  "what",
  "where",
  "how",
  "why",
  "when",
  "which",
  "who",
  "find",
  "show",
  "give",
  "tell",
  "explain",
  "describe",
  "about",
  "please",
  "should",
  "would",
  "could",
  "there",
  "their",
  "they",
  "them",
  "then",
  "any",
  "all",
  "some",
  "most",
  "more",
  "less",
  "than",
]);

export function tokenize(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9_]+/g)
        .filter((term) => term.length >= 3 && !STOP_TOKENS.has(term))
    )
  );
}

export function classifyIntent(query: string, mode: "local" | "cloud" | "hybrid" | "index"): RetrievalIntentKind {
  const lowered = query.toLowerCase();
  if (mode === "index") return "lookup";
  if (Array.from(DEBUG_TOKENS).some((token) => lowered.includes(token))) return "debug";
  if (lowered.startsWith("plan") || lowered.includes(" plan ")) return "plan";
  if (lowered.startsWith("review") || lowered.includes(" review ")) return "review";
  if (lowered.startsWith("summarize") || lowered.startsWith("summary")) return "summary";
  if (lowered.includes("explain") || lowered.includes("how does") || lowered.includes("how do")) return "explain";
  return "lookup";
}

export function detectQueryLanguage(query: string): string | null {
  const lowered = query.toLowerCase();
  if (lowered.includes("typescript") || lowered.includes(" ts ") || lowered.includes(".ts")) return "typescript";
  if (lowered.includes("python") || lowered.includes(".py")) return "python";
  if (lowered.includes("rust") || lowered.includes(".rs")) return "rust";
  if (lowered.includes("go ") || lowered.includes(".go")) return "go";
  if (lowered.includes("swift") || lowered.includes(".swift")) return "swift";
  return null;
}

export function analyzeQuery(query: string): QueryAnalysis {
  const tokens = tokenize(query);
  const symbolMatches = Array.from(query.matchAll(SYMBOL_TOKEN)).map((m) => m[0]);
  const pathMatches = Array.from(query.matchAll(PATH_TOKEN)).map((m) => m[0]);
  const language = detectQueryLanguage(query);
  const notes: string[] = [];
  const startsWithDefinition = Array.from(DEFINITION_TOKENS).some((token) =>
    query.toLowerCase().trimStart().startsWith(`${token} `)
  );
  const isLikelyDefinition = startsWithDefinition || /what is|where is|how does/.test(query.toLowerCase());
  const isLikelyDebug = Array.from(DEBUG_TOKENS).some((token) => query.toLowerCase().includes(token));
  if (isLikelyDefinition) notes.push("definition-style question");
  if (isLikelyDebug) notes.push("debug-style question");
  if (symbolMatches.length > 0) notes.push("contains identifiers");
  if (pathMatches.length > 0) notes.push("contains path hints");
  return {
    language,
    terms: tokens,
    pathHints: Array.from(new Set(pathMatches)),
    symbolHints: Array.from(new Set(symbolMatches)),
    isLikelyDefinition,
    isLikelyDebug,
    notes,
  };
}

export interface QueryRewrite {
  variant: string;
  terms: string[];
  pathHints: string[];
  symbolHints: string[];
  reason: string;
}

export function rewriteQuery(query: string, analysis: QueryAnalysis): QueryRewrite {
  const terms = analysis.terms;
  const symbolHints = analysis.symbolHints;
  const pathHints = analysis.pathHints;
  const extra = symbolHints.length > 0 ? ` ${symbolHints.join(" ")}` : "";
  const variant = terms.length > 0 ? `${query.trim()} ${terms.join(" ")}${extra}`.trim() : query.trim();
  return {
    variant,
    terms,
    pathHints,
    symbolHints,
    reason: "base: include terms and symbol hints",
  };
}

export function buildFtsQuery(question: string): string | null {
  const terms = tokenize(question);
  if (terms.length === 0) {
    return null;
  }
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

export function rankChunk(question: string, path: string, content: string, startLine: number, endLine: number): number {
  const haystack = `${path}\n${content}`.toLowerCase();
  const terms = tokenize(question);
  let score = 0;
  if (question.trim().length > 0 && haystack.includes(question.toLowerCase().trim())) {
    score += 5;
  }
  for (const term of terms) {
    if (haystack.includes(term)) {
      score += term.length >= 6 ? 3 : 1;
    }
  }
  const pathParts = path
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
  for (const term of terms) {
    if (pathParts.includes(term)) {
      score += 2;
    }
  }
  if (terms.some((term) => pathParts.some((part) => part.startsWith(term) || term.startsWith(part)))) {
    score += 1;
  }
  if (/auth|login|session|token/i.test(path)) score += 2;
  if (/test|spec/i.test(path)) score += 1;
  if (/readme|docs?|notes?/i.test(path)) score += 1;
  if (/index|overview|summary/i.test(path)) score += 0.5;
  if (terms.some((term) => content.toLowerCase().includes(`${term}(`) || content.toLowerCase().includes(`${term} `))) {
    score += 1;
  }
  if (
    content
      .split("\n")[0]
      ?.toLowerCase()
      .includes(terms[0] ?? "")
  ) {
    score += 0.5;
  }
  score += Math.max(0, 5 - Math.min(5, Math.abs(endLine - startLine) / 40));
  return score;
}

export interface FeedbackBoostEntry {
  path: string;
  rating: "good" | "bad" | "missed";
  weight: number;
}

export function buildFeedbackBoosts(
  feedback: RetrievalFeedbackRecord[],
  fallbackChunkPaths: Map<string, string>
): { goodPaths: Map<string, number>; badChunkIds: Set<string>; missedPaths: Map<string, number> } {
  const goodPaths = new Map<string, number>();
  const badChunkIds = new Set<string>();
  const missedPaths = new Map<string, number>();
  for (const entry of feedback) {
    if (entry.rating === "good" && entry.chunkId) {
      const path = fallbackChunkPaths.get(entry.chunkId) ?? "";
      if (path) {
        goodPaths.set(path, (goodPaths.get(path) ?? 0) + 1);
      }
    } else if (entry.rating === "bad" && entry.chunkId) {
      badChunkIds.add(entry.chunkId);
    } else if (entry.rating === "missed" && entry.missedPath) {
      missedPaths.set(entry.missedPath, (missedPaths.get(entry.missedPath) ?? 0) + 1);
    }
  }
  return { goodPaths, badChunkIds, missedPaths };
}

export function applyFeedbackBoosts(
  chunk: RetrievalChunk,
  boosts: {
    goodPaths: Map<string, number>;
    badChunkIds: Set<string>;
    missedPaths: Map<string, number>;
  },
  missRecords: RetrievalMissRecord[]
): { score: number; applied: Array<"good" | "bad" | "missed"> } {
  const applied: Array<"good" | "bad" | "missed"> = [];
  let score = chunk.score;
  if (boosts.badChunkIds.has(chunk.id)) {
    score -= 5;
    applied.push("bad");
  }
  const goodWeight = boosts.goodPaths.get(chunk.path) ?? 0;
  if (goodWeight > 0) {
    score += Math.min(2, goodWeight);
    applied.push("good");
  }
  for (const miss of missRecords) {
    if (miss.missedPath === chunk.path) {
      score += Math.min(1.5, 0.5 + miss.confidence);
      applied.push("missed");
    }
  }
  const missBoost = boosts.missedPaths.get(chunk.path) ?? 0;
  if (missBoost > 0 && !applied.includes("missed")) {
    score += Math.min(1.5, missBoost * 0.5);
    applied.push("missed");
  }
  return { score, applied };
}

export interface RankedChunk {
  chunk: RetrievalChunk;
  baseScore: number;
  rerankScore: number;
  finalScore: number;
  rerankReason: string;
  boosters: Array<"good" | "bad" | "missed" | "memory" | "fact" | "rule" | "session" | "symbol" | "graph">;
}

export function rerankChunks(input: {
  query: string;
  analysis: QueryAnalysis;
  chunks: RetrievalChunk[];
  feedback: RetrievalFeedbackRecord[];
  feedbackChunkPaths: Map<string, string>;
  missRecords: RetrievalMissRecord[];
  pathBoosts: Map<string, number>;
  memoryEntries: MemoryEntryRecord[];
  facts: Array<{ key: string; value: string; confidence: number }>;
  rules: ProjectRuleRecord[];
  priorSessionPaths: string[];
  depth: RetrievalDepth;
}): RankedChunk[] {
  const { goodPaths, badChunkIds, missedPaths } = buildFeedbackBoosts(input.feedback, input.feedbackChunkPaths);
  const memoryTermSet = new Set(input.memoryEntries.flatMap((entry) => tokenize(`${entry.title} ${entry.body}`)));
  const factTermSet = new Set(input.facts.flatMap((fact) => tokenize(`${fact.key} ${fact.value}`)));
  const ruleTermSet = new Set(input.rules.flatMap((rule) => tokenize(`${rule.title} ${rule.body}`)));
  const priorSessionPathSet = new Set(input.priorSessionPaths);

  const ranked: RankedChunk[] = [];
  for (const chunk of input.chunks) {
    const baseScore = chunk.score;
    let rerankScore = baseScore;
    const boosters: RankedChunk["boosters"] = [];
    if (badChunkIds.has(chunk.id)) {
      rerankScore -= 5;
      boosters.push("bad");
    }
    const goodWeight = goodPaths.get(chunk.path) ?? 0;
    if (goodWeight > 0) {
      rerankScore += Math.min(2, goodWeight);
      boosters.push("good");
    }
    const pathBoost = input.pathBoosts.get(chunk.path) ?? 0;
    if (pathBoost > 0) {
      const delta = (pathBoost - 0.5) * 2;
      rerankScore += Math.max(-1, Math.min(1.5, delta));
    }
    const missWeight = missedPaths.get(chunk.path) ?? 0;
    if (missWeight > 0) {
      rerankScore += Math.min(1.5, missWeight * 0.5);
      boosters.push("missed");
    }
    const haystack = `${chunk.path}\n${chunk.content}`.toLowerCase();
    for (const term of memoryTermSet) {
      if (term && haystack.includes(term)) {
        rerankScore += 0.5;
        if (!boosters.includes("memory")) boosters.push("memory");
        break;
      }
    }
    for (const term of factTermSet) {
      if (term && haystack.includes(term)) {
        rerankScore += 0.5;
        if (!boosters.includes("fact")) boosters.push("fact");
        break;
      }
    }
    for (const term of ruleTermSet) {
      if (term && haystack.includes(term)) {
        rerankScore += 0.5;
        if (!boosters.includes("rule")) boosters.push("rule");
        break;
      }
    }
    const codeSymbols = Array.isArray(chunk.metadata.codeSymbols)
      ? (chunk.metadata.codeSymbols as Array<Record<string, unknown>>)
      : [];
    if (codeSymbols.length > 0) {
      const symbolHaystack = codeSymbols
        .map(
          (symbol) => `${String(symbol.name ?? "")} ${String(symbol.qualifiedName ?? "")} ${String(symbol.kind ?? "")}`
        )
        .join(" ")
        .toLowerCase();
      for (const term of tokenize(input.query)) {
        if (symbolHaystack.includes(term)) {
          rerankScore += 1.25;
          if (!boosters.includes("symbol")) boosters.push("symbol");
          break;
        }
      }
      if ((chunk.metadata.graphExpansion as Record<string, unknown> | undefined) != null) {
        rerankScore += 0.4;
        if (!boosters.includes("graph")) boosters.push("graph");
      }
    }
    if (priorSessionPathSet.has(chunk.path)) {
      rerankScore += 1.0;
      boosters.push("session");
    }
    const reason = boosters.length > 0 ? `boost:${boosters.join("+")}` : "no-boost";
    ranked.push({
      chunk,
      baseScore,
      rerankScore,
      finalScore: rerankScore,
      rerankReason: reason,
      boosters,
    });
  }
  ranked.sort((left, right) => right.finalScore - left.finalScore);
  return ranked;
}

export interface RewriteCandidate {
  variant: string;
  terms: string[];
  pathHints: string[];
  symbolHints: string[];
  reason: string;
  score: number;
}

export function generateRewrites(input: {
  query: string;
  analysis: QueryAnalysis;
  feedback: RetrievalFeedbackRecord[];
  facts: Array<{ key: string; value: string }>;
  memory: MemoryEntryRecord[];
}): RewriteCandidate[] {
  const base = rewriteQuery(input.query, input.analysis);
  const rewrites: RewriteCandidate[] = [{ ...base, score: 1.0 }];
  if (input.analysis.pathHints.length > 0) {
    const variant = `${input.query} ${input.analysis.pathHints.join(" ")}`.trim();
    rewrites.push({
      variant,
      terms: input.analysis.terms,
      pathHints: input.analysis.pathHints,
      symbolHints: input.analysis.symbolHints,
      reason: "path-biased",
      score: 0.9,
    });
  }
  if (input.analysis.symbolHints.length > 0) {
    const variant = `${input.query} ${input.analysis.symbolHints.join(" ")}`.trim();
    rewrites.push({
      variant,
      terms: input.analysis.terms,
      pathHints: input.analysis.pathHints,
      symbolHints: input.analysis.symbolHints,
      reason: "symbol-biased",
      score: 0.8,
    });
  }
  const missedPaths = Array.from(
    new Set(
      input.feedback
        .filter((entry) => entry.rating === "missed" && entry.missedPath)
        .map((entry) => entry.missedPath as string)
    )
  );
  if (missedPaths.length > 0) {
    const variant = `${input.query} ${missedPaths.join(" ")}`.trim();
    rewrites.push({
      variant,
      terms: input.analysis.terms,
      pathHints: input.analysis.pathHints,
      symbolHints: input.analysis.symbolHints,
      reason: "missed-path-anchored",
      score: 0.7,
    });
  }
  const factTerms = Array.from(
    new Set(input.facts.flatMap((fact) => tokenize(`${fact.key} ${fact.value}`)).filter((term) => term.length >= 4))
  ).slice(0, 6);
  if (factTerms.length > 0) {
    const variant = `${input.query} ${factTerms.join(" ")}`.trim();
    rewrites.push({
      variant,
      terms: input.analysis.terms,
      pathHints: input.analysis.pathHints,
      symbolHints: input.analysis.symbolHints,
      reason: "fact-anchored",
      score: 0.6,
    });
  }
  rewrites.sort((left, right) => right.score - left.score);
  return rewrites.slice(0, 5);
}

export interface HybridChunkSource {
  source: "fts" | "vector" | "heuristic";
  rank: number;
  score: number;
  chunk: RetrievalChunk;
}

export function hybridMerge(
  candidates: Array<{
    source: "fts" | "vector" | "heuristic";
    chunk: RetrievalChunk;
    score: number;
  }>
): RetrievalChunk[] {
  const merged = new Map<string, { chunk: RetrievalChunk; score: number; sources: Set<string> }>();
  for (const entry of candidates) {
    const current = merged.get(entry.chunk.id);
    if (current) {
      current.score = Math.max(current.score, entry.score) + 0.2;
      current.sources.add(entry.source);
    } else {
      merged.set(entry.chunk.id, {
        chunk: entry.chunk,
        score: entry.score,
        sources: new Set([entry.source]),
      });
    }
  }
  const items = Array.from(merged.values()).map((entry) => ({
    ...entry.chunk,
    score: entry.score,
    metadata: { ...entry.chunk.metadata, sources: Array.from(entry.sources) },
  }));
  items.sort((left, right) => right.score - left.score);
  return items;
}

export interface ConfidenceBreakdown {
  base: number;
  boost: number;
  penalty: number;
  final: number;
  notes: string[];
}

export function computeConfidence(
  ranked: RankedChunk[],
  intent: RetrievalIntentKind,
  depth: RetrievalDepth
): ConfidenceBreakdown {
  const top = ranked.slice(0, 3);
  if (top.length === 0) {
    return { base: 0, boost: 0, penalty: 0, final: 0, notes: ["no candidates"] };
  }
  const base = Math.min(1, top[0].finalScore / 8);
  const coverage = top.length / 3;
  const boost = top.reduce(
    (sum, entry) =>
      sum +
      (entry.boosters.includes("good") ? 0.1 : 0) +
      (entry.boosters.includes("rule") ? 0.05 : 0) +
      (entry.boosters.includes("fact") ? 0.05 : 0),
    0
  );
  const penalty = top.reduce((sum, entry) => sum + (entry.boosters.includes("bad") ? 0.2 : 0), 0);
  const depthWeight = depth === "deep" ? 0.05 : depth === "shallow" ? -0.05 : 0;
  const intentWeight = intent === "debug" ? -0.05 : intent === "explain" ? 0.05 : 0;
  const final = Math.max(0, Math.min(1, base * 0.7 + coverage * 0.3 + boost - penalty + depthWeight + intentWeight));
  const notes: string[] = [];
  if (base < 0.4) notes.push("low-base-score");
  if (coverage < 1) notes.push("thin-coverage");
  if (penalty > 0) notes.push("bad-feedback-applied");
  if (intentWeight < 0) notes.push("harder-intent");
  return { base, boost, penalty, final, notes };
}

export function selectTopByTokenBudget(input: { ranked: RankedChunk[]; budgetTokens: number; depth: RetrievalDepth }): {
  selected: RankedChunk[];
  dropped: RankedChunk[];
  usedTokens: number;
} {
  const maxItems = input.depth === "deep" ? 12 : input.depth === "shallow" ? 4 : 8;
  const selected: RankedChunk[] = [];
  const dropped: RankedChunk[] = [];
  let usedTokens = 0;
  for (const entry of input.ranked) {
    if (selected.length >= maxItems) {
      dropped.push(entry);
      continue;
    }
    const tokens = entry.chunk.tokenCount || Math.max(1, Math.ceil(entry.chunk.content.length / 4));
    if (usedTokens + tokens > input.budgetTokens) {
      dropped.push(entry);
      continue;
    }
    selected.push(entry);
    usedTokens += tokens;
  }
  return { selected, dropped, usedTokens };
}

export interface RetrievalPipelineInput {
  query: string;
  intent: RetrievalIntentKind;
  mode: RetrievalMode;
  depth: RetrievalDepth;
  ftsChunks: RetrievalChunk[];
  vectorChunks: RetrievalChunk[];
  heuristicChunks: RetrievalChunk[];
  feedback: RetrievalFeedbackRecord[];
  feedbackChunkPaths: Map<string, string>;
  missRecords: RetrievalMissRecord[];
  pathBoosts: Map<string, number>;
  memoryEntries: MemoryEntryRecord[];
  facts: Array<{ key: string; value: string; confidence: number; status?: string }>;
  rules: ProjectRuleRecord[];
  priorSessionPaths: string[];
  budgetTokens: number;
  secretTerms: string[];
}

export interface RetrievalPipelineOutput {
  analysis: QueryAnalysis;
  rewrites: RewriteCandidate[];
  candidates: RetrievalChunk[];
  ranked: RankedChunk[];
  selected: RankedChunk[];
  dropped: RankedChunk[];
  selectedContext: RetrievalSelectedContextRecord[];
  confidence: number;
  confidenceNotes: string[];
  usedTokens: number;
  miss?: { path: string; notes: string };
  boost: { good: number; missed: number; bad: number };
}

export function runRetrievalPipeline(input: RetrievalPipelineInput): RetrievalPipelineOutput {
  const analysis = analyzeQuery(input.query);
  const rewrites = generateRewrites({
    query: input.query,
    analysis,
    feedback: input.feedback,
    facts: input.facts,
    memory: input.memoryEntries,
  });
  const merged = hybridMerge([
    ...input.ftsChunks.map((chunk) => ({ source: "fts" as const, chunk, score: chunk.score })),
    ...input.vectorChunks.map((chunk) => ({
      source: "vector" as const,
      chunk,
      score: chunk.score,
    })),
    ...input.heuristicChunks.map((chunk) => ({
      source: "heuristic" as const,
      chunk,
      score: chunk.score,
    })),
  ]);
  const ranked = rerankChunks({
    query: input.query,
    analysis,
    chunks: merged,
    feedback: input.feedback,
    feedbackChunkPaths: input.feedbackChunkPaths,
    missRecords: input.missRecords,
    pathBoosts: input.pathBoosts,
    memoryEntries: input.memoryEntries,
    facts: input.facts,
    rules: input.rules,
    priorSessionPaths: input.priorSessionPaths,
    depth: input.depth,
  });
  const { selected, dropped, usedTokens } = selectTopByTokenBudget({
    ranked,
    budgetTokens: input.budgetTokens,
    depth: input.depth,
  });
  const confidence = computeConfidence(ranked, input.intent, input.depth);
  const selectedContext: RetrievalSelectedContextRecord[] = selected.map((entry, index) => ({
    id: `rsel_${input.query.length}_${index}`,
    retrievalQueryId: "",
    chunkId: entry.chunk.id,
    rank: index,
    tokenCount: entry.chunk.tokenCount || Math.max(1, Math.ceil(entry.chunk.content.length / 4)),
    excerpt: redactSecrets(entry.chunk.content.slice(0, 240)).text,
    createdAt: new Date().toISOString(),
  }));
  const miss =
    confidence.final < 0.3 && selected.length > 0
      ? { path: selected[0].chunk.path, notes: "low-confidence top hit" }
      : confidence.final < 0.2
        ? { path: "", notes: "no candidates met the bar" }
        : undefined;
  const boost = {
    good: input.feedback.filter((entry) => entry.rating === "good").length,
    bad: input.feedback.filter((entry) => entry.rating === "bad").length,
    missed: input.feedback.filter((entry) => entry.rating === "missed").length,
  };
  return {
    analysis,
    rewrites,
    candidates: merged,
    ranked,
    selected,
    dropped,
    selectedContext,
    confidence: confidence.final,
    confidenceNotes: confidence.notes,
    usedTokens,
    miss,
    boost,
  };
}

export function buildQueryRewriteRecords(retrievalQueryId: string, rewrites: RewriteCandidate[]): QueryRewriteRecord[] {
  const ts = new Date().toISOString();
  return rewrites.map((rewrite, index) => ({
    id: `${retrievalQueryId}_rewrite_${index}`,
    retrievalQueryId,
    variant: rewrite.variant,
    terms: rewrite.terms,
    pathHints: rewrite.pathHints,
    symbolHints: rewrite.symbolHints,
    score: rewrite.score,
    createdAt: ts,
  }));
}

export function buildResultRecords(
  retrievalQueryId: string,
  ranked: RankedChunk[],
  selected: RankedChunk[]
): RetrievalResultRecord[] {
  const selectedIds = new Set(selected.map((entry) => entry.chunk.id));
  const ts = new Date().toISOString();
  return ranked.map((entry) => ({
    id: `${retrievalQueryId}_result_${entry.chunk.id}`,
    retrievalQueryId,
    chunkId: entry.chunk.id,
    path: entry.chunk.path,
    startLine: entry.chunk.startLine,
    endLine: entry.chunk.endLine,
    source: "reranked",
    baseScore: entry.baseScore,
    rerankScore: entry.rerankScore,
    finalScore: entry.finalScore,
    included: selectedIds.has(entry.chunk.id),
    reason: entry.rerankReason,
    createdAt: ts,
  }));
}
