import type {
  ConversationMessageRecord,
  FactRecord,
  MemoryEntryRecord,
  ProjectRuleRecord,
  RetrievalChunk,
} from "../../shared/src/index.ts";
import type { CompilePromptInput, ContextPackItemForPrompt } from "../../prompt-compiler/src/index.ts";
import type { RankedChunk } from "../../retrieval-engine/src/index.ts";

export interface BuildAskQueryRewritePromptInput {
  question: string;
  retrievalQueryId: string;
  intent: string;
  mode: string;
  analysis: unknown;
}

export function buildAskQueryRewritePrompt(input: BuildAskQueryRewritePromptInput): CompilePromptInput {
  return {
    mode: "query_rewrite",
    role: "query_rewrite",
    userRequest: input.question,
    taskConstraints: [
      `Intent: ${input.intent}`,
      `Mode: ${input.mode}`,
      "Return retrieval rewrites, path hints, and symbol hints only.",
    ],
    outputSchema: {
      type: "object",
      properties: {
        rewrites: { type: "array", items: { type: "string" } },
        pathHints: { type: "array", items: { type: "string" } },
        symbolHints: { type: "array", items: { type: "string" } },
      },
      required: ["rewrites", "pathHints", "symbolHints"],
    },
    metadata: { retrievalQueryId: input.retrievalQueryId, analysis: input.analysis },
  };
}

export interface BuildAskRetrievalJudgePromptInput {
  question: string;
  retrievalQueryId: string;
  contextPackId: string;
  rewrittenQuery: string;
  mode: string;
  depth: string;
  retrievalChunks: RetrievalChunk[];
  rankedCount: number;
  selectedCount: number;
  droppedCount: number;
}

export function buildAskRetrievalJudgePrompt(input: BuildAskRetrievalJudgePromptInput): CompilePromptInput {
  return {
    mode: "retrieval_judge",
    role: "retrieval_judge",
    contextPackId: input.contextPackId,
    userRequest: input.question,
    retrievalChunks: input.retrievalChunks,
    taskConstraints: [
      `Rewritten query: ${input.rewrittenQuery}`,
      `Ranked: ${input.rankedCount}`,
      `Selected: ${input.selectedCount}`,
      `Dropped: ${input.droppedCount}`,
      `Mode: ${input.mode}`,
      `Depth: ${input.depth}`,
    ],
    outputSchema: {
      type: "object",
      properties: {
        confidence: { type: "number" },
        confidenceNotes: { type: "array", items: { type: "string" } },
        miss: { type: ["object", "null"] },
      },
      required: ["confidence", "confidenceNotes"],
    },
    metadata: { retrievalQueryId: input.retrievalQueryId, contextPackId: input.contextPackId },
  };
}

export interface BuildAskAnswerPromptInput {
  question: string;
  projectName: string;
  contextPackId: string;
  confidence: number;
  insufficientReason: string | null;
  projectRules: ProjectRuleRecord[];
  memoryEntries: MemoryEntryRecord[];
  facts: FactRecord[];
  retrievalChunks: RetrievalChunk[];
  contextPackItems: ContextPackItemForPrompt[];
  previousMessages: ConversationMessageRecord[];
  sessionId: string;
  retrievalQueryId: string;
  tokenBudget?: number;
}

export function buildAskAnswerPrompt(input: BuildAskAnswerPromptInput): CompilePromptInput {
  return {
    mode: "answer",
    role: "answer",
    contextPackId: input.contextPackId,
    userRequest: input.question,
    projectRules: input.projectRules,
    memoryEntries: input.memoryEntries,
    facts: input.facts,
    retrievalChunks: input.retrievalChunks,
    contextPackItems: input.contextPackItems,
    previousMessages: input.previousMessages,
    taskConstraints: [
      `Project: ${input.projectName}`,
      `Confidence before synthesis: ${Math.round(input.confidence * 100)}%`,
      input.insufficientReason ?? "Answer only from provided context and cite paths.",
    ],
    outputSchema: {
      type: "object",
      properties: {
        answer: { type: "string" },
        citations: { type: "array" },
        confidence: { type: "number" },
      },
      required: ["answer", "citations", "confidence"],
    },
    metadata: {
      sessionId: input.sessionId,
      retrievalQueryId: input.retrievalQueryId,
      contextPackId: input.contextPackId,
    },
    tokenBudget: input.tokenBudget ?? 4096,
  };
}

export function buildAskCitations(selected: RankedChunk[]): Array<{
  chunkId: string;
  path: string;
  startLine: number;
  endLine: number;
  excerpt: string;
  score: number;
}> {
  return selected.map((entry) => ({
    chunkId: entry.chunk.id,
    path: entry.chunk.path,
    startLine: entry.chunk.startLine,
    endLine: entry.chunk.endLine,
    excerpt: entry.chunk.content.split("\n").slice(0, 4).join("\n"),
    score: entry.finalScore,
  }));
}

export function buildAskFallbackAnswer(projectName: string, question: string): string {
  return `I could not find enough local context in ${projectName} to answer "${question}".`;
}

export function buildAskSynthesisFailure(question: string): string {
  return `I could not synthesize a model answer for "${question}" from the selected context.`;
}
