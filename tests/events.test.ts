import assert from "node:assert/strict";
import test from "node:test";
import { createEvent, parseEventEnvelope } from "../packages/shared/src/index.ts";

test("serializes event envelopes without losing data", () => {
  const event = createEvent("session.completed", { summary: "done" }, { sessionId: "sess_1" });
  const json = JSON.stringify(event);
  const parsed = parseEventEnvelope(JSON.parse(json));

  assert.equal(parsed.type, "session.completed");
  assert.equal(parsed.payload.summary, "done");
  assert.equal(parsed.sessionId, "sess_1");
});
