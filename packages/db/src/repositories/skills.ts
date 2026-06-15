import type { DatabaseSync } from "node:sqlite";
import type {
  SkillCandidateRecord,
  SkillRecord,
  SkillSourceKind,
  SkillStatus,
  SkillUsageRecord,
} from "../../../shared/src/index.ts";
import { asBool, asNumber, asString, asStringOrNull, newId, now, safeParseJsonArray } from "./_shared.ts";

interface SkillCandidateRow {
  id: string;
  project_id: string | null;
  title: string;
  trigger_terms_json: string;
  applicable_projects_json: string;
  steps_json: string;
  required_context_json: string;
  commands_json: string;
  safety_notes: string | null;
  validation_json: string;
  example_session_id: string | null;
  source_kind: string;
  confidence: number;
  status: string;
  created_at: string;
  updated_at: string;
}

interface SkillRow {
  id: string;
  candidate_id: string | null;
  title: string;
  trigger_terms_json: string;
  applicable_projects_json: string;
  steps_json: string;
  required_context_json: string;
  commands_json: string;
  safety_notes: string | null;
  validation_json: string;
  status: string;
  use_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SkillUsageRow {
  id: string;
  skill_id: string;
  session_id: string | null;
  applied: number;
  notes: string | null;
  created_at: string;
}

function rowToCandidate(row: SkillCandidateRow): SkillCandidateRecord {
  return {
    id: asString(row.id),
    projectId: asStringOrNull(row.project_id),
    title: asString(row.title),
    triggerTerms: safeParseJsonArray<string>(asString(row.trigger_terms_json)),
    applicableProjects: safeParseJsonArray<string>(asString(row.applicable_projects_json)),
    steps: safeParseJsonArray<string>(asString(row.steps_json)),
    requiredContext: safeParseJsonArray<string>(asString(row.required_context_json)),
    commands: safeParseJsonArray<string>(asString(row.commands_json)),
    safetyNotes: asStringOrNull(row.safety_notes),
    validation: safeParseJsonArray<string>(asString(row.validation_json)),
    exampleSessionId: asStringOrNull(row.example_session_id),
    sourceKind: asString(row.source_kind) as SkillSourceKind,
    confidence: asNumber(row.confidence),
    status: asString(row.status) as SkillStatus,
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function rowToSkill(row: SkillRow): SkillRecord {
  return {
    id: asString(row.id),
    candidateId: asStringOrNull(row.candidate_id),
    title: asString(row.title),
    triggerTerms: safeParseJsonArray<string>(asString(row.trigger_terms_json)),
    applicableProjects: safeParseJsonArray<string>(asString(row.applicable_projects_json)),
    steps: safeParseJsonArray<string>(asString(row.steps_json)),
    requiredContext: safeParseJsonArray<string>(asString(row.required_context_json)),
    commands: safeParseJsonArray<string>(asString(row.commands_json)),
    safetyNotes: asStringOrNull(row.safety_notes),
    validation: safeParseJsonArray<string>(asString(row.validation_json)),
    status: asString(row.status) as SkillStatus,
    useCount: asNumber(row.use_count),
    lastUsedAt: asStringOrNull(row.last_used_at),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function rowToUsage(row: SkillUsageRow): SkillUsageRecord {
  return {
    id: asString(row.id),
    skillId: asString(row.skill_id),
    sessionId: asStringOrNull(row.session_id),
    applied: asBool(row.applied),
    notes: asStringOrNull(row.notes),
    createdAt: asString(row.created_at),
  };
}

export function createSkillsRepo(db: DatabaseSync) {
  return {
    createCandidate(input: {
      projectId?: string | null;
      title: string;
      triggerTerms: string[];
      applicableProjects: string[];
      steps: string[];
      requiredContext: string[];
      commands: string[];
      safetyNotes?: string | null;
      validation: string[];
      exampleSessionId?: string | null;
      sourceKind?: SkillSourceKind;
      confidence: number;
    }): SkillCandidateRecord {
      const id = newId("scand");
      const ts = now();
      db.prepare(
        `INSERT INTO skill_candidates (
          id, project_id, title, trigger_terms_json, applicable_projects_json,
          steps_json, required_context_json, commands_json, safety_notes,
          validation_json, example_session_id, source_kind, confidence, status,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        input.projectId ?? null,
        input.title,
        JSON.stringify(input.triggerTerms),
        JSON.stringify(input.applicableProjects),
        JSON.stringify(input.steps),
        JSON.stringify(input.requiredContext),
        JSON.stringify(input.commands),
        input.safetyNotes ?? null,
        JSON.stringify(input.validation),
        input.exampleSessionId ?? null,
        input.sourceKind ?? "reflection",
        input.confidence,
        "pending",
        ts,
        ts
      );
      return {
        id,
        projectId: input.projectId ?? null,
        title: input.title,
        triggerTerms: input.triggerTerms,
        applicableProjects: input.applicableProjects,
        steps: input.steps,
        requiredContext: input.requiredContext,
        commands: input.commands,
        safetyNotes: input.safetyNotes ?? null,
        validation: input.validation,
        exampleSessionId: input.exampleSessionId ?? null,
        sourceKind: input.sourceKind ?? "reflection",
        confidence: input.confidence,
        status: "pending",
        createdAt: ts,
        updatedAt: ts,
      };
    },
    listCandidates(status?: SkillStatus, limit = 50): SkillCandidateRecord[] {
      const rows = status
        ? (db
            .prepare(
              "SELECT * FROM skill_candidates WHERE status = ? ORDER BY confidence DESC, created_at DESC LIMIT ?"
            )
            .all(status, limit) as SkillCandidateRow[])
        : (db
            .prepare("SELECT * FROM skill_candidates ORDER BY confidence DESC, created_at DESC LIMIT ?")
            .all(limit) as SkillCandidateRow[]);
      return rows.map(rowToCandidate);
    },
    getCandidate(id: string): SkillCandidateRecord | null {
      const row = db.prepare("SELECT * FROM skill_candidates WHERE id = ? LIMIT 1").get(id) as
        | SkillCandidateRow
        | undefined;
      return row ? rowToCandidate(row) : null;
    },
    reviewCandidate(id: string, status: SkillStatus): SkillCandidateRecord {
      const ts = now();
      db.prepare("UPDATE skill_candidates SET status = ?, updated_at = ? WHERE id = ?").run(status, ts, id);
      const row = db.prepare("SELECT * FROM skill_candidates WHERE id = ?").get(id) as SkillCandidateRow;
      return rowToCandidate(row);
    },
    acceptCandidate(id: string): SkillRecord {
      const candidate = this.getCandidate(id);
      if (!candidate) throw new Error(`unknown skill candidate: ${id}`);
      const ts = now();
      const skillId = newId("skill");
      db.prepare(
        `INSERT INTO skills (
          id, candidate_id, title, trigger_terms_json, applicable_projects_json,
          steps_json, required_context_json, commands_json, safety_notes,
          validation_json, status, use_count, last_used_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        skillId,
        candidate.id,
        candidate.title,
        JSON.stringify(candidate.triggerTerms),
        JSON.stringify(candidate.applicableProjects),
        JSON.stringify(candidate.steps),
        JSON.stringify(candidate.requiredContext),
        JSON.stringify(candidate.commands),
        candidate.safetyNotes,
        JSON.stringify(candidate.validation),
        "active",
        0,
        null,
        ts,
        ts
      );
      this.reviewCandidate(candidate.id, "active");
      return {
        id: skillId,
        candidateId: candidate.id,
        title: candidate.title,
        triggerTerms: candidate.triggerTerms,
        applicableProjects: candidate.applicableProjects,
        steps: candidate.steps,
        requiredContext: candidate.requiredContext,
        commands: candidate.commands,
        safetyNotes: candidate.safetyNotes,
        validation: candidate.validation,
        status: "active",
        useCount: 0,
        lastUsedAt: null,
        createdAt: ts,
        updatedAt: ts,
      };
    },
    listSkills(status?: SkillStatus, limit = 50): SkillRecord[] {
      const rows = status
        ? (db
            .prepare("SELECT * FROM skills WHERE status = ? ORDER BY use_count DESC, updated_at DESC LIMIT ?")
            .all(status, limit) as SkillRow[])
        : (db
            .prepare("SELECT * FROM skills ORDER BY use_count DESC, updated_at DESC LIMIT ?")
            .all(limit) as SkillRow[]);
      return rows.map(rowToSkill);
    },
    recordUsage(input: {
      skillId: string;
      sessionId?: string | null;
      applied: boolean;
      notes?: string | null;
    }): SkillUsageRecord {
      const id = newId("su");
      const ts = now();
      db.prepare(
        `INSERT INTO skill_usage (id, skill_id, session_id, applied, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(id, input.skillId, input.sessionId ?? null, input.applied ? 1 : 0, input.notes ?? null, ts);
      db.prepare(`UPDATE skills SET use_count = use_count + 1, last_used_at = ?, updated_at = ? WHERE id = ?`).run(
        ts,
        ts,
        input.skillId
      );
      return {
        id,
        skillId: input.skillId,
        sessionId: input.sessionId ?? null,
        applied: input.applied,
        notes: input.notes ?? null,
        createdAt: ts,
      };
    },
    listUsage(skillId: string, limit = 50): SkillUsageRecord[] {
      const rows = db
        .prepare("SELECT * FROM skill_usage WHERE skill_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(skillId, limit) as SkillUsageRow[];
      return rows.map(rowToUsage);
    },
  };
}

export type SkillsRepo = ReturnType<typeof createSkillsRepo>;
