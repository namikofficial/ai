import type { ProjectSummary, RetrievalChunk } from "../../shared/src/index.ts";

export interface ModelRouteDetails {
  risk?: "low" | "medium" | "high";
  depth?: "shallow" | "standard" | "deep";
  question?: string;
  goal?: string;
}

export function selectModelProfile(
  mode: "local" | "cloud" | "hybrid" | "ask" | "any" | "index" | "plan" | "handoff" | "check" | "reflect",
  details: ModelRouteDetails = {},
): string {
  if (mode === "cloud") {
    return "ask-cloud-router";
  }
  if (mode === "hybrid") {
    return "ask-hybrid-router";
  }
  if (mode === "index") {
    return "indexer-local";
  }
  if (mode === "plan") {
    if (details.risk === "high" || details.depth === "deep") return "planner-deep-local";
    if (details.risk === "medium") return "planner-balanced-local";
    return "planner-fast-local";
  }
  if (mode === "handoff") {
    return "handoff-local";
  }
  if (mode === "check") {
    return "checker-local";
  }
  if (mode === "reflect") {
    return "reflector-local";
  }
  if (details.depth === "deep") return "ask-deep-local";
  if (details.question && details.question.length > 120) return "ask-extended-local";
  return "ask-fast-local";
}

export function buildAnswer(
  question: string,
  project: ProjectSummary,
  chunks: RetrievalChunk[],
  citations: Array<{ path: string; startLine: number; endLine: number; score: number }>,
  confidence: number,
): string {
  const bullets = chunks.slice(0, 3).map((chunk, index) => {
    const excerpt = chunk.content.split("\n").slice(0, 3).join(" ");
    return `${index + 1}. ${chunk.path}:${chunk.startLine}-${chunk.endLine} ${excerpt.slice(0, 160)}`;
  });
  return [
    `I found the most relevant local context in ${project.name} for "${question}".`,
    `Confidence: ${Math.round(confidence * 100)}%.`,
    "",
    ...bullets,
    "",
    "Citations:",
    ...citations.slice(0, 3).map((citation) => `- ${citation.path}:${citation.startLine}-${citation.endLine}`),
  ].join("\n");
}
