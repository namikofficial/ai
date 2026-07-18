-- Bind approvals to the exact reviewed run context and remember the original branch.

ALTER TABLE execution_workspaces ADD COLUMN original_branch TEXT;
ALTER TABLE execution_approvals ADD COLUMN context_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_execution_approvals_context
  ON execution_approvals(run_id, status, context_hash);
