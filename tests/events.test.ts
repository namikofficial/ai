import assert from "node:assert/strict";
import test from "node:test";
import { workbenchEventSchema } from "../packages/contracts/src/index.ts";
import { createEvent, parseEventEnvelope } from "../packages/shared/src/index.ts";

test("serializes event envelopes without losing data", () => {
  const event = createEvent("session.completed", { summary: "done" }, { sessionId: "sess_1" });
  const json = JSON.stringify(event);
  const parsed = parseEventEnvelope(JSON.parse(json));

  assert.equal(parsed.type, "session.completed");
  assert.equal(parsed.payload.summary, "done");
  assert.equal(parsed.sessionId, "sess_1");
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.summary, "done");
  assert.equal(parsed.severity, "info");
  assert.equal(parsed.correlationId, "sess_1");
  assert.equal(workbenchEventSchema.parse(parsed).id, parsed.id);
});

test("legacy event envelopes are upgraded to the normalized event contract", () => {
  const parsed = parseEventEnvelope({
    id: "evt_legacy",
    type: "check.failed",
    sessionId: "sess_1",
    taskId: null,
    projectId: "proj_1",
    agent: "checks",
    level: "warn",
    ts: "2026-01-01T00:00:00.000Z",
    payload: { message: "Typecheck failed" },
  });

  assert.equal(parsed.origin.legacyRef, "evt_legacy");
  assert.equal(parsed.severity, "warning");
  assert.equal(parsed.summary, "Typecheck failed");
  assert.equal(parsed.sourceService, "checks");
  assert.equal(workbenchEventSchema.parse(parsed).type, "check.failed");
});
