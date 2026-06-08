import type { DatabaseSync } from "node:sqlite";
import type {
  AnswerEvaluationRecord,
  EvalCaseRecord,
  EvalRunRecord,
  RetrievalEvaluationRecord,
  SessionOutcomeKind,
  SessionOutcomeRecord,
} from "../../../shared/src/index.ts";
import { asNumber, asString, asStringOrNull, newId, now, safeParseJsonArray } from "./_shared.ts";

interface EvalCaseRow {
  id: string;
  project_id: string | null;
  question: string;
  expected_files_json: string;
  expected_answer_contains: string | null;
  difficulty: string;
  tags_json: string;
  created_at: string;
  updated_at: string;
}

interface EvalRunRow {
  id: string;
  case_id: string;
  session_id: string | null;
  project_id: string | null;
  started_at: string;
  finished_at: string | null;
  passed: number;
  score: number;
  notes: string | null;
}

interface AnswerEvaluationRow {
  id: string;
  session_id: string | null;
  retrieval_query_id: string | null;
  groundedness: number;
  citation_coverage: number;
  contradiction: number;
  notes: string | null;
  created_at: string;
}

interface RetrievalEvaluationRow {
  id: string;
  retrieval_query_id: string;
  hit_at_k: number;
  mrr: number;
  precision: number;
  recall: number;
  notes: string | null;
  created_at: string;
}

interface SessionOutcomeRow {
  id: string;
  session_id: string;
  outcome: string;
  score: number;
  notes: string | null;
  created_at: string;
}

function rowToCase(row: EvalCaseRow): EvalCaseRecord {
  return {
    id: asString(row.id),
    projectId: asStringOrNull(row.project_id),
    question: asString(row.question),
    expectedFiles: safeParseJsonArray<string>(asString(row.expected_files_json)),
    expectedAnswerContains: asStringOrNull(row.expected_answer_contains),
    difficulty: asString(row.difficulty) as EvalCaseRecord["difficulty"],
    tags: safeParseJsonArray<string>(asString(row.tags_json)),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function rowToRun(row: EvalRunRow): EvalRunRecord {
  return {
    id: asString(row.id),
    caseId: asString(row.case_id),
    sessionId: asStringOrNull(row.session_id),
    projectId: asStringOrNull(row.project_id),
    startedAt: asString(row.started_at),
    finishedAt: asStringOrNull(row.finished_at),
    passed: row.passed === 1,
    score: asNumber(row.score),
    notes: asStringOrNull(row.notes),
  };
}

function rowToAnswerEvaluation(row: AnswerEvaluationRow): AnswerEvaluationRecord {
  return {
    id: asString(row.id),
    sessionId: asStringOrNull(row.session_id),
    retrievalQueryId: asStringOrNull(row.retrieval_query_id),
    groundedness: asNumber(row.groundedness),
    citationCoverage: asNumber(row.citation_coverage),
    contradiction: asNumber(row.contradiction),
    notes: asStringOrNull(row.notes),
    createdAt: asString(row.created_at),
  };
}

function rowToRetrievalEvaluation(row: RetrievalEvaluationRow): RetrievalEvaluationRecord {
  return {
    id: asString(row.id),
    retrievalQueryId: asString(row.retrieval_query_id),
    hitAtK: asNumber(row.hit_at_k),
    mrr: asNumber(row.mrr),
    precision: asNumber(row.precision),
    recall: asNumber(row.recall),
    notes: asStringOrNull(row.notes),
    createdAt: asString(row.created_at),
  };
}

function rowToOutcome(row: SessionOutcomeRow): SessionOutcomeRecord {
  return {
    id: asString(row.id),
    sessionId: asString(row.session_id),
    outcome: asString(row.outcome) as SessionOutcomeKind,
    score: asNumber(row.score),
    notes: asStringOrNull(row.notes),
    createdAt: asString(row.created_at),
  };
}

export function createEvalRepo(db: DatabaseSync) {
  return {
    addCase(input: {
      projectId?: string | null;
      question: string;
      expectedFiles?: string[];
      expectedAnswerContains?: string | null;
      difficulty?: EvalCaseRecord["difficulty"];
      tags?: string[];
    }): EvalCaseRecord {
      const id = newId("ecase");
      const ts = now();
      db.prepare(
        `INSERT INTO eval_cases (
          id, project_id, question, expected_files_json, expected_answer_contains,
          difficulty, tags_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        input.projectId ?? null,
        input.question,
        JSON.stringify(input.expectedFiles ?? []),
        input.expectedAnswerContains ?? null,
        input.difficulty ?? "standard",
        JSON.stringify(input.tags ?? []),
        ts,
        ts
      );
      return {
        id,
        projectId: input.projectId ?? null,
        question: input.question,
        expectedFiles: input.expectedFiles ?? [],
        expectedAnswerContains: input.expectedAnswerContains ?? null,
        difficulty: input.difficulty ?? "standard",
        tags: input.tags ?? [],
        createdAt: ts,
        updatedAt: ts,
      };
    },
    listCases(projectId?: string | null, limit = 50): EvalCaseRecord[] {
      const rows = projectId
        ? (db
            .prepare(
              "SELECT * FROM eval_cases WHERE project_id = ? ORDER BY created_at DESC LIMIT ?"
            )
            .all(projectId, limit) as EvalCaseRow[])
        : (db
            .prepare("SELECT * FROM eval_cases ORDER BY created_at DESC LIMIT ?")
            .all(limit) as EvalCaseRow[]);
      return rows.map(rowToCase);
    },
    startRun(input: {
      caseId: string;
      sessionId?: string | null;
      projectId?: string | null;
    }): EvalRunRecord {
      const id = newId("erun");
      const ts = now();
      db.prepare(
        `INSERT INTO eval_runs (id, case_id, session_id, project_id, started_at, finished_at, passed, score, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        input.caseId,
        input.sessionId ?? null,
        input.projectId ?? null,
        ts,
        null,
        0,
        0,
        null
      );
      return {
        id,
        caseId: input.caseId,
        sessionId: input.sessionId ?? null,
        projectId: input.projectId ?? null,
        startedAt: ts,
        finishedAt: null,
        passed: false,
        score: 0,
        notes: null,
      };
    },
    completeRun(
      id: string,
      input: { passed: boolean; score: number; notes?: string | null }
    ): EvalRunRecord {
      const ts = now();
      db.prepare(
        `UPDATE eval_runs SET finished_at = ?, passed = ?, score = ?, notes = ? WHERE id = ?`
      ).run(ts, input.passed ? 1 : 0, input.score, input.notes ?? null, id);
      const row = db.prepare("SELECT * FROM eval_runs WHERE id = ?").get(id) as EvalRunRow;
      return rowToRun(row);
    },
    listRuns(caseId: string, limit = 20): EvalRunRecord[] {
      const rows = db
        .prepare("SELECT * FROM eval_runs WHERE case_id = ? ORDER BY started_at DESC LIMIT ?")
        .all(caseId, limit) as EvalRunRow[];
      return rows.map(rowToRun);
    },
    recordAnswerEvaluation(input: {
      sessionId?: string | null;
      retrievalQueryId?: string | null;
      groundedness: number;
      citationCoverage: number;
      contradiction: number;
      notes?: string | null;
    }): AnswerEvaluationRecord {
      const id = newId("aev");
      const ts = now();
      db.prepare(
        `INSERT INTO answer_evaluations (
          id, session_id, retrieval_query_id, groundedness, citation_coverage, contradiction, notes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        input.sessionId ?? null,
        input.retrievalQueryId ?? null,
        input.groundedness,
        input.citationCoverage,
        input.contradiction,
        input.notes ?? null,
        ts
      );
      return {
        id,
        sessionId: input.sessionId ?? null,
        retrievalQueryId: input.retrievalQueryId ?? null,
        groundedness: input.groundedness,
        citationCoverage: input.citationCoverage,
        contradiction: input.contradiction,
        notes: input.notes ?? null,
        createdAt: ts,
      };
    },
    listAnswerEvaluations(limit = 50): AnswerEvaluationRecord[] {
      const rows = db
        .prepare("SELECT * FROM answer_evaluations ORDER BY created_at DESC LIMIT ?")
        .all(limit) as AnswerEvaluationRow[];
      return rows.map(rowToAnswerEvaluation);
    },
    recordRetrievalEvaluation(input: {
      retrievalQueryId: string;
      hitAtK: number;
      mrr: number;
      precision: number;
      recall: number;
      notes?: string | null;
    }): RetrievalEvaluationRecord {
      const id = newId("rev");
      const ts = now();
      db.prepare(
        `INSERT INTO retrieval_evaluations (
          id, retrieval_query_id, hit_at_k, mrr, precision, recall, notes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        input.retrievalQueryId,
        input.hitAtK,
        input.mrr,
        input.precision,
        input.recall,
        input.notes ?? null,
        ts
      );
      return {
        id,
        retrievalQueryId: input.retrievalQueryId,
        hitAtK: input.hitAtK,
        mrr: input.mrr,
        precision: input.precision,
        recall: input.recall,
        notes: input.notes ?? null,
        createdAt: ts,
      };
    },
    recordSessionOutcome(input: {
      sessionId: string;
      outcome: SessionOutcomeKind;
      score: number;
      notes?: string | null;
    }): SessionOutcomeRecord {
      const id = newId("so");
      const ts = now();
      db.prepare(
        `INSERT INTO session_outcomes (id, session_id, outcome, score, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(id, input.sessionId, input.outcome, input.score, input.notes ?? null, ts);
      return {
        id,
        sessionId: input.sessionId,
        outcome: input.outcome,
        score: input.score,
        notes: input.notes ?? null,
        createdAt: ts,
      };
    },
    listOutcomes(sessionId: string, limit = 20): SessionOutcomeRecord[] {
      const rows = db
        .prepare(
          "SELECT * FROM session_outcomes WHERE session_id = ? ORDER BY created_at DESC LIMIT ?"
        )
        .all(sessionId, limit) as SessionOutcomeRow[];
      return rows.map(rowToOutcome);
    },
    listAllOutcomes(limit = 50): SessionOutcomeRecord[] {
      const rows = db
        .prepare("SELECT * FROM session_outcomes ORDER BY created_at DESC LIMIT ?")
        .all(limit) as SessionOutcomeRow[];
      return rows.map(rowToOutcome);
    },
  };
}

export type EvalRepo = ReturnType<typeof createEvalRepo>;
