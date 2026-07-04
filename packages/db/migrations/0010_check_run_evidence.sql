-- Persist parsed check evidence alongside the existing stdout/stderr columns
-- so /checks/execute callers can render the full RunAllowedCommandResult
-- (parsed errors, affected files, duration) without re-running the check.

ALTER TABLE check_runs ADD COLUMN duration_ms INTEGER;
ALTER TABLE check_runs ADD COLUMN parsed_errors_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE check_runs ADD COLUMN affected_files_json TEXT NOT NULL DEFAULT '[]';