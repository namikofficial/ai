import type { DatabaseSync } from "node:sqlite";
import type { ProjectManifest } from "../../../contracts/src/index.ts";
import { projectManifestSchema } from "../../../contracts/src/index.ts";
import { asString, asStringOrNull, newId, now } from "./_shared.ts";

export type ManifestProposalStatus = "pending" | "approved" | "rejected";
export type ProjectPinScope = "workspace" | "session" | "persistent";

export interface ManifestProposal {
  id: string;
  projectId: string;
  manifest: ProjectManifest;
  sourceRef: string | null;
  status: ManifestProposalStatus;
  createdAt: string;
  resolvedAt: string | null;
}

export interface ActiveProjectSelection {
  projectId: string | null;
  source: string;
  pinScope: ProjectPinScope | null;
  selectedAt: string;
  updatedAt: string;
}

interface ManifestRow {
  manifest_json: string;
}

interface ProposalRow {
  id: string;
  project_id: string;
  manifest_json: string;
  source_ref: string | null;
  status: string;
  created_at: string;
  resolved_at: string | null;
}

interface SelectionRow {
  project_id: string | null;
  source: string;
  pin_scope: string | null;
  selected_at: string;
  updated_at: string;
}

function parseManifestJson(value: string): ProjectManifest {
  return projectManifestSchema.parse(JSON.parse(value));
}

function ensureProjectExists(db: DatabaseSync, projectId: string): void {
  const row = db.prepare("SELECT id FROM projects WHERE id = ? LIMIT 1").get(projectId);
  if (!row) throw new Error(`unknown project: ${projectId}`);
}

function validateManifestForProject(manifest: unknown, projectId: string): ProjectManifest {
  const parsed = projectManifestSchema.parse(manifest);
  if (parsed.id !== projectId) {
    throw new Error(`manifest project id ${parsed.id} does not match ${projectId}`);
  }
  return parsed;
}

function rowToProposal(row: ProposalRow): ManifestProposal {
  return {
    id: asString(row.id),
    projectId: asString(row.project_id),
    manifest: parseManifestJson(row.manifest_json),
    sourceRef: asStringOrNull(row.source_ref),
    status: asString(row.status) as ManifestProposalStatus,
    createdAt: asString(row.created_at),
    resolvedAt: asStringOrNull(row.resolved_at),
  };
}

export function createProjectRegistryRepo(db: DatabaseSync) {
  const upsertManifest = db.prepare(
    `INSERT INTO project_manifests (
       project_id, schema_version, manifest_json, approved_source, approved_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       schema_version = excluded.schema_version,
       manifest_json = excluded.manifest_json,
       approved_source = excluded.approved_source,
       approved_at = excluded.approved_at,
       updated_at = excluded.updated_at`
  );

  return {
    getManifest(projectId: string): ProjectManifest | null {
      const row = db
        .prepare("SELECT manifest_json FROM project_manifests WHERE project_id = ? LIMIT 1")
        .get(projectId) as ManifestRow | undefined;
      return row ? parseManifestJson(row.manifest_json) : null;
    },

    listManifests(): ProjectManifest[] {
      const rows = db
        .prepare("SELECT manifest_json FROM project_manifests ORDER BY updated_at DESC")
        .all() as ManifestRow[];
      return rows.map((row) => parseManifestJson(row.manifest_json));
    },

    saveApprovedManifest(projectId: string, manifest: unknown, approvedSource: string): ProjectManifest {
      ensureProjectExists(db, projectId);
      const parsed = validateManifestForProject(manifest, projectId);
      const timestamp = now();
      upsertManifest.run(
        projectId,
        parsed.schemaVersion,
        JSON.stringify(parsed),
        approvedSource,
        timestamp,
        timestamp,
        timestamp
      );
      return parsed;
    },

    proposeManifest(projectId: string, manifest: unknown, sourceRef: string | null = null): ManifestProposal {
      ensureProjectExists(db, projectId);
      const parsed = validateManifestForProject(manifest, projectId);
      const id = newId("manifest_proposal");
      const timestamp = now();
      db.prepare(
        `INSERT INTO project_manifest_proposals (
           id, project_id, schema_version, manifest_json, source_ref, status, created_at, resolved_at
         ) VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)`
      ).run(id, projectId, parsed.schemaVersion, JSON.stringify(parsed), sourceRef, timestamp);
      const proposal = this.getProposal(id);
      if (!proposal) throw new Error(`manifest proposal ${id} was not persisted`);
      return proposal;
    },

    getProposal(id: string): ManifestProposal | null {
      const row = db.prepare("SELECT * FROM project_manifest_proposals WHERE id = ? LIMIT 1").get(id) as
        | ProposalRow
        | undefined;
      return row ? rowToProposal(row) : null;
    },

    listProposals(projectId: string, status: ManifestProposalStatus = "pending"): ManifestProposal[] {
      const rows = db
        .prepare(
          "SELECT * FROM project_manifest_proposals WHERE project_id = ? AND status = ? ORDER BY created_at DESC"
        )
        .all(projectId, status) as ProposalRow[];
      return rows.map(rowToProposal);
    },

    resolveProposal(id: string, resolution: "approved" | "rejected", approvedSource = "proposal"): ManifestProposal {
      const proposal = this.getProposal(id);
      if (!proposal) throw new Error(`unknown manifest proposal: ${id}`);
      if (proposal.status !== "pending") throw new Error(`manifest proposal ${id} is already ${proposal.status}`);
      const timestamp = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        if (resolution === "approved") {
          upsertManifest.run(
            proposal.projectId,
            proposal.manifest.schemaVersion,
            JSON.stringify(proposal.manifest),
            approvedSource,
            timestamp,
            timestamp,
            timestamp
          );
        }
        db.prepare("UPDATE project_manifest_proposals SET status = ?, resolved_at = ? WHERE id = ?").run(
          resolution,
          timestamp,
          id
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      const resolved = this.getProposal(id);
      if (!resolved) throw new Error(`manifest proposal ${id} disappeared after resolution`);
      return resolved;
    },

    getSelection(): ActiveProjectSelection | null {
      const row = db.prepare("SELECT * FROM active_project_selection WHERE singleton_id = 'active' LIMIT 1").get() as
        | SelectionRow
        | undefined;
      if (!row) return null;
      return {
        projectId: asStringOrNull(row.project_id),
        source: asString(row.source),
        pinScope: asStringOrNull(row.pin_scope) as ProjectPinScope | null,
        selectedAt: asString(row.selected_at),
        updatedAt: asString(row.updated_at),
      };
    },

    selectProject(projectId: string, source: string, pinScope: ProjectPinScope | null = null): ActiveProjectSelection {
      ensureProjectExists(db, projectId);
      const timestamp = now();
      db.prepare(
        `INSERT INTO active_project_selection (singleton_id, project_id, source, pin_scope, selected_at, updated_at)
         VALUES ('active', ?, ?, ?, ?, ?)
         ON CONFLICT(singleton_id) DO UPDATE SET
           project_id = excluded.project_id,
           source = excluded.source,
           pin_scope = excluded.pin_scope,
           selected_at = excluded.selected_at,
           updated_at = excluded.updated_at`
      ).run(projectId, source, pinScope, timestamp, timestamp);
      const selection = this.getSelection();
      if (!selection) throw new Error("active project selection was not persisted");
      return selection;
    },

    clearSelection(source: string): ActiveProjectSelection {
      const timestamp = now();
      db.prepare(
        `INSERT INTO active_project_selection (singleton_id, project_id, source, pin_scope, selected_at, updated_at)
         VALUES ('active', NULL, ?, NULL, ?, ?)
         ON CONFLICT(singleton_id) DO UPDATE SET
           project_id = NULL,
           source = excluded.source,
           pin_scope = NULL,
           selected_at = excluded.selected_at,
           updated_at = excluded.updated_at`
      ).run(source, timestamp, timestamp);
      const selection = this.getSelection();
      if (!selection) throw new Error("cleared project selection was not persisted");
      return selection;
    },
  };
}

export type ProjectRegistryRepo = ReturnType<typeof createProjectRegistryRepo>;
