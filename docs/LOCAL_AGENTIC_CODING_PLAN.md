# Local Agentic Coding Runtime Plan

Status: final implementation plan  
Related source of truth: `PLAN.md` section 26, `README.md` local agentic development commands  
Goal: turn the workbench from a local RAG, planning, trace, and MCP system into a safe local coding-agent runtime.

## 1. Blunt Current-State Assessment

The repository already has the right foundation:

- Local-first storage with SQLite, optional Qdrant, and replayable traces.
- A real Express API, Vite web dashboard, CLI, SSE, and MCP server.
- Ask/RAG, prompt compilation, model routing, retrieval context, session trace, memory, eval, and handoff infrastructure.
- Existing dev-agent scaffolding in `packages/dev-agent`.
- Existing execution primitives in `packages/execution-engine`.
- Existing dev-run persistence in `packages/db/migrations/0007_dev_runs.sql`.
- Existing CLI/web surfaces for `dev` runs.

The missing product-quality core is not another dashboard page. The missing core is a trustworthy loop:

```txt
goal -> context -> plan -> isolated workspace -> patch -> check -> repair -> diff -> approve -> apply
```

The system should not mutate the original repo until a run has produced a reviewable diff, stored check evidence, and received explicit approval when policy requires it.

## 2. Product Boundary

Keep the agentic coding runtime inside TypeScript packages. API, CLI, MCP, and web should call the same runtime instead of duplicating behavior.

The live repo already split the intended responsibilities this way:

- `packages/dev-agent`: orchestration of the dev workflow.
- `packages/execution-engine`: isolated workspaces, file safety, patch/file operations, command allowlisting, checks, diff, and apply.
- `packages/agent-protocol/src/dev.ts`: structured dev-agent schemas.
- `packages/db/src/repositories/dev-runs.ts`: dev-run persistence.
- `packages/db/src/repositories/execution.ts`: workspace, command, approval, and patch persistence.

Do not create a second parallel implementation unless the existing `dev-agent` and `execution-engine` packages are being intentionally renamed or consolidated. The near-term plan is to harden and complete the existing boundary.

## 3. Non-Negotiable Safety Rules

- Local-first by default. Cloud model routing remains disabled unless `AI_CLOUD_ENABLED=true`.
- No arbitrary shell execution from model output.
- Checks must resolve from project config or a hardcoded allowlist.
- File reads must stay inside the project root.
- File writes must stay inside the isolated workspace root until approval.
- Absolute paths, path traversal, malformed edits, and edits outside the planned scope are rejected.
- `.env`, secrets, lockfiles, migrations, auth, db, and package files require elevated approval or high-risk handling.
- Every run stores plan, edits, workspace info, commands, stdout, stderr, exit codes, diff, approvals, and final result.
- The original repo is touched only through an approval path.

## 4. Target Workflow

```txt
1. User starts a dev run from CLI, API, web, or MCP.
2. Runtime resolves the project and creates a session/dev_run row.
3. Retrieval/context agents gather exact files, chunks, symbols, prior checks, and project rules.
4. Planner creates a small scoped plan with likely files, checks, and risk.
5. Execution engine creates `runtime/dev-runs/<run-id>/workspace`.
6. Editor produces structured edits only.
7. Execution engine validates and applies edits inside the workspace.
8. Checks run through allowlisted commands only.
9. Repair loop fixes check failures within the configured max repair count.
10. Runtime stores unified diff and patch records.
11. Runtime waits for approval when required.
12. Approval applies the workspace patch back to the original repo.
```

## 5. Runtime Directory Contract

Use this layout for each run:

```txt
runtime/dev-runs/<run-id>/
  workspace/
  patches/
  logs/
  checks/
  summary.json
```

Preferred workspace strategy:

```bash
git worktree add runtime/dev-runs/<run-id>/workspace -b ai/dev/<run-id>
```

Fallback when the project is not a Git repo:

```bash
rsync -a --exclude node_modules --exclude .git <project>/ runtime/dev-runs/<run-id>/workspace/
```

## 6. Required Internal Tools

The coding agent needs low-level repo tools, but they must remain internal to the runtime and safety layer:

```ts
readFile(projectId, path)
listFiles(projectId, glob)
searchText(projectId, query)
writeFile(workspaceId, path, content)
applyPatch(workspaceId, patch)
getDiff(workspaceId)
```

Rules:

- Never read outside the project root.
- Never write outside the workspace root.
- Store before/after diff for each edit.
- Block high-risk files unless policy permits them.
- Prefer structured filesystem APIs and existing safety helpers over ad hoc path handling.

## 7. Real Check Execution

`ai_run_check` and dev-run checks must execute real allowlisted commands, not only record intent.

The execution engine should expose:

```ts
runAllowlistedCheck(input: {
  workspacePath: string;
  checkName: "typecheck" | "test" | "lint" | "build" | "cargo-check" | "cargo-test" | "cargo-clippy";
  command: string;
  timeoutMs: number;
}): Promise<CheckResult>
```

Store:

- command
- exitCode
- stdout
- stderr
- durationMs
- parsedErrors
- affectedFiles

Default supported commands:

```txt
pnpm typecheck
pnpm test
pnpm lint
pnpm build
cargo check
cargo test
cargo clippy
```

Project-specific checks should come from `.ai-workbench.json`.

## 8. Agent Roles

Keep a planner to executor split. Do not ask one prompt to do everything.

- `planner_agent`: converts the goal into small tasks, predicted files, checks, and risk.
- `context_agent`: retrieves exact files, chunks, symbols, rules, and recent failures.
- `editor_agent`: returns structured edits only.
- `reviewer_agent`: checks patch scope, safety, and goal fit.
- `check_agent`: runs allowlisted checks and parses failures.
- `repair_agent`: fixes only check failures, capped by `maxRepairLoops`.

Every role should create an `agent_runs` row and attach messages/model calls where applicable.

## 9. Patch-Only Model Output

Coding model output should be validated JSON, not prose instructions:

```json
{
  "summary": "what changed",
  "files": [
    {
      "path": "apps/api/src/foo.ts",
      "action": "update",
      "patch": "*** Begin Patch\n..."
    }
  ],
  "checks": ["typecheck", "test"],
  "risk": "medium",
  "needsApproval": true
}
```

Reject:

- absolute paths
- path traversal
- shell commands inside patch payloads
- edits to blocked files without approval
- malformed patches
- files not included in the planned scope

Use Zod schemas in `packages/agent-protocol/src/dev.ts` or `packages/shared` before any edit is applied.

## 10. Model Profiles

Define model profiles by task:

- `query-rewrite-local`: small, fast rewrite model.
- `planner-fast-local`: small/medium planning model.
- `planner-deep-local`: larger local model or explicit cloud fallback.
- `dev-editor-local`: best local coding model.
- `dev-repair-local`: best local coding model, low temperature.
- `reviewer-local`: strict, low-temperature review model.
- `embedding-local`: fastembed or local embedding server.
- `rerank-local`: heuristic first, model rerank later.

Practical local coding models for RTX 4050 6GB:

- Qwen2.5-Coder 7B Q4_K_M
- Qwen3-Coder 4B/7B quant if available locally
- DeepSeek-Coder 6.7B Q4
- StarCoder2 7B Q4
- Gemma 3 4B for fast planning/summarization, not primary editing

## 11. Project Watch And Code Intelligence

Add:

```bash
ai project watch <project>
```

It should:

- watch changed files
- re-chunk changed files
- update SQLite FTS
- update vectors when Qdrant is enabled
- update symbols
- invalidate affected context packs

Use `chokidar`.

For code intelligence:

- Use `ts-morph` for TypeScript projects.
- Use Tree-sitter for generic multi-language parsing.
- Continue fallback parsing only as a degraded mode.

Index:

- exports
- imports
- routes
- controllers
- services
- repositories
- React components
- hooks
- Zod schemas
- tests
- package scripts

## 12. Data Model

The repo already has `0007_dev_runs.sql`. The final model should cover:

- `dev_runs`
- `dev_run_steps` or equivalent event/agent-run linkage
- `dev_run_files` or `dev_edits`
- `dev_run_patches` or `patches`
- `dev_run_checks` or `execution_commands`
- `dev_run_approvals` or `execution_approvals`
- `dev_run_repairs`

Minimum fields:

- run id
- session id
- project id
- goal
- status
- workspace path
- branch name
- base commit
- risk
- approval status
- created at
- updated at
- final diff

Do not let dev runs live only as loose runtime files. SQLite is the source of truth.

## 13. CLI Contract

These commands are the first complete user-facing surface:

```bash
pnpm cli -- dev "fix auth middleware bug" --project noxcrm --checks typecheck,test
pnpm cli -- dev runs
pnpm cli -- dev show <run-id>
pnpm cli -- dev diff <run-id>
pnpm cli -- dev approve <run-id>
pnpm cli -- dev cancel <run-id>
```

The CLI should call the same dev-agent runtime as API/web/MCP. It may use the local store directly only when the API server is not running.

## 14. MCP Contract

Expose dev-agent through safe MCP tools only after CLI/API behavior is real:

```txt
ai_dev_start
ai_dev_status
ai_dev_diff
ai_dev_approve
ai_dev_cancel
ai_dev_run_check
```

Do not expose raw shell or unrestricted write tools.

## 15. Web Contract

The web surface should help review and approve runs, not hide the runtime evidence:

- Project selector
- Goal input
- Mode selector
- Approval policy selector
- Live event stream
- Plan panel
- Retrieved context panel
- Proposed edits panel
- Diff panel
- Checks panel
- Repair attempts panel
- Approve / cancel controls

UI comes after the runtime is trustworthy.

## 16. Recommended Build Order

1. Align documentation: fix `PLAN.md`/`README.md` inconsistencies such as Express vs Fastify and "implemented" vs "planned" dev-agent claims.
2. Audit existing `packages/dev-agent` and `packages/execution-engine` against this plan.
3. Add missing typed models and Zod validation for dev plans, edits, patches, checks, approvals, and repair outputs.
4. Complete isolated workspace creation and cleanup behavior.
5. Complete file read/list/search/write/applyPatch/diff helpers with path policy tests.
6. Replace any check-record-only flow with real allowlisted command execution.
7. Make the dev workflow work without model editing: create run, create workspace, run checks, show diff.
8. Add model-generated patch proposal with strict output validation.
9. Add reviewer gate before applying patches in the workspace.
10. Add repair loop for check failures.
11. Complete CLI commands.
12. Complete API routes.
13. Complete MCP dev tools.
14. Complete web Dev Runs page.
15. Add project watch mode.
16. Add `ts-morph` and Tree-sitter-backed code intelligence.

## 17. First Implementation Prompt

Use this prompt for the first coding-agent pass:

```text
You are working in the namikofficial/ai repository.

Goal: implement the first safe local dev-agent foundation without autonomous original-repo edits yet.

Use the existing packages/dev-agent and packages/execution-engine boundaries. Do not create a parallel dev-engine package unless you are intentionally renaming the current implementation.

Build or harden:
- typed DevRun, DevRunStatus, DevRunStep, DevRunCheckResult, DevRunPatchSummary models
- createDevRun()
- createIsolatedWorkspace()
- getWorkspaceDiff()
- runAllowlistedCheck()
- cancelDevRun()

Constraints:
- Do not let any path escape the project root or workspace root.
- Do not run arbitrary shell commands from model output.
- Checks must come from project config or a hardcoded allowlist.
- Store stdout/stderr/exitCode/duration for each check.
- Do not apply changes to the original project yet.
- Add tests for path escape blocking and check allowlist blocking.
- Keep the API/CLI surface minimal; do not build more UI yet.

After implementation, run:
pnpm typecheck
pnpm test
```

## 18. Done Criteria

The plan is complete when:

- A dev run can be started from CLI.
- It creates an isolated workspace.
- It can inspect and patch files only inside that workspace.
- It runs real allowlisted checks and stores stdout/stderr/exit codes.
- It can repair a check failure within a configured loop limit.
- It produces a reviewable diff.
- It requires approval before mutating the original repo when policy requires it.
- Approval applies the patch to the original repo.
- The same run is inspectable from SQLite, CLI, API, MCP, and web.
- `pnpm typecheck` and `pnpm test` pass.

