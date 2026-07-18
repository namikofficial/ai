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
    res.write("retry: 2000\n: connected\n\n");

    const since = req.query.since ?? req.headers["last-event-id"];
    const events: EventEnvelope[] =
      since && typeof since === "string" ? deps.listEventsSince(since) : deps.listEvents();

    for (const event of events) {
      res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    deps.listeners.add(res);
    const heartbeat = setInterval(() => {
      try {
        res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
      } catch {
        clearInterval(heartbeat);
        deps.listeners.delete(res);
      }
    }, 15_000);
    heartbeat.unref();
    req.on("close", () => {
      clearInterval(heartbeat);
      deps.listeners.delete(res);
    });
  });
}
