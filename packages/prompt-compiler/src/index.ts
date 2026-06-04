import type {
  ContextPackItemKind,
  ConversationMessageRecord,
  FactRecord,
  MemoryEntryRecord,
  ModelRole,
  ProjectRuleRecord,
  RetrievalChunk,
} from "../../shared/src/index.ts";
import { redactSecrets } from "../../safety/src/index.ts";

export type PromptMode =
  | "answer"
  | "query_rewrite"
  | "planner"
  | "handoff"
  | "reflection"
  | "review"
  | "skill_candidate"
  | "summarizer"
  | "intent";

export interface ContextPackItemForPrompt {
  kind: ContextPackItemKind;
  rank: number;
  tokenCount: number;
  excerpt: string;
  path?: string | null;
  startLine?: number | null;
  endLine?: number | null;
  sourceId?: string | null;
}

export interface CompiledPromptMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompiledPromptOmittedItem {
  kind: ContextPackItemKind;
  rank: number;
  tokenCount: number;
  reason: string;
}

export interface CompiledPrompt {
  id: string;
  mode: PromptMode;
  role: ModelRole;
  messages: CompiledPromptMessage[];
  estimatedTokens: number;
  contextPackId?: string | null;
  includedContext: ContextPackItemForPrompt[];
  omittedContext: CompiledPromptOmittedItem[];
  safetyNotes: string[];
  outputSchema?: Record<string, unknown> | null;
}

export interface CompilePromptInput {
  mode: PromptMode;
  role: ModelRole;
  contextPackId?: string | null;
  userRequest: string;
  systemRules?: string[];
  projectRules?: ProjectRuleRecord[];
  previousMessages?: ConversationMessageRecord[];
  memoryEntries?: MemoryEntryRecord[];
  facts?: FactRecord[];
  retrievalChunks?: RetrievalChunk[];
  contextPackItems?: ContextPackItemForPrompt[];
  taskConstraints?: string[];
  outputSchema?: Record<string, unknown> | null;
  tokenBudget?: number;
  metadata?: Record<string, unknown>;
}

const DEFAULT_TOKEN_BUDGET = 4096;
const APPROX_TOKENS_PER_CHAR = 0.25;

function estimateTokens(text: string): number {
  if (!text || text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length * APPROX_TOKENS_PER_CHAR));
}

function trimToBudget(text: string, tokenBudget: number): string {
  const charBudget = Math.floor(tokenBudget / APPROX_TOKENS_PER_CHAR);
  if (text.length <= charBudget) return text;
  return text.slice(0, charBudget) + "\n…[truncated]";
}

function joinNonEmpty(lines: Array<string | null | undefined>): string {
  return lines.filter((line): line is string => typeof line === "string" && line.trim().length > 0).join("\n");
}

function defaultSystemRules(mode: PromptMode): string[] {
  const base = [
    "You are part of the AI Workbench, a local-first engineering assistant.",
    "Cite file paths and line numbers when you reference repository content.",
    "Never invent paths, identifiers, dependencies, or commands.",
    "If the provided context is insufficient, say so explicitly and stop.",
    "Never execute or suggest destructive shell commands.",
  ];
  switch (mode) {
    case "answer":
      return [...base, "Produce a grounded answer using only the supplied context."];
    case "query_rewrite":
      return [
        "You rewrite developer questions for hybrid retrieval.",
        "Emit short, term-rich variants and useful path/symbol hints.",
      ];
    case "planner":
      return [...base, "Produce a focused task graph with clear acceptance checks."];
    case "handoff":
      return [
        ...base,
        "You compile a handoff prompt for an external coding agent.",
        "Include exact files to inspect, files likely to edit, allowed checks, and stop conditions.",
      ];
    case "reflection":
      return [
        ...base,
        "You reflect on a finished session to propose memory, skill, and fact candidates.",
        "Cite the session id, retrieval query ids, or context pack ids in evidence.",
      ];
    case "review":
      return [...base, "You review planned vs edited changes and flag scope creep or missing checks."];
    case "skill_candidate":
      return [
        ...base,
        "You evaluate whether a repeated successful workflow should become a reusable skill.",
      ];
    case "summarizer":
      return [...base, "Produce a tight, neutral summary."];
    case "intent":
      return [
        "You classify a developer query into one of: lookup, explain, debug, plan, review, summary.",
        "Reply with a single label and a brief one-line justification.",
      ];
    default:
      return base;
  }
}

function formatRule(rule: ProjectRuleRecord): string {
  return `- ${rule.pinned ? "[pinned] " : ""}${rule.title}: ${rule.body}`;
}

function formatMemoryEntry(entry: MemoryEntryRecord): string {
  return `- (${entry.kind}, confidence=${entry.confidence.toFixed(2)}) ${entry.title}: ${entry.body}`;
}

function formatFact(fact: FactRecord): string {
  return `- ${fact.key} = ${fact.value} (${fact.kind}, confidence=${fact.confidence.toFixed(2)}, status=${fact.status})`;
}

function formatChunk(chunk: RetrievalChunk): string {
  const head = `[${chunk.path}:${chunk.startLine}-${chunk.endLine}] score=${chunk.score.toFixed(2)}`;
  const body = chunk.content.split("\n").slice(0, 30).join("\n");
  return `${head}\n${body}`;
}

function formatContextItem(item: ContextPackItemForPrompt): string {
  const head = item.path
    ? `[${item.kind} ${item.path}${item.startLine != null && item.endLine != null ? `:${item.startLine}-${item.endLine}` : ""}]`
    : `[${item.kind}]`;
  return `${head}\n${item.excerpt}`;
}

function formatPreviousMessage(message: ConversationMessageRecord): string {
  const head = `(${message.role}${message.agent ? `:${message.agent}` : ""})`;
  return `${head} ${message.content}`;
}

export function compilePrompt(input: CompilePromptInput): CompiledPrompt {
  const id = `prompt_${globalThis.crypto.randomUUID()}`;
  const tokenBudget = input.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const systemLines = [...defaultSystemRules(input.mode), ...(input.systemRules ?? [])];
  const safetyNotes: string[] = [];
  const includedContext: ContextPackItemForPrompt[] = [];
  const omittedContext: CompiledPromptOmittedItem[] = [];

  const projectRulesText = (input.projectRules ?? []).map(formatRule).join("\n");
  const taskConstraintsText = (input.taskConstraints ?? []).map((c) => `- ${c}`).join("\n");
  const memoryText = (input.memoryEntries ?? []).map(formatMemoryEntry).join("\n");
  const factsText = (input.facts ?? [])
    .filter((fact) => fact.status === "fresh")
    .map(formatFact)
    .join("\n");
  const previousText = (input.previousMessages ?? [])
    .slice(-8)
    .map(formatPreviousMessage)
    .join("\n\n");

  let remaining = tokenBudget;
  const seenExcerpts = new Set<string>();

  const items: ContextPackItemForPrompt[] = (input.contextPackItems ?? []).slice();
  for (const chunk of input.retrievalChunks ?? []) {
    items.push({
      kind: "retrieval_chunk",
      rank: items.length,
      tokenCount: chunk.tokenCount,
      excerpt: formatChunk(chunk),
      path: chunk.path,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      sourceId: chunk.id,
    });
  }

  for (const item of items.sort((a, b) => a.rank - b.rank)) {
    const key = `${item.kind}:${item.path ?? ""}:${item.excerpt.slice(0, 80)}`;
    if (seenExcerpts.has(key)) {
      omittedContext.push({ kind: item.kind, rank: item.rank, tokenCount: item.tokenCount, reason: "duplicate excerpt" });
      continue;
    }
    if (item.tokenCount > remaining) {
      omittedContext.push({ kind: item.kind, rank: item.rank, tokenCount: item.tokenCount, reason: "token budget exhausted" });
      continue;
    }
    includedContext.push(item);
    seenExcerpts.add(key);
    remaining -= item.tokenCount;
  }

  const contextBlocks = includedContext.map(formatContextItem).join("\n\n");
  const redactedUserRequest = redactSecrets(input.userRequest);
  if (redactedUserRequest.redactions.length > 0) {
    safetyNotes.push(`Redacted ${redactedUserRequest.redactions.length} secret pattern(s) from user request.`);
  }
  const redactedContext = contextBlocks ? redactSecrets(contextBlocks) : { text: contextBlocks, redactions: [] };
  if (redactedContext.redactions.length > 0) {
    safetyNotes.push(`Redacted ${redactedContext.redactions.length} secret pattern(s) from context blocks.`);
  }

  const messages: CompiledPromptMessage[] = [];
  messages.push({ role: "system", content: systemLines.join("\n") });

  const projectBlock = joinNonEmpty([
    projectRulesText ? `# Project rules\n${projectRulesText}` : null,
    memoryText ? `# Accepted memory\n${memoryText}` : null,
    factsText ? `# Fresh facts\n${factsText}` : null,
    taskConstraintsText ? `# Task constraints\n${taskConstraintsText}` : null,
  ]);
  if (projectBlock) {
    messages.push({ role: "system", content: trimToBudget(projectBlock, Math.max(256, Math.floor(tokenBudget * 0.2))) });
  }

  if (previousText) {
    messages.push({
      role: "system",
      content: `# Previous messages (recent first window)\n${trimToBudget(previousText, Math.max(256, Math.floor(tokenBudget * 0.2)))}`,
    });
  }

  if (redactedContext.text) {
    messages.push({
      role: "user",
      content: `# Selected context\n${trimToBudget(redactedContext.text, Math.max(512, Math.floor(tokenBudget * 0.5)))}`,
    });
  }

  messages.push({
    role: "user",
    content: redactedUserRequest.text,
  });

  if (input.outputSchema) {
    messages.push({
      role: "system",
      content: `Respond with JSON matching this schema:\n${JSON.stringify(input.outputSchema, null, 2)}`,
    });
  }

  const estimatedTokens = messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);

  return {
    id,
    mode: input.mode,
    role: input.role,
    messages,
    estimatedTokens,
    contextPackId: input.contextPackId ?? null,
    includedContext,
    omittedContext,
    safetyNotes,
    outputSchema: input.outputSchema ?? null,
  };
}

export function estimatePromptTokens(messages: CompiledPromptMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
}

export function buildAnswerFromCompiledPrompt(
  prompt: CompiledPrompt,
  modelText: string,
  citations: Array<{ path: string; startLine: number; endLine: number; score: number }>,
  confidence: number,
): string {
  const trimmed = modelText.trim();
  const citationLines = citations
    .slice(0, 5)
    .map((citation) => `- ${citation.path}:${citation.startLine}-${citation.endLine}`)
    .join("\n");
  const safety = prompt.safetyNotes.length > 0 ? `\nNotes: ${prompt.safetyNotes.join("; ")}` : "";
  const body = trimmed || "(model returned an empty response)";
  return [
    body,
    "",
    `Confidence: ${Math.round(confidence * 100)}%.`,
    citationLines ? `Citations:\n${citationLines}` : "Citations: none",
    safety ? safety.trim() : null,
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}
