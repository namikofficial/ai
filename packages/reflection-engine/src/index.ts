import { redactSecrets } from "../../safety/src/index.ts";
import type {
  AgentRunRecord,
  AnswerEvaluationRecord,
  CheckRunSummary,
  ConversationMessageRecord,
  FactRecord,
  MemoryCandidateKind,
  ModelCallRecord,
  ProjectRuleRecord,
  RetrievalFeedbackRecord,
  RetrievalMissRecord,
  RetrievalQueryRecord,
  RetrievalResultRecord,
  RetrievalSelectedContextRecord,
  ReviewRecord,
  SessionOutcomeRecord,
  SessionRecord,
  SkillCandidateRecord,
  SkillRecord,
} from "../../shared/src/index.ts";

export interface ReflectionEvidence {
  kind: "session" | "query" | "context" | "conversation" | "agent_run" | "model_call" | "check" | "review" | "outcome";
  refId: string;
  excerpt: string;
  meta?: Record<string, unknown>;
}

export interface MemoryCandidateProposal {
  kind: MemoryCandidateKind;
  title: string;
  body: string;
  confidence: number;
  evidence: ReflectionEvidence[];
  scope: "project" | "global";
}

export interface SkillCandidateProposal {
  title: string;
  triggerTerms: string[];
  steps: string[];
  requiredContext: string[];
  commands: string[];
  safetyNotes: string | null;
  validation: string[];
  confidence: number;
  sourceKind: "reflection" | "manual" | "imported";
  exampleSessionId: string | null;
  evidence: ReflectionEvidence[];
}

export interface FactProposal {
  key: string;
  value: string;
  kind: string;
  confidence: number;
  sourceKind: string;
  validAt?: string | null;
  invalidAt?: string | null;
  sources: Array<{ kind: string; ref: string; excerpt: string | null }>;
  evidence: ReflectionEvidence[];
}

export interface StaleFactProposal {
  factId: string;
  reason: string;
  evidence: ReflectionEvidence[];
}

export interface ContradictionProposal {
  factId: string;
  key: string;
  existingValue: string;
  proposedValue: string;
  reason: string;
  evidence: ReflectionEvidence[];
}

export interface RetrievalFeedbackProposal {
  retrievalQueryId: string;
  chunkId: string | null;
  rating: RetrievalFeedbackRecord["rating"];
  missedPath: string | null;
  notes: string | null;
  evidence: ReflectionEvidence[];
}

export interface ReflectInput {
  session: SessionRecord;
  conversation: ConversationMessageRecord[];
  retrievals: RetrievalQueryRecord[];
  retrievalResults: Map<string, RetrievalResultRecord[]>;
  retrievalSelectedContext: Map<string, RetrievalSelectedContextRecord[]>;
  retrievalFeedback: RetrievalFeedbackRecord[];
  retrievalMisses: RetrievalMissRecord[];
  contextPacks: Array<{
    id: string;
    usedTokens: number;
    budgetTokens: number;
    retrievalQueryId: string | null;
  }>;
  agentRuns: AgentRunRecord[];
  modelCalls: ModelCallRecord[];
  checks: CheckRunSummary[];
  reviews: ReviewRecord[];
  answerEvaluations: AnswerEvaluationRecord[];
  outcome: SessionOutcomeRecord | null;
  existingFacts: FactRecord[];
  existingRules: ProjectRuleRecord[];
  existingSkills: SkillRecord[];
  freshFactTtlDays?: number;
}

export interface ReflectionOutput {
  memoryCandidates: MemoryCandidateProposal[];
  skillCandidates: SkillCandidateProposal[];
  facts: FactProposal[];
  staleFacts: StaleFactProposal[];
  contradictions: ContradictionProposal[];
  retrievalFeedback: RetrievalFeedbackProposal[];
  notes: string[];
}

function truncate(value: string, max = 240): string {
  if (!value) return "";
  const redacted = redactSecrets(value).text;
  if (redacted.length <= max) return redacted;
  return `${redacted.slice(0, max - 12)}... [truncated]`;
}

function buildEvidence(parts: Array<ReflectionEvidence | null>): ReflectionEvidence[] {
  return parts.filter((entry): entry is ReflectionEvidence => entry != null);
}

function extractUserPreference(conversation: ConversationMessageRecord[]): MemoryCandidateProposal | null {
  const userMessages = conversation.filter((entry) => entry.role === "user");
  const last = userMessages.at(-1);
  if (!last) return null;
  const lowered = last.content.toLowerCase();
  const preferenceTokens = ["prefer", "like", "always", "never", "use ", "avoid", "i want", "we use"];
  if (!preferenceTokens.some((token) => lowered.includes(token))) return null;
  return {
    kind: "user_preference",
    title: `User preference from session ${last.sessionId.slice(0, 8)}`,
    body: truncate(last.content, 320),
    confidence: 0.55,
    scope: "project",
    evidence: [
      {
        kind: "conversation",
        refId: last.id,
        excerpt: truncate(last.content),
        meta: { role: last.role, agent: last.agent, ts: last.ts },
      },
    ],
  };
}

function extractStyleRule(conversation: ConversationMessageRecord[]): MemoryCandidateProposal | null {
  const assistant = conversation.find(
    (entry) => entry.role === "assistant" && entry.content.toLowerCase().includes("always")
  );
  if (!assistant) return null;
  const match = assistant.content.match(/always [a-z][^.]{0,160}/i);
  if (!match) return null;
  return {
    kind: "style_rule",
    title: "Style rule observed",
    body: truncate(match[0], 240),
    confidence: 0.4,
    scope: "project",
    evidence: [{ kind: "conversation", refId: assistant.id, excerpt: truncate(assistant.content) }],
  };
}

function extractErrorFix(input: ReflectInput): MemoryCandidateProposal | null {
  const failedChecks = input.checks.filter((entry) => entry.status === "failed");
  if (failedChecks.length === 0) return null;
  const fixed = failedChecks.find((entry) => entry.errorOutput && entry.errorOutput.length > 0);
  if (!fixed) return null;
  return {
    kind: "error_fix",
    title: `Recurring failure: ${fixed.name}`,
    body: truncate(fixed.errorOutput ?? "", 280),
    confidence: 0.5,
    scope: "project",
    evidence: [
      {
        kind: "check",
        refId: fixed.id,
        excerpt: truncate(fixed.errorOutput ?? ""),
        meta: { name: fixed.name },
      },
    ],
  };
}

function extractAntiPattern(
  answerEvaluations: AnswerEvaluationRecord[],
  session: SessionRecord
): MemoryCandidateProposal | null {
  const weak = answerEvaluations.find((entry) => entry.groundedness < 0.4 || entry.contradiction > 0.5);
  if (!weak) return null;
  return {
    kind: "anti_pattern",
    title: `Low-groundedness answer in ${session.id.slice(0, 8)}`,
    body: `groundedness=${weak.groundedness} citation=${weak.citationCoverage} contradiction=${weak.contradiction}`,
    confidence: 0.6,
    scope: "project",
    evidence: [
      {
        kind: "review",
        refId: session.id,
        excerpt: truncate(weak.notes ?? "grounded answer warning"),
      },
    ],
  };
}

function extractRetrievalMiss(
  miss: RetrievalMissRecord,
  retrieval: RetrievalQueryRecord | undefined
): MemoryCandidateProposal | null {
  if (!retrieval) return null;
  return {
    kind: "retrieval_miss",
    title: `Missed path ${miss.missedPath}`,
    body: `Confidence=${miss.confidence.toFixed(2)} - ${miss.notes ?? "low-confidence retrieval"}`,
    confidence: 0.7,
    scope: "project",
    evidence: [
      {
        kind: "query",
        refId: retrieval.id,
        excerpt: truncate(retrieval.originalQuery),
        meta: { confidence: miss.confidence },
      },
    ],
  };
}

function extractArchitecturalFact(input: ReflectInput): FactProposal | null {
  const acceptedAnswers = input.answerEvaluations.filter((entry) => entry.groundedness >= 0.8);
  if (acceptedAnswers.length === 0) return null;
  const top = acceptedAnswers[0];
  return {
    key: `grounded_session_count`,
    value: `${acceptedAnswers.length}`,
    kind: "metric",
    confidence: 0.6,
    sourceKind: "reflection",
    sources: [
      {
        kind: "session",
        ref: input.session.id,
        excerpt: `grounded answers in session: ${acceptedAnswers.length}`,
      },
    ],
    evidence: [{ kind: "review", refId: input.session.id, excerpt: truncate(top.notes ?? "grounded", 240) }],
  };
}

function extractDependencyFact(input: ReflectInput): FactProposal | null {
  const modelCalls = input.modelCalls.filter((entry) => entry.status === "ok");
  if (modelCalls.length === 0) return null;
  const used = new Map<string, number>();
  for (const call of modelCalls) {
    used.set(call.profileId, (used.get(call.profileId) ?? 0) + 1);
  }
  const top = Array.from(used.entries()).sort((left, right) => right[1] - left[1])[0];
  if (!top) return null;
  return {
    key: `model_profile_${top[0]}`,
    value: `${top[1]} successful calls`,
    kind: "usage",
    confidence: 0.5,
    sourceKind: "model_call",
    sources: [{ kind: "session", ref: input.session.id, excerpt: `${top[0]} used ${top[1]} times` }],
    evidence: [{ kind: "model_call", refId: top[0], excerpt: `successful invocations: ${top[1]}` }],
  };
}

function detectStaleFacts(existing: FactRecord[], ttlDays: number): StaleFactProposal[] {
  const out: StaleFactProposal[] = [];
  for (const fact of existing) {
    if (fact.status === "archived" || fact.status === "stale") continue;
    if (fact.expiresAt && new Date(fact.expiresAt).getTime() < Date.now()) {
      out.push({
        factId: fact.id,
        reason: "expiresAt reached",
        evidence: [
          {
            kind: "review",
            refId: fact.id,
            excerpt: `${fact.key}=${fact.value} expires at ${fact.expiresAt}`,
            meta: { kind: fact.kind, confidence: fact.confidence },
          },
        ],
      });
      continue;
    }
    if (fact.lastVerifiedAt) {
      const age = (Date.now() - new Date(fact.lastVerifiedAt).getTime()) / (1000 * 60 * 60 * 24);
      if (age > ttlDays) {
        out.push({
          factId: fact.id,
          reason: `last verified ${age.toFixed(1)} days ago (>${ttlDays})`,
          evidence: [
            {
              kind: "review",
              refId: fact.id,
              excerpt: `${fact.key}=${fact.value} lastVerifiedAt=${fact.lastVerifiedAt}`,
            },
          ],
        });
      }
    }
  }
  return out;
}

function isFactCurrentlyValid(fact: FactRecord, asOf: number): boolean {
  if (fact.status === "archived" || fact.status === "stale") return false;
  if (fact.validAt && new Date(fact.validAt).getTime() > asOf) return false;
  if (fact.invalidAt && new Date(fact.invalidAt).getTime() <= asOf) return false;
  return true;
}

function windowsOverlap(aFrom: string | null, aTo: string | null, bFrom: string | null, bTo: string | null): boolean {
  const aStart = aFrom ? new Date(aFrom).getTime() : -Infinity;
  const aEnd = aTo ? new Date(aTo).getTime() : Infinity;
  const bStart = bFrom ? new Date(bFrom).getTime() : -Infinity;
  const bEnd = bTo ? new Date(bTo).getTime() : Infinity;
  return aStart <= bEnd && bStart <= aEnd;
}

// Detects proposals that contradict a currently-valid existing fact with the
// same key but a different value. Contradictions must be surfaced for human
// review before promotion; they are never auto-applied.
export function detectContradictions(existing: FactRecord[], proposals: FactProposal[]): ContradictionProposal[] {
  const out: ContradictionProposal[] = [];
  const asOf = Date.now();
  for (const proposal of proposals) {
    for (const fact of existing) {
      if (fact.key !== proposal.key) continue;
      if (fact.value === proposal.value) continue;
      if (!isFactCurrentlyValid(fact, asOf)) continue;
      if (!windowsOverlap(fact.validAt, fact.invalidAt, proposal.validAt ?? null, proposal.invalidAt ?? null)) continue;
      out.push({
        factId: fact.id,
        key: fact.key,
        existingValue: fact.value,
        proposedValue: proposal.value,
        reason: `proposed value "${proposal.value}" contradicts current fact "${fact.value}"`,
        evidence: [
          {
            kind: "review",
            refId: fact.id,
            excerpt: `${fact.key}=${fact.value} (status=${fact.status})`,
            meta: { kind: fact.kind, confidence: fact.confidence },
          },
        ],
      });
    }
  }
  return out;
}

function proposeSkillFromChecks(input: ReflectInput): SkillCandidateProposal | null {
  const successfulChecks = input.checks.filter((entry) => entry.status === "completed" && entry.command);
  if (successfulChecks.length < 1) return null;
  const distinct = new Map<string, { command: string; count: number }>();
  for (const check of successfulChecks) {
    const command = check.command;
    if (!command) continue;
    const current = distinct.get(command) ?? { command, count: 0 };
    current.count += 1;
    distinct.set(command, current);
  }
  const top = Array.from(distinct.values()).sort((left, right) => right.count - left.count)[0];
  if (!top) return null;
  return {
    title: `Run ${top.command} before/after code changes`,
    triggerTerms: [top.command, "check", "verify"],
    steps: [`run \`${top.command}\``, "collect output and surface failures", "store summary in session trace"],
    requiredContext: ["project_rules", "retrieval_chunks", "previous_messages"],
    commands: [top.command],
    safetyNotes: `requires \`${top.command}\` to be allowlisted; failures must surface for human review`,
    validation: ["check exit code 0", "no new warnings"],
    confidence: Math.min(0.7, 0.3 + top.count * 0.1),
    sourceKind: "reflection",
    exampleSessionId: input.session.id,
    evidence: [
      {
        kind: "check",
        refId: input.checks[0].id,
        excerpt: truncate(top.command),
        meta: { count: top.count },
      },
    ],
  };
}

function proposeSkillFromReviews(input: ReflectInput): SkillCandidateProposal | null {
  if (input.reviews.length === 0) return null;
  const review = input.reviews[0];
  return {
    title: `Review workflow: ${review.title}`,
    triggerTerms: ["review", "audit", "scope creep"],
    steps: ["load review summary", "list scope creep and missing tests", "write next-step recommendation"],
    requiredContext: ["previous_messages", "agent_runs", "model_calls"],
    commands: [],
    safetyNotes: null,
    validation: ["scope creep empty", "no risky changes"],
    confidence: 0.45,
    sourceKind: "reflection",
    exampleSessionId: input.session.id,
    evidence: [{ kind: "review", refId: review.id, excerpt: truncate(review.summary, 240) }],
  };
}

function buildRetrievalFeedback(input: ReflectInput): RetrievalFeedbackProposal[] {
  const out: RetrievalFeedbackProposal[] = [];
  for (const retrieval of input.retrievals) {
    if (retrieval.rewrittenQuery == null) continue;
    const results = input.retrievalResults.get(retrieval.id) ?? [];
    const contextItems = input.retrievalSelectedContext.get(retrieval.id) ?? [];
    if (contextItems.length === 0 && results.length > 0) {
      out.push({
        retrievalQueryId: retrieval.id,
        chunkId: null,
        rating: "missed",
        missedPath: results[0]?.path ?? "unknown",
        notes: "selected context was empty",
        evidence: [
          { kind: "query", refId: retrieval.id, excerpt: truncate(retrieval.originalQuery) },
          { kind: "context", refId: retrieval.id, excerpt: "no selected context items" },
        ],
      });
    } else if (contextItems.length > 0 && results.length === 0) {
      out.push({
        retrievalQueryId: retrieval.id,
        chunkId: null,
        rating: "missed",
        missedPath: contextItems[0].excerpt.slice(0, 80),
        notes: "no candidate results but context exists",
        evidence: [{ kind: "query", refId: retrieval.id, excerpt: truncate(retrieval.originalQuery) }],
      });
    }
  }
  return out;
}

export function reflect(input: ReflectInput): ReflectionOutput {
  const notes: string[] = [];
  const memoryCandidates: MemoryCandidateProposal[] = [];
  const skillCandidates: SkillCandidateProposal[] = [];
  const facts: FactProposal[] = [];
  const staleFacts: StaleFactProposal[] = [];

  const preference = extractUserPreference(input.conversation);
  if (preference) memoryCandidates.push(preference);
  const style = extractStyleRule(input.conversation);
  if (style) memoryCandidates.push(style);
  const errorFix = extractErrorFix(input);
  if (errorFix) memoryCandidates.push(errorFix);
  const antiPattern = extractAntiPattern(input.answerEvaluations, input.session);
  if (antiPattern) memoryCandidates.push(antiPattern);

  for (const miss of input.retrievalMisses) {
    const retrieval = input.retrievals.find((entry) => entry.id === miss.retrievalQueryId);
    const proposal = extractRetrievalMiss(miss, retrieval);
    if (proposal) memoryCandidates.push(proposal);
  }

  if (input.outcome?.outcome === "success" && input.outcome.score >= 0.8) {
    memoryCandidates.push({
      kind: "workflow_lesson",
      title: `Successful session ${input.session.id.slice(0, 8)}`,
      body: truncate(
        input.session.finalSummary ?? `Outcome: ${input.outcome.outcome}, score=${input.outcome.score}`,
        280
      ),
      confidence: 0.6,
      scope: "project",
      evidence: buildEvidence([
        {
          kind: "outcome",
          refId: input.outcome.id,
          excerpt: truncate(input.outcome.notes ?? input.outcome.outcome),
        },
        { kind: "session", refId: input.session.id, excerpt: truncate(input.session.title) },
      ]),
    });
  }

  const arch = extractArchitecturalFact(input);
  if (arch) facts.push(arch);
  const dep = extractDependencyFact(input);
  if (dep) facts.push(dep);

  const ttlDays = input.freshFactTtlDays ?? 30;
  const stale = detectStaleFacts(input.existingFacts, ttlDays);
  staleFacts.push(...stale);

  const contradictions = detectContradictions(input.existingFacts, facts);

  const skillChecks = proposeSkillFromChecks(input);
  if (skillChecks) skillCandidates.push(skillChecks);
  const skillReviews = proposeSkillFromReviews(input);
  if (skillReviews) skillCandidates.push(skillReviews);

  const retrievalFeedback = buildRetrievalFeedback(input);

  notes.push(`memoryCandidates=${memoryCandidates.length}`);
  notes.push(`skillCandidates=${skillCandidates.length}`);
  notes.push(`facts=${facts.length}`);
  notes.push(`staleFacts=${staleFacts.length}`);
  notes.push(`contradictions=${contradictions.length}`);
  notes.push(`retrievalFeedback=${retrievalFeedback.length}`);

  return { memoryCandidates, skillCandidates, facts, staleFacts, contradictions, retrievalFeedback, notes };
}

export function buildSkillCandidateRecord(
  proposal: SkillCandidateProposal,
  projectId: string | null
): SkillCandidateRecord {
  const ts = new Date().toISOString();
  return {
    id: `sc_${Date.now()}_${proposal.title.slice(0, 16).replace(/[^a-z0-9]+/gi, "_")}`,
    projectId,
    title: proposal.title,
    triggerTerms: proposal.triggerTerms,
    applicableProjects: projectId ? [projectId] : [],
    steps: proposal.steps,
    requiredContext: proposal.requiredContext,
    commands: proposal.commands,
    safetyNotes: proposal.safetyNotes,
    validation: proposal.validation,
    exampleSessionId: proposal.exampleSessionId,
    sourceKind: proposal.sourceKind,
    confidence: proposal.confidence,
    status: "pending",
    createdAt: ts,
    updatedAt: ts,
  };
}
