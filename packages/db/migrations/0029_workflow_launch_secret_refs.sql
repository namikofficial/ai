-- Persist approved secret names for protected desktop-side resolution.
-- Values are never stored in Workbench launch records.

ALTER TABLE workflow_launches
  ADD COLUMN environment_refs_json TEXT NOT NULL DEFAULT '[]';
