-- Extend the legacy event envelope into the versioned Workbench event contract.
-- Existing rows remain readable through compatibility defaults.

ALTER TABLE agent_events ADD COLUMN run_id TEXT;
ALTER TABLE agent_events ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_events ADD COLUMN source_service TEXT NOT NULL DEFAULT 'workbench';
ALTER TABLE agent_events ADD COLUMN severity TEXT NOT NULL DEFAULT 'info';
ALTER TABLE agent_events ADD COLUMN summary TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_events ADD COLUMN correlation_id TEXT;
ALTER TABLE agent_events ADD COLUMN causation_id TEXT;

UPDATE agent_events
SET source_service = COALESCE(NULLIF(agent, ''), 'workbench'),
    severity = CASE level WHEN 'warn' THEN 'warning' ELSE level END,
    summary = REPLACE(type, '.', ' '),
    correlation_id = COALESCE(session_id, project_id, id)
WHERE summary = '' OR correlation_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_agent_events_run_ts ON agent_events(run_id, ts);
CREATE INDEX IF NOT EXISTS idx_agent_events_correlation_ts ON agent_events(correlation_id, ts);
