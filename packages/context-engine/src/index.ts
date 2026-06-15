import type { RankedChunk } from "../../retrieval-engine/src/index.ts";
import { redactSecrets } from "../../safety/src/index.ts";
import type {
  ContextBudgetEventRecord,
  ContextPackItemKind,
  ContextPackItemRecord,
  ContextPackRecord,
  ConversationMessageRecord,
  FactRecord,
  MemoryEntryRecord,
  ProjectRuleRecord,
  SkillRecord,
} from "../../shared/src/index.ts";

export const APPROX_TOKENS_PER_CHAR = 0.25;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length * APPROX_TOKENS_PER_CHAR));
}

export interface ContextCandidate {
  kind: ContextPackItemKind;
  sourceId: string | null;
  excerpt: string;
  priority: number;
  pinned?: boolean;
  reason?: string;
  reference?: Record<string, unknown>;
}

export interface BuildContextPackInput {
  sessionId?: string | null;
  taskId?: string | null;
  projectId?: string | null;
  retrievalQueryId?: string | null;
  budgetTokens: number;
  ranked: RankedChunk[];
  memoryEntries?: MemoryEntryRecord[];
  facts?: FactRecord[];
  rules?: ProjectRuleRecord[];
  previousMessages?: ConversationMessageRecord[];
  previousSessionSummaries?: Array<{ id: string; summary: string; ts: string }>;
  skills?: SkillRecord[];
  checkFailures?: Array<{ name: string; output: string; ts: string }>;
  gitState?: { branch: string; dirty: boolean; recentFiles: string[] } | null;
  freshFactTtlDays?: number;
  systemInstructions?: string[];
}

export interface BuildContextPackOutput {
  pack: ContextPackRecord;
  items: ContextPackItemRecord[];
  budgetEvents: ContextBudgetEventRecord[];
  redactionNotes: string[];
}

function jaccard(left: string, right: string): number {
  if (left === right) return 1;
  const a = new Set(
    left
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter((token) => token.length >= 3)
  );
  const b = new Set(
    right
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter((token) => token.length >= 3)
  );
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function dedupeCandidates(candidates: ContextCandidate[]): {
  kept: ContextCandidate[];
  omitted: Array<{ candidate: ContextCandidate; reason: string; jaccardWith: string }>;
} {
  const kept: ContextCandidate[] = [];
  const omitted: Array<{ candidate: ContextCandidate; reason: string; jaccardWith: string }> = [];
  for (const candidate of candidates) {
    let duplicateOf: string | null = null;
    let bestScore = 0;
    for (const existing of kept) {
      const score = jaccard(candidate.excerpt, existing.excerpt);
      if (score > 0.85 && score > bestScore) {
        bestScore = score;
        duplicateOf = `${existing.kind}:${existing.sourceId ?? "anon"}`;
      }
    }
    if (duplicateOf) {
      omitted.push({ candidate, reason: "near-duplicate", jaccardWith: duplicateOf });
      continue;
    }
    kept.push(candidate);
  }
  return { kept, omitted };
}

function isFactFresh(fact: FactRecord, ttlDays: number): boolean {
  if (fact.status === "stale" || fact.status === "disputed" || fact.status === "archived") return false;
  if (fact.expiresAt && new Date(fact.expiresAt).getTime() < Date.now()) return false;
  if (fact.lastVerifiedAt) {
    const ageDays = (Date.now() - new Date(fact.lastVerifiedAt).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays > ttlDays) return false;
  }
  return true;
}

function excerptFromContent(content: string, maxChars = 240): string {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars - 12)}... [truncated]`;
}

function isAcceptedMemory(entry: MemoryEntryRecord): boolean {
  return !entry.archived;
}

function isRelevantMemory(entry: MemoryEntryRecord, queryTerms: Set<string>): boolean {
  if (entry.scope === "global") return true;
  if (entry.useCount === 0 && !entry.pinned) return false;
  if (queryTerms.size === 0) return entry.pinned || entry.scope === "project";
  const haystack = `${entry.title} ${entry.body}`.toLowerCase();
  for (const term of queryTerms) {
    if (term && haystack.includes(term)) return true;
  }
  return entry.pinned;
}

export function buildContextPack(input: BuildContextPackInput): BuildContextPackOutput {
  const candidates: ContextCandidate[] = [];
  const redactionNotes: string[] = [];
  const freshTtl = input.freshFactTtlDays ?? 30;
  const queryTerms = new Set(
    input.ranked.flatMap((entry) =>
      entry.chunk.content
        .toLowerCase()
        .split(/[^a-z0-9]+/g)
        .filter((token) => token.length >= 4)
    )
  );

  for (const system of input.systemInstructions ?? []) {
    candidates.push({
      kind: "system",
      sourceId: null,
      excerpt: system,
      priority: 0,
      pinned: true,
      reason: "system",
    });
  }

  for (const rule of input.rules ?? []) {
    if (!rule) continue;
    candidates.push({
      kind: "project_rule",
      sourceId: rule.id,
      excerpt: excerptFromContent(`${rule.title}\n${rule.body}`),
      priority: 1,
      pinned: rule.pinned === true,
      reason: rule.pinned ? "pinned-rule" : "rule",
    });
  }

  for (const entry of input.ranked) {
    const redacted = redactSecrets(entry.chunk.content);
    if (redacted.redactions.length > 0) {
      redactionNotes.push(`chunk:${entry.chunk.id} redacted ${redacted.redactions.length} secret(s)`);
    }
    candidates.push({
      kind: "retrieval_chunk",
      sourceId: entry.chunk.id,
      excerpt: excerptFromContent(redacted.text),
      priority: 2 + entry.finalScore / 10,
      reason: entry.rerankReason,
      reference: {
        path: entry.chunk.path,
        startLine: entry.chunk.startLine,
        endLine: entry.chunk.endLine,
        boosters: entry.boosters,
      },
    });

    const codeSymbols = Array.isArray(entry.chunk.metadata.codeSymbols)
      ? (entry.chunk.metadata.codeSymbols as Array<Record<string, unknown>>)
      : [];
    for (const symbol of codeSymbols) {
      const qualifiedName =
        typeof symbol.qualifiedName === "string"
          ? symbol.qualifiedName
          : typeof symbol.name === "string"
            ? symbol.name
            : "symbol";
      const signature = typeof symbol.signature === "string" ? symbol.signature : null;
      candidates.push({
        kind: "code_symbol",
        sourceId: typeof symbol.id === "string" ? symbol.id : null,
        excerpt: excerptFromContent(signature ? `${qualifiedName}\n${signature}` : qualifiedName),
        priority: 2.5 + entry.finalScore / 12,
        pinned: false,
        reason: "symbol-from-chunk",
        reference: {
          path: entry.chunk.path,
          symbolKind: typeof symbol.kind === "string" ? symbol.kind : "unknown",
        },
      });
    }
  }

  for (const fact of input.facts ?? []) {
    if (!isFactFresh(fact, freshTtl)) continue;
    candidates.push({
      kind: "fact",
      sourceId: fact.id,
      excerpt: excerptFromContent(`${fact.key}=${fact.value}`),
      priority: 3,
      reason: fact.status === "fresh" ? "fresh-fact" : "fact",
      reference: { kind: fact.kind, confidence: fact.confidence },
    });
  }

  for (const memory of input.memoryEntries ?? []) {
    if (!isAcceptedMemory(memory)) continue;
    if (!isRelevantMemory(memory, queryTerms)) continue;
    const redacted = redactSecrets(`${memory.title}\n${memory.body}`);
    if (redacted.redactions.length > 0) {
      redactionNotes.push(`memory:${memory.id} redacted ${redacted.redactions.length} secret(s)`);
    }
    candidates.push({
      kind: "memory_entry",
      sourceId: memory.id,
      excerpt: excerptFromContent(redacted.text),
      priority: 4,
      pinned: memory.pinned === true,
      reason: memory.pinned ? "pinned-memory" : "memory",
      reference: { useCount: memory.useCount, lastUsedAt: memory.lastUsedAt },
    });
  }

  for (const skill of input.skills ?? []) {
    if (skill.status !== "active") continue;
    candidates.push({
      kind: "skill",
      sourceId: skill.id,
      excerpt: excerptFromContent(`${skill.title}\n${skill.steps.join("\n")}`),
      priority: 5,
      reason: "active-skill",
      reference: { triggerTerms: skill.triggerTerms },
    });
  }

  for (const failure of input.checkFailures ?? []) {
    candidates.push({
      kind: "check_failure",
      sourceId: failure.name,
      excerpt: excerptFromContent(`${failure.name}\n${failure.output}`),
      priority: 6,
      reason: "check-failure",
    });
  }

  if (input.gitState) {
    candidates.push({
      kind: "git_state",
      sourceId: null,
      excerpt: excerptFromContent(
        `branch=${input.gitState.branch} dirty=${input.gitState.dirty ? "true" : "false"} recent=${input.gitState.recentFiles.join(",")}`
      ),
      priority: 7,
      reason: "git-state",
    });
  }

  for (const message of (input.previousMessages ?? []).slice(-6)) {
    if (message.role === "system") continue;
    candidates.push({
      kind: "previous_message",
      sourceId: message.id,
      excerpt: excerptFromContent(`${message.role}: ${message.content}`),
      priority: 8,
      reason: "previous-message",
    });
  }

  for (const summary of input.previousSessionSummaries ?? []) {
    candidates.push({
      kind: "previous_session",
      sourceId: summary.id,
      excerpt: excerptFromContent(summary.summary, 320),
      priority: 9,
      reason: "previous-session",
      reference: { ts: summary.ts },
    });
  }

  candidates.sort((left, right) => {
    if (left.pinned === true && right.pinned !== true) return -1;
    if (right.pinned === true && left.pinned !== true) return 1;
    if (left.priority !== right.priority) return left.priority - right.priority;
    return 0;
  });

  const { kept, omitted } = dedupeCandidates(candidates);
  const items: ContextPackItemRecord[] = [];
  const budgetEvents: ContextBudgetEventRecord[] = [];
  let usedTokens = 0;
  const budgetTokens = Math.max(64, input.budgetTokens);

  let rank = 0;
  for (const candidate of kept) {
    const tokenCount = estimateTokens(candidate.excerpt);
    const fits = usedTokens + tokenCount <= budgetTokens;
    items.push({
      id: `cpi_${rank}_${candidate.kind}`,
      contextPackId: "",
      kind: candidate.kind,
      sourceId: candidate.sourceId,
      rank,
      tokenCount,
      excerpt: candidate.excerpt,
      included: fits,
      omissionReason: fits ? null : "budget-exceeded",
      createdAt: new Date().toISOString(),
    });
    if (fits) {
      usedTokens += tokenCount;
      budgetEvents.push({
        id: `cbe_inc_${rank}`,
        contextPackId: "",
        deltaTokens: tokenCount,
        reason: candidate.reason ?? "included",
        createdAt: new Date().toISOString(),
      });
    } else {
      budgetEvents.push({
        id: `cbe_omit_${rank}`,
        contextPackId: "",
        deltaTokens: 0,
        reason: "budget-exceeded",
        createdAt: new Date().toISOString(),
      });
    }
    rank += 1;
  }

  for (const dup of omitted) {
    items.push({
      id: `cpi_dup_${items.length}`,
      contextPackId: "",
      kind: dup.candidate.kind,
      sourceId: dup.candidate.sourceId,
      rank: items.length,
      tokenCount: estimateTokens(dup.candidate.excerpt),
      excerpt: dup.candidate.excerpt,
      included: false,
      omissionReason: `dedupe:${dup.reason}`,
      createdAt: new Date().toISOString(),
    });
  }

  if (usedTokens < budgetTokens * 0.5 && input.ranked.length > 0) {
    budgetEvents.push({
      id: "cbe_under",
      contextPackId: "",
      deltaTokens: budgetTokens - usedTokens,
      reason: "headroom",
      createdAt: new Date().toISOString(),
    });
  }

  const pack: ContextPackRecord = {
    id: `cp_${input.sessionId ?? "anon"}_${Date.now()}`,
    sessionId: input.sessionId ?? null,
    taskId: input.taskId ?? null,
    projectId: input.projectId ?? null,
    retrievalQueryId: input.retrievalQueryId ?? null,
    budgetTokens,
    usedTokens,
    reason: redactionNotes.length > 0 ? `redactions=${redactionNotes.length}` : null,
    createdAt: new Date().toISOString(),
  };

  return { pack, items, budgetEvents, redactionNotes };
}

export function renderContextForPrompt(input: BuildContextPackOutput): string {
  const lines: string[] = [];
  const grouped = new Map<ContextPackItemKind, ContextPackItemRecord[]>();
  for (const item of input.items) {
    if (!item.included) continue;
    const list = grouped.get(item.kind) ?? [];
    list.push(item);
    grouped.set(item.kind, list);
  }
  for (const [kind, list] of grouped) {
    lines.push(`## ${kind}`);
    for (const item of list) {
      lines.push(`- [rank=${item.rank}] ${item.excerpt}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

export type ContextPackItem = ContextPackItemRecord;
