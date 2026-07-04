-- Store parsed check evidence alongside raw stdout/stderr.

ALTER TABLE execution_commands ADD COLUMN parsed_errors_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE execution_commands ADD COLUMN affected_files_json TEXT NOT NULL DEFAULT '[]';
