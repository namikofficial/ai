import type { Router } from "express";
import type { EventEnvelope } from "../../../../../packages/shared/src/index.ts";

export function registerSseRoutes(
  router: Router,
  deps: {
    listEvents: () => EventEnvelope[];
    listEventsSince: (since: string) => EventEnvelope[];
    listeners: Set<{ write(chunk: string): void }>;
  }
) {
  router.get("/events/stream", (req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");

    const since = req.query.since;
    const events: EventEnvelope[] =
      since && typeof since === "string"
        ? deps.listEventsSince(since)
        : deps.listEvents();

    for (const event of events) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    deps.listeners.add(res);
    req.on("close", () => {
      deps.listeners.delete(res);
    });
  });
}
