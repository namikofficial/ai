import assert from "node:assert/strict";
import test from "node:test";
import {
  createEvent,
  parseAskRequest,
  parseEventEnvelope,
  parseProjectCreateInput,
  slugifyName,
} from "../packages/shared/src/index.ts";

test("parses project creation input", () => {
  const input = parseProjectCreateInput({
    path: "~/Documents/code/noxcrm",
    name: "Nox CRM",
    repoUrl: null,
  });

  assert.equal(input.path, "~/Documents/code/noxcrm");
  assert.equal(input.name, "Nox CRM");
  assert.equal(input.repoUrl, null);
});

test("parses ask input", () => {
  const input = parseAskRequest({
    project: "noxcrm",
    question: "where is auth handled?",
    mode: "local",
    depth: "deep",
  });

  assert.equal(input.project, "noxcrm");
  assert.equal(input.question, "where is auth handled?");
  assert.equal(input.mode, "local");
  assert.equal(input.depth, "deep");
});

test("creates and parses an event envelope", () => {
  const event = createEvent("task.started", { message: "started" }, { sessionId: "sess_1", projectId: "proj_1" });
  const parsed = parseEventEnvelope(event);

  assert.equal(parsed.type, "task.started");
  assert.equal(parsed.sessionId, "sess_1");
  assert.equal(parsed.projectId, "proj_1");
  assert.equal(parsed.payload.message, "started");
});

test("slugifies project names", () => {
  assert.equal(slugifyName("Nox CRM!"), "nox-crm");
});
