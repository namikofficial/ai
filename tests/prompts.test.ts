import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeStore, createStore } from "../packages/db/src/store.ts";

test("compiled prompt repo records, fetches, and lists prompts by session", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-prompts-"));
  const store = createStore(initializeStore(join(workspace, "ai.db")));
  try {
    const session = store.createSession({
      projectId: null,
      title: "prompt session",
      userGoal: "record compiled prompts",
      mode: "local",
      source: "test",
    });

    const first = store.recordCompiledPrompt({
      compiledPrompt: {
        id: "pp_first",
        mode: "answer",
        role: "answer",
        messages: [{ role: "system", content: "sys" }],
        estimatedTokens: 8,
        includedContext: [],
        omittedContext: [],
        safetyNotes: [],
      },
      sessionId: session.id,
      retrievalQueryId: "rq_1",
      createdAt: "2024-01-01T00:00:00.000Z",
    });
    const second = store.recordCompiledPrompt({
      compiledPrompt: {
        id: "pp_second",
        mode: "retrieval_judge",
        role: "retrieval_judge",
        messages: [{ role: "user", content: "query" }],
        estimatedTokens: 4,
        includedContext: [],
        omittedContext: [],
        safetyNotes: [],
      },
      sessionId: session.id,
      retrievalQueryId: "rq_2",
      createdAt: "2024-01-01T00:00:01.000Z",
    });

    assert.equal(first.id, "pp_first");
    assert.equal(second.id, "pp_second");

    const byId = store.getCompiledPrompt("pp_first");
    assert.equal(byId?.id, "pp_first");
    assert.equal(byId?.sessionId, session.id);
    assert.equal(byId?.mode, "answer");

    const bySession = store.listCompiledPrompts(session.id, 10);
    assert.deepEqual(
      bySession.map((prompt) => prompt.id).sort(),
      ["pp_first", "pp_second"],
    );
  } finally {
    store.db.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
