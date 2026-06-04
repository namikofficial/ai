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

export function getTimelineItems(timeline: SessionTimelineResponse | null | undefined): TimelineItem[] {
  if (Array.isArray(timeline?.timeline)) {
    return [...timeline.timeline] as TimelineItem[];
  }
  if (Array.isArray(timeline?.items)) {
    return [...timeline.items] as TimelineItem[];
  }
  return [];
}

export function getTimelineCounts(timeline: SessionTimelineResponse | null | undefined): SessionTimelineResponse["counts"] {
  return timeline?.counts ? { ...timeline.counts } : { ...EMPTY_SESSION_TIMELINE_COUNTS };
}
