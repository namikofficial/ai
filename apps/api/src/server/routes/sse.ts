import type { Router } from "express";

export function registerSseRoutes(router: Router, deps: {
  listEvents: () => unknown[];
  listeners: Set<{ write(chunk: string): void }>;
}) {
  router.get("/events/stream", (req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    for (const event of deps.listEvents()) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    deps.listeners.add(res);
    req.on("close", () => {
      deps.listeners.delete(res);
    });
  });
}
