import type { QueryAnalysis, RetrievalIntentKind } from "../../shared/src/index.ts";

const DEFINITION_TOKENS = new Set(["what", "where", "how", "why", "when", "which", "who"]);
const DEBUG_TOKENS = new Set(["fix", "bug", "error", "failing", "regression", "crash", "trace", "stack", "panic"]);
const SYMBOL_TOKEN = /[A-Za-z_][A-Za-z0-9_]*[A-Z][A-Za-z0-9_]*/g;
const PATH_TOKEN = /[A-Za-z0-9_./-]+\.[a-z]{1,4}(?:\b|$)/g;
const STOP_TOKENS = new Set([
  "the", "and", "for", "are", "with", "this", "that", "from", "have", "has", "into",
  "you", "your", "our", "what", "where", "how", "why", "when", "which", "who",
  "find", "show", "give", "tell", "explain", "describe", "about", "please",
  "should", "would", "could", "there", "their", "they", "them", "then",
  "any", "all", "some", "most", "more", "less", "than",
]);

export function tokenize(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9_]+/g)
        .filter((term) => term.length >= 3 && !STOP_TOKENS.has(term)),
    ),
  );
}

export function classifyIntent(query: string, mode: "local" | "cloud" | "hybrid" | "index"): RetrievalIntentKind {
  const lowered = query.toLowerCase();
  if (mode === "index") return "lookup";
  if (Array.from(DEBUG_TOKENS).some((token) => lowered.includes(token))) return "debug";
  if (Array.from(DEBUG_TOKENS).some((token) => lowered.startsWith(token))) return "debug";
  if (lowered.startsWith("plan") || lowered.includes("plan ")) return "plan";
  if (lowered.startsWith("review") || lowered.includes("review ")) return "review";
  if (lowered.startsWith("summarize") || lowered.startsWith("summary")) return "summary";
  if (lowered.includes("explain") || lowered.includes("how does") || lowered.includes("how do")) return "explain";
  return "lookup";
}

export function analyzeQuery(query: string): QueryAnalysis {
  const tokens = tokenize(query);
  const symbolMatches = Array.from(query.matchAll(SYMBOL_TOKEN)).map((m) => m[0]);
  const pathMatches = Array.from(query.matchAll(PATH_TOKEN)).map((m) => m[0]);
  const language = detectQueryLanguage(query);
  const notes: string[] = [];
  const startsWithDefinition = Array.from(DEFINITION_TOKENS).some((token) =>
    query.toLowerCase().trimStart().startsWith(`${token} `),
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

export function rewriteQuery(query: string, analysis: QueryAnalysis): {
  variant: string;
  terms: string[];
  pathHints: string[];
  symbolHints: string[];
} {
  const terms = analysis.terms;
  const symbolHints = analysis.symbolHints;
  const pathHints = analysis.pathHints;
  const extra = symbolHints.length > 0 ? ` ${symbolHints.join(" ")}` : "";
  const variant = terms.length > 0 ? `${query.trim()} ${terms.join(" ")}${extra}`.trim() : query.trim();
  return { variant, terms, pathHints, symbolHints };
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

export function buildFtsQuery(question: string): string | null {
  const terms = Array.from(
    new Set(
      question
        .toLowerCase()
        .split(/[^a-z0-9]+/g)
        .filter((term) => term.length >= 3),
    ),
  );
  if (terms.length === 0) {
    return null;
  }
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

export function rankChunk(question: string, path: string, content: string, startLine: number, endLine: number): number {
  const haystack = `${path}\n${content}`.toLowerCase();
  const terms = question
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((term) => term.length >= 3);
  let score = 0;
  if (question.trim().length > 0 && haystack.includes(question.toLowerCase().trim())) {
    score += 5;
  }
  for (const term of terms) {
    if (haystack.includes(term)) {
      score += term.length >= 6 ? 3 : 1;
    }
  }
  const pathParts = path.toLowerCase().split(/[^a-z0-9]+/g).filter(Boolean);
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
  if (content.split("\n")[0]?.toLowerCase().includes(terms[0] ?? "")) {
    score += 0.5;
  }
  score += Math.max(0, 5 - Math.min(5, Math.abs(endLine - startLine) / 40));
  return score;
}
