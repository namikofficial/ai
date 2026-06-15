import type { SessionTimelineResponse, TimelineItem } from "../../../packages/shared/src/index.ts";

export const EMPTY_SESSION_TIMELINE_COUNTS: SessionTimelineResponse["counts"] = {
  messages: 0,
  events: 0,
  agentRuns: 0,
  modelCalls: 0,
  compiledPrompts: 0,
  retrievalQueries: 0,
  contextPacks: 0,
  outcomes: 0,
};

function computeTimelineLink(item: TimelineItem): string | undefined {
  const refs = item.refs ?? {};
  switch (item.kind) {
    case "compiled_prompt":
      return refs.promptId ? `/prompts/${refs.promptId}` : undefined;
    case "retrieval_query":
      return refs.queryId ? `/retrieval/queries/${refs.queryId}` : undefined;
    case "model_call":
      return undefined;
    case "context_pack":
      return undefined;
    case "agent_run":
      return refs.runId ? `/agents/runs/${refs.runId}` : undefined;
    case "eval":
      return undefined;
    default:
      return undefined;
  }
}

export function getTimelineItems(timeline: SessionTimelineResponse | null | undefined): TimelineItem[] {
  const raw: TimelineItem[] =
    Array.isArray(timeline?.timeline) && timeline.timeline.length > 0
      ? [...timeline.timeline]
      : Array.isArray(timeline?.items)
        ? [...timeline.items]
        : [];
  return raw.map((item) => ({
    ...item,
    link: item.link ?? computeTimelineLink(item),
  }));
}

export function getTimelineCounts(
  timeline: SessionTimelineResponse | null | undefined
): SessionTimelineResponse["counts"] {
  return timeline?.counts ? { ...timeline.counts } : { ...EMPTY_SESSION_TIMELINE_COUNTS };
}
