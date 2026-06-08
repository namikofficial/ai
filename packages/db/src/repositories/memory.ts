import type { DatabaseSync } from "node:sqlite";
import type {
  FactRecord,
  FactSourceRecord,
  FactStatus,
  MemoryCandidateKind,
  MemoryCandidateRecord,
  MemoryCandidateStatus,
  MemoryEntryRecord,
  MemoryScope,
  ProjectRuleRecord,
} from "../../../shared/src/index.ts";
import {
  asBool,
  asNumber,
  asString,
  asStringOrNull,
  newId,
  now,
  safeParseJson,
  safeParseJsonArray,
} from "./_shared.ts";

interface MemoryCandidateRow {
  id: string;
  project_id: string | null;
  session_id: string | null;
  kind: string;
  title: string;
  body: string;
  evidence_json: string;
  confidence: number;
  scope: string;
  status: string;
  reviewed_at: string | null;
  reviewer_notes: string | null;
  created_at: string;
  updated_at: string;
}

interface MemoryEntryRow {
  id: string;
  candidate_id: string | null;
  project_id: string | null;
  scope: string;
  kind: string;
  title: string;
  body: string;
  evidence_json: string;
  confidence: number;
  pinned: number;
  archived: number;
  last_used_at: string | null;
  use_count: number;
  created_at: string;
  updated_at: string;
}

interface FactRow {
  id: string;
  project_id: string | null;
  key: string;
  value: string;
  kind: string;
  confidence: number;
  source_kind: string;
  status: string;
  last_verified_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface FactSourceRow {
  id: string;
  fact_id: string;
  source_kind: string;
  source_ref: string;
  excerpt: string | null;
  created_at: string;
}

interface ProjectRuleRow {
  id: string;
  project_id: string;
  title: string;
  body: string;
  pinned: number;
  created_at: string;
  updated_at: string;
}

function rowToCandidate(row: MemoryCandidateRow): MemoryCandidateRecord {
  return {
    id: asString(row.id),
    projectId: asStringOrNull(row.project_id),
    sessionId: asStringOrNull(row.session_id),
    kind: asString(row.kind) as MemoryCandidateKind,
    title: asString(row.title),
    body: asString(row.body),
    evidence: safeParseJsonArray<Record<string, unknown>>(asString(row.evidence_json)),
    confidence: asNumber(row.confidence),
    scope: asString(row.scope) as MemoryScope,
    status: asString(row.status) as MemoryCandidateStatus,
    reviewedAt: asStringOrNull(row.reviewed_at),
    reviewerNotes: asStringOrNull(row.reviewer_notes),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function rowToEntry(row: MemoryEntryRow): MemoryEntryRecord {
  return {
    id: asString(row.id),
    candidateId: asStringOrNull(row.candidate_id),
    projectId: asStringOrNull(row.project_id),
    scope: asString(row.scope) as MemoryScope,
    kind: asString(row.kind) as MemoryCandidateKind,
    title: asString(row.title),
    body: asString(row.body),
    evidence: safeParseJsonArray<Record<string, unknown>>(asString(row.evidence_json)),
    confidence: asNumber(row.confidence),
    pinned: asBool(row.pinned),
    archived: asBool(row.archived),
    lastUsedAt: asStringOrNull(row.last_used_at),
    useCount: asNumber(row.use_count),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function rowToFact(row: FactRow): FactRecord {
  return {
    id: asString(row.id),
    projectId: asStringOrNull(row.project_id),
    key: asString(row.key),
    value: asString(row.value),
    kind: asString(row.kind),
    confidence: asNumber(row.confidence),
    sourceKind: asString(row.source_kind),
    status: asString(row.status) as FactStatus,
    lastVerifiedAt: asStringOrNull(row.last_verified_at),
    expiresAt: asStringOrNull(row.expires_at),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function rowToFactSource(row: FactSourceRow): FactSourceRecord {
  return {
    id: asString(row.id),
    factId: asString(row.fact_id),
    sourceKind: asString(row.source_kind),
    sourceRef: asString(row.source_ref),
    excerpt: asStringOrNull(row.excerpt),
    createdAt: asString(row.created_at),
  };
}

function rowToRule(row: ProjectRuleRow): ProjectRuleRecord {
  return {
    id: asString(row.id),
    projectId: asString(row.project_id),
    title: asString(row.title),
    body: asString(row.body),
    pinned: asBool(row.pinned),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

export function createMemoryRepo(db: DatabaseSync) {
  return {
    createCandidate(input: {
      projectId?: string | null;
      sessionId?: string | null;
      kind: MemoryCandidateKind;
      title: string;
      body: string;
      evidence?: Array<{ [key: string]: unknown }>;
      confidence: number;
      scope?: MemoryScope;
    }): MemoryCandidateRecord {
      const id = newId("mcand");
      const ts = now();
      const scope = input.scope ?? "project";
      db.prepare(
        `INSERT INTO memory_candidates (
          id, project_id, session_id, kind, title, body, evidence_json,
          confidence, scope, status, reviewed_at, reviewer_notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        input.projectId ?? null,
        input.sessionId ?? null,
        input.kind,
        input.title,
        input.body,
        JSON.stringify(input.evidence ?? []),
        input.confidence,
        scope,
        "pending",
        null,
        null,
        ts,
        ts
      );
      return {
        id,
        projectId: input.projectId ?? null,
        sessionId: input.sessionId ?? null,
        kind: input.kind,
        title: input.title,
        body: input.body,
        evidence: input.evidence ?? [],
        confidence: input.confidence,
        scope,
        status: "pending",
        reviewedAt: null,
        reviewerNotes: null,
        createdAt: ts,
        updatedAt: ts,
      };
    },
    listCandidates(
      status?: MemoryCandidateStatus,
      projectId?: string | null,
      limit = 50
    ): MemoryCandidateRecord[] {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (status) {
        conditions.push("status = ?");
        params.push(status);
      }
      if (projectId != null) {
        conditions.push("project_id = ?");
        params.push(projectId);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      params.push(limit);
      const rows = db
        .prepare(`SELECT * FROM memory_candidates ${where} ORDER BY created_at DESC LIMIT ?`)
        .all(...params) as MemoryCandidateRow[];
      return rows.map(rowToCandidate);
    },
    getCandidate(id: string): MemoryCandidateRecord | null {
      const row = db.prepare("SELECT * FROM memory_candidates WHERE id = ? LIMIT 1").get(id) as
        | MemoryCandidateRow
        | undefined;
      return row ? rowToCandidate(row) : null;
    },
    reviewCandidate(
      id: string,
      status: Exclude<MemoryCandidateStatus, "pending">,
      notes?: string | null,
      body?: string | null
    ): MemoryCandidateRecord {
      const ts = now();
      db.prepare(
        `UPDATE memory_candidates
           SET status = ?, reviewed_at = ?, reviewer_notes = ?, body = COALESCE(?, body), updated_at = ?
         WHERE id = ?`
      ).run(status, ts, notes ?? null, body ?? null, ts, id);
      const updated = db
        .prepare("SELECT * FROM memory_candidates WHERE id = ?")
        .get(id) as MemoryCandidateRow;
      return rowToCandidate(updated);
    },
    acceptCandidate(id: string, notes?: string | null): MemoryEntryRecord {
      const candidate = this.getCandidate(id);
      if (!candidate) throw new Error(`unknown memory candidate: ${id}`);
      const ts = now();
      const entryId = newId("mentry");
      db.prepare(
        `INSERT INTO memory_entries (
          id, candidate_id, project_id, scope, kind, title, body, evidence_json,
          confidence, pinned, archived, last_used_at, use_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        entryId,
        candidate.id,
        candidate.projectId,
        candidate.scope,
        candidate.kind,
        candidate.title,
        candidate.body,
        JSON.stringify(candidate.evidence),
        candidate.confidence,
        0,
        0,
        null,
        0,
        ts,
        ts
      );
      this.reviewCandidate(candidate.id, "accepted", notes ?? null);
      return {
        id: entryId,
        candidateId: candidate.id,
        projectId: candidate.projectId,
        scope: candidate.scope,
        kind: candidate.kind,
        title: candidate.title,
        body: candidate.body,
        evidence: candidate.evidence,
        confidence: candidate.confidence,
        pinned: false,
        archived: false,
        lastUsedAt: null,
        useCount: 0,
        createdAt: ts,
        updatedAt: ts,
      };
    },
    listEntries(projectId?: string | null, scope?: MemoryScope, limit = 50): MemoryEntryRecord[] {
      const conditions: string[] = ["archived = 0"];
      const params: unknown[] = [];
      if (projectId != null) {
        conditions.push("(project_id = ? OR scope = 'global')");
        params.push(projectId);
      }
      if (scope) {
        conditions.push("scope = ?");
        params.push(scope);
      }
      params.push(limit);
      const rows = db
        .prepare(
          `SELECT * FROM memory_entries WHERE ${conditions.join(" AND ")} ORDER BY pinned DESC, confidence DESC, created_at DESC LIMIT ?`
        )
        .all(...params) as MemoryEntryRow[];
      return rows.map(rowToEntry);
    },
    pinEntry(id: string, pinned: boolean): MemoryEntryRecord {
      db.prepare("UPDATE memory_entries SET pinned = ?, updated_at = ? WHERE id = ?").run(
        pinned ? 1 : 0,
        now(),
        id
      );
      const row = db.prepare("SELECT * FROM memory_entries WHERE id = ?").get(id) as MemoryEntryRow;
      return rowToEntry(row);
    },
    recordFact(input: {
      projectId?: string | null;
      key: string;
      value: string;
      kind?: string;
      confidence: number;
      sourceKind?: string;
      sources?: Array<{ kind: string; ref: string; excerpt?: string | null }>;
    }): FactRecord {
      const id = newId("fact");
      const ts = now();
      db.prepare(
        `INSERT INTO facts (
          id, project_id, key, value, kind, confidence, source_kind, status,
          last_verified_at, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        input.projectId ?? null,
        input.key,
        input.value,
        input.kind ?? "fact",
        input.confidence,
        input.sourceKind ?? "extraction",
        "fresh",
        ts,
        null,
        ts,
        ts
      );
      const sourceInsert = db.prepare(
        `INSERT INTO fact_sources (id, fact_id, source_kind, source_ref, excerpt, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const source of input.sources ?? []) {
        sourceInsert.run(newId("fs"), id, source.kind, source.ref, source.excerpt ?? null, ts);
      }
      return {
        id,
        projectId: input.projectId ?? null,
        key: input.key,
        value: input.value,
        kind: input.kind ?? "fact",
        confidence: input.confidence,
        sourceKind: input.sourceKind ?? "extraction",
        status: "fresh",
        lastVerifiedAt: ts,
        expiresAt: null,
        createdAt: ts,
        updatedAt: ts,
      };
    },
    listFacts(projectId?: string | null, limit = 50): FactRecord[] {
      const rows = projectId
        ? (db
            .prepare(
              "SELECT * FROM facts WHERE project_id = ? OR project_id IS NULL ORDER BY confidence DESC, updated_at DESC LIMIT ?"
            )
            .all(projectId, limit) as FactRow[])
        : (db
            .prepare("SELECT * FROM facts ORDER BY confidence DESC, updated_at DESC LIMIT ?")
            .all(limit) as FactRow[]);
      return rows.map(rowToFact);
    },
    markFactStatus(id: string, status: FactStatus): FactRecord {
      db.prepare("UPDATE facts SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), id);
      const row = db.prepare("SELECT * FROM facts WHERE id = ?").get(id) as FactRow;
      return rowToFact(row);
    },
    listFactSources(factId: string): FactSourceRecord[] {
      const rows = db
        .prepare("SELECT * FROM fact_sources WHERE fact_id = ? ORDER BY created_at ASC")
        .all(factId) as FactSourceRow[];
      return rows.map(rowToFactSource);
    },
    addProjectRule(input: {
      projectId: string;
      title: string;
      body: string;
      pinned?: boolean;
    }): ProjectRuleRecord {
      const id = newId("pr");
      const ts = now();
      db.prepare(
        `INSERT INTO project_rules (id, project_id, title, body, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(id, input.projectId, input.title, input.body, input.pinned ? 1 : 0, ts, ts);
      return {
        id,
        projectId: input.projectId,
        title: input.title,
        body: input.body,
        pinned: input.pinned ?? false,
        createdAt: ts,
        updatedAt: ts,
      };
    },
    listProjectRules(projectId: string, limit = 50): ProjectRuleRecord[] {
      const rows = db
        .prepare(
          "SELECT * FROM project_rules WHERE project_id = ? ORDER BY pinned DESC, updated_at DESC LIMIT ?"
        )
        .all(projectId, limit) as ProjectRuleRow[];
      return rows.map(rowToRule);
    },
  };
}

export type MemoryRepo = ReturnType<typeof createMemoryRepo>;
