import type {
  ConversationMessageRecord,
  FactRecord,
  MemoryEntryRecord,
  ProjectRuleRecord,
  RetrievalChunk,
} from "../../shared/src/index.ts";
import type { ContextPackItem as ContextPackItemRecord } from "../../context-engine/src/index.ts";

export type PromptMode =
  | "answer"
  | "query_rewrite"
  | "retrieval_judge"
  | "planner"
  | "handoff"
  | "reflection"
  | "review"
  | "skill_candidate"
  | "summarizer"
  | "intent";

export interface CompiledPrompt {
  id: string;
  mode: PromptMode;
  role: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  estimatedTokens: number;
  contextPackId?: string;
  includedContext: Array<PromptContextItem>;
  omittedContext: Array<{ item: unknown; reason: string }>;
  safetyNotes: string[];
  outputSchema?: unknown;
}

type PromptMessage = { role: "system" | "user" | "assistant"; content: string };

type PromptRule = string | ProjectRuleRecord | { title: string; body: string; pinned?: boolean };
type PromptMemory = { title: string; body: string } | MemoryEntryRecord;
type PromptFact = { key: string; value: string } | FactRecord;
type PromptContextItem = {
  id?: string;
  contextPackId?: string;
  kind: ContextPackItemRecord["kind"];
  sourceId?: string | null;
  rank?: number;
  tokenCount?: number;
  excerpt: string;
  included?: boolean;
  omissionReason?: string | null;
  createdAt?: string;
};

export type ContextPackItem = PromptContextItem;
export type ContextPackItemForPrompt = PromptContextItem;

export interface CompilePromptInput {
  mode: PromptMode;
  role: string;
  userRequest: string;
  contextPackId?: string;
  globalSystemRules?: string[];
  projectRules?: PromptRule[];
  previousMessages?: Array<PromptMessage | ConversationMessageRecord>;
  acceptedMemory?: PromptMemory[];
  memoryEntries?: PromptMemory[];
  freshFacts?: PromptFact[];
  facts?: PromptFact[];
  retrievalCitations?: Array<{
    path: string;
    startLine: number;
    endLine: number;
    excerpt: string;
  }>;
  retrievalChunks?: Array<RetrievalChunk>;
  selectedContextPack?: Array<PromptContextItem>;
  contextPackItems?: Array<PromptContextItem>;
  taskConstraints?: string[];
  outputSchema?: unknown;
  metadata?: Record<string, unknown>;
  tokenBudget?: number;
}

function estimateTokensFromText(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimatePromptTokens(messages: PromptMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokensFromText(message.content), 0);
}

function normalizeRule(rule: PromptRule): string {
  if (typeof rule === "string") return rule;
  if ("title" in rule && "body" in rule) {
    return `${rule.title}\n${rule.body}`;
  }
  return String(rule);
}

function normalizeMemory(memory: PromptMemory): { title: string; body: string } {
  return { title: memory.title, body: memory.body };
}

function normalizeFact(fact: PromptFact): { key: string; value: string } {
  return { key: fact.key, value: fact.value };
}

function normalizeMessageRole(role: string): PromptMessage["role"] {
  return role === "system" || role === "assistant" || role === "user" ? role : "assistant";
}

export function compilePrompt(input: CompilePromptInput): CompiledPrompt {
  const messages: PromptMessage[] = [];
  const includedContext: PromptContextItem[] = [];
  const omittedContext: Array<{ item: unknown; reason: string }> = [];
  const safetyNotes: string[] = [];
  const selectedContextPack = input.selectedContextPack ?? input.contextPackItems ?? [];

  messages.push({
    role: "system",
    content: "You are a local-first engineering assistant. Follow project rules, preserve safety, and cite provided context.",
  });

  if (input.globalSystemRules?.length) {
    messages.push({ role: "system", content: input.globalSystemRules.join("\n") });
  }

  if (input.projectRules?.length) {
    messages.push({ role: "system", content: `Project Rules:\n${input.projectRules.map(normalizeRule).join("\n")}` });
  }

  messages.push({ role: "user", content: input.userRequest });

  if (input.previousMessages?.length) {
    messages.push(
      ...input.previousMessages.map((message) => ({
        role: normalizeMessageRole(message.role),
        content: message.content,
      })),
    );
  }

  const acceptedMemory = input.acceptedMemory ?? input.memoryEntries ?? [];
  if (acceptedMemory.length) {
    const memoryContent = acceptedMemory.map((memory) => {
      const normalized = normalizeMemory(memory);
      return `Title: ${normalized.title}\nBody: ${normalized.body}`;
    }).join("\n\n");
    messages.push({ role: "system", content: `Accepted Memory:\n${memoryContent}` });
  }

  const freshFacts = input.freshFacts ?? input.facts ?? [];
  if (freshFacts.length) {
    const factsContent = freshFacts.map((fact) => {
      const normalized = normalizeFact(fact);
      return `${normalized.key}: ${normalized.value}`;
    }).join("\n");
    messages.push({ role: "system", content: `Fresh Facts:\n${factsContent}` });
  }

  if (input.retrievalCitations?.length) {
    const citationsContent = input.retrievalCitations
      .map((citation) => `- ${citation.path}:${citation.startLine}-${citation.endLine}\n\`\`\`\n${citation.excerpt}\n\`\`\``)
      .join("\n\n");
    messages.push({ role: "system", content: `Retrieval Citations:\n${citationsContent}` });
  }

  if (input.retrievalChunks?.length) {
    const chunkContent = input.retrievalChunks
      .map((chunk) => `- ${chunk.path}:${chunk.startLine}-${chunk.endLine}\n\`\`\`\n${chunk.content}\n\`\`\``)
      .join("\n\n");
    messages.push({ role: "system", content: `Retrieval Chunks:\n${chunkContent}` });
    includedContext.push(
      ...input.retrievalChunks.map((chunk, index) => ({
        id: `pc_${input.mode}_${index}`,
        contextPackId: input.contextPackId ?? "",
        kind: "retrieval_chunk" as const,
        sourceId: chunk.id,
        rank: index,
        tokenCount: estimateTokensFromText(chunk.content),
        excerpt: chunk.content,
        included: true,
        omissionReason: null,
        createdAt: new Date().toISOString(),
      })),
    );
  }

  if (selectedContextPack.length > 0) {
    const contextContent = selectedContextPack
      .map((item) => `Kind: ${item.kind}\nExcerpt:\n\`\`\`\n${item.excerpt}\n\`\`\``)
      .join("\n\n");
    messages.push({ role: "system", content: `Selected Context Pack:\n${contextContent}` });
    includedContext.push(...selectedContextPack);
  }

  if (input.taskConstraints?.length) {
    messages.push({ role: "system", content: `Task Constraints:\n${input.taskConstraints.join("\n")}` });
  }

  if (input.outputSchema) {
    messages.push({ role: "system", content: `Output Schema:\n\`\`\`json\n${JSON.stringify(input.outputSchema, null, 2)}\n\`\`\`` });
  }

  const estimatedTokens = estimatePromptTokens(messages);

  return {
    id: `prompt_${input.mode}_${input.role}_${Date.now()}`,
    mode: input.mode,
    role: input.role,
    messages,
    estimatedTokens,
    contextPackId: input.contextPackId,
    includedContext,
    omittedContext,
    safetyNotes,
    outputSchema: input.outputSchema,
  };
}

export function buildAnswerFromCompiledPrompt(
  compiled: CompiledPrompt,
  answerText: string,
  citations: Array<{ path: string; startLine: number; endLine: number; score?: number }>,
  confidence: number,
): string {
  const citationLines = citations.length > 0
    ? citations.map((citation) => `- ${citation.path}:${citation.startLine}-${citation.endLine}`).join("\n")
    : "none";
  return [
    answerText.trim(),
    "",
    `Confidence: ${Math.round(confidence * 100)}%`,
    `Prompt: ${compiled.id}`,
    `Citations:\n${citationLines}`,
  ].join("\n");
}
