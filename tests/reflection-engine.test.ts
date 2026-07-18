import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSkillCandidateRecord,
  detectContradictions,
  type FactProposal,
  reflect,
} from "../packages/reflection-engine/src/index.ts";
import type { FactRecord } from "../packages/shared/src/index.ts";

const baseSession = {
  id: "sess_1",
  projectId: "p1",
  title: "Test session",
  userGoal: "Investigate auth flow",
  mode: "local" as const,
  status: "completed" as const,
  source: "cli",
  startedAt: "2024-01-01T00:00:00Z",
  finishedAt: "2024-01-01T00:05:00Z",
  durationMs: 300000,
  activeTaskId: null,
  modelProfile: "ask-fast-local",
  finalSummary: "Auth is in src/auth.ts",
  errorMessage: null,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:05:00Z",
};

test("reflection-engine: emits memory candidate from user preference and a successful outcome", () => {
  const output = reflect({
    session: baseSession,
    conversation: [
      {
        id: "m1",
        sessionId: "sess_1",
        projectId: "p1",
        role: "user",
        agent: null,
        content: "I prefer TypeScript strict mode for all files",
        contentHash: "h1",
        metaJson: "{}",
        tokenCount: 10,
        parentMessageId: null,
        ts: "2024-01-01T00:00:00Z",
        createdAt: "2024-01-01T00:00:00Z",
      },
    ],
    retrievals: [],
    retrievalResults: new Map(),
    retrievalSelectedContext: new Map(),
    retrievalFeedback: [],
    retrievalMisses: [],
    contextPacks: [],
    agentRuns: [],
    modelCalls: [],
    checks: [],
    reviews: [],
    answerEvaluations: [],
    outcome: {
      id: "out_1",
      sessionId: "sess_1",
      outcome: "success",
      score: 0.9,
      notes: "all good",
      createdAt: "2024-01-01T00:05:00Z",
    },
    existingFacts: [],
    existingRules: [],
    existingSkills: [],
  });
  assert.ok(output.memoryCandidates.some((c) => c.kind === "user_preference"));
  assert.ok(output.memoryCandidates.some((c) => c.kind === "workflow_lesson"));
  for (const candidate of output.memoryCandidates) {
    assert.ok(candidate.evidence.length > 0);
    assert.equal(candidate.evidence[0].kind.length > 0, true);
  }
});

test("reflection-engine: emits stale fact when last_verified_at is older than ttl", () => {
  const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const output = reflect({
    session: baseSession,
    conversation: [],
    retrievals: [],
    retrievalResults: new Map(),
    retrievalSelectedContext: new Map(),
    retrievalFeedback: [],
    retrievalMisses: [],
    contextPacks: [],
    agentRuns: [],
    modelCalls: [],
    checks: [],
    reviews: [],
    answerEvaluations: [],
    outcome: null,
    existingFacts: [
      {
        id: "f1",
        projectId: "p1",
        key: "runtime",
        value: "node22",
        kind: "runtime",
        confidence: 0.9,
        sourceKind: "extraction",
        status: "fresh",
        lastVerifiedAt: old,
        expiresAt: null,
        validAt: null,
        invalidAt: null,
        createdAt: old,
        updatedAt: old,
      },
    ],
    existingRules: [],
    existingSkills: [],
    freshFactTtlDays: 30,
  });
  assert.equal(output.staleFacts.length, 1);
  assert.equal(output.staleFacts[0].factId, "f1");
});

test("reflection-engine: emits skill candidate when a check is repeatedly run", () => {
  const output = reflect({
    session: baseSession,
    conversation: [],
    retrievals: [],
    retrievalResults: new Map(),
    retrievalSelectedContext: new Map(),
    retrievalFeedback: [],
    retrievalMisses: [],
    contextPacks: [],
    agentRuns: [],
    modelCalls: [],
    checks: [
      {
        id: "c1",
        name: "typecheck",
        status: "completed",
        command: "pnpm typecheck",
        output: "ok",
        errorOutput: null,
        exitCode: 0,
        durationMs: 60_000,
        parsedErrors: [],
        affectedFiles: [],
        startedAt: "2024-01-01T00:00:00Z",
        finishedAt: "2024-01-01T00:01:00Z",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:01:00Z",
      },
    ],
    reviews: [],
    answerEvaluations: [],
    outcome: null,
    existingFacts: [],
    existingRules: [],
    existingSkills: [],
  });
  assert.ok(output.skillCandidates.length >= 1);
  assert.equal(output.skillCandidates[0].commands[0], "pnpm typecheck");
});

test("reflection-engine: buildSkillCandidateRecord maps to a skill candidate record", () => {
  const record = buildSkillCandidateRecord(
    {
      title: "Run tests",
      triggerTerms: ["test"],
      steps: ["step 1"],
      requiredContext: ["context"],
      commands: ["pnpm test"],
      safetyNotes: null,
      validation: ["ok"],
      confidence: 0.5,
      sourceKind: "reflection",
      exampleSessionId: "sess_1",
      evidence: [],
    },
    "p1"
  );
  assert.equal(record.status, "pending");
  assert.equal(record.applicableProjects[0], "p1");
});

test("reflection-engine: detectContradictions flags a conflicting currently-valid fact", () => {
  const now = new Date().toISOString();
  const existing: FactRecord[] = [
    {
      id: "f1",
      projectId: "p1",
      key: "runtime",
      value: "node22",
      kind: "runtime",
      confidence: 0.9,
      sourceKind: "extraction",
      status: "fresh",
      lastVerifiedAt: now,
      expiresAt: null,
      validAt: null,
      invalidAt: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "f2",
      projectId: "p1",
      key: "runtime",
      value: "node18",
      kind: "runtime",
      confidence: 0.9,
      sourceKind: "extraction",
      status: "stale",
      lastVerifiedAt: now,
      expiresAt: null,
      validAt: null,
      invalidAt: null,
      createdAt: now,
      updatedAt: now,
    },
  ];
  const proposals: FactProposal[] = [
    {
      key: "runtime",
      value: "node20",
      kind: "runtime",
      confidence: 0.8,
      sourceKind: "reflection",
      sources: [],
      evidence: [],
    },
  ];
  const contradictions = detectContradictions(existing, proposals);
  assert.equal(contradictions.length, 1, "stale fact must not count as a contradiction");
  assert.equal(contradictions[0].factId, "f1");
  assert.equal(contradictions[0].existingValue, "node22");
  assert.equal(contradictions[0].proposedValue, "node20");
});

test("reflection-engine: detectContradictions ignores non-overlapping validity windows", () => {
  const existing: FactRecord[] = [
    {
      id: "f1",
      projectId: "p1",
      key: "policy",
      value: "old",
      kind: "policy",
      confidence: 0.9,
      sourceKind: "extraction",
      status: "fresh",
      lastVerifiedAt: "2020-01-01T00:00:00.000Z",
      expiresAt: null,
      validAt: "2000-01-01T00:00:00.000Z",
      invalidAt: "2021-01-01T00:00:00.000Z",
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
    },
  ];
  const proposals: FactProposal[] = [
    {
      key: "policy",
      value: "new",
      kind: "policy",
      confidence: 0.8,
      sourceKind: "reflection",
      validAt: "2030-01-01T00:00:00.000Z",
      invalidAt: null,
      sources: [],
      evidence: [],
    },
  ];
  const contradictions = detectContradictions(existing, proposals);
  assert.equal(contradictions.length, 0, "non-overlapping windows must not contradict");
});
