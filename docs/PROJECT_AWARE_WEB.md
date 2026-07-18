# Project-aware Workbench web shell

The web UI no longer treats Zustand as the owner of project selection. On startup it reads the durable Workbench registry selection; a direct project route synchronizes that project through `/context/selection` with source `workbench_route`. Zustand remains a local rendering cache only.

## Project deep links

```text
/projects/<project-id>
/projects/<project-id>/work
/projects/<project-id>/ask
/projects/<project-id>/planner
/projects/<project-id>/checks
/projects/<project-id>/dev
/runs/<run-id>
/approvals/<approval-id>
```

Ask, Planner, Checks, and Dev/Work initialize from the route project first, then the canonical selected project, then the first registered project only as an empty-state fallback. Explicit user changes inside a form remain local to that form until a route or project-selection action changes canonical state.

Ask, Planner, and Dev can additionally inherit a canonical `session` query parameter. Ask exposes context preview,
answer-to-plan and answer-to-memory actions; Planner carries the session into an approval-based development run.

The global shell shows a compact context strip with selected project, active task, model role, runtime state, index state, and pending approval. Failed, blocked, or offline status receives a visible warning border.

The project Work view groups current goal/task/progress/blocker, task graph, development runs, project-scoped checks and reviews, and next actions. The run route is diff-first: summary/approval controls, proposed diff, changed files, then checks and warnings. Pending execution approvals are projected into `ActiveWork.approvalId`; the approval route shows project, run, risk, reason and requested time. Approve/apply/reject/cancel remain gated by persisted run and approval state, so stale approvals fail rather than applying to a different state.

`/workflow-executions/:executionId` is the workflow-specific review surface. It reads canonical execution and
artifact-metadata endpoints and presents policy context, command or DAG step evidence, redacted output, safe artifact
metadata, approval controls, recovery history, and only the recovery choices snapshotted on the failed execution.
Workflow approval pages deep-link to this evidence rather than rendering raw execution JSON.

Desktop `open-ai-workbench.sh` reads the canonical XDG status cache and generates the corresponding project route. It starts Workbench when necessary and retains the root URL as an offline/cache-miss fallback.

## Current boundary

The Work cockpit uses existing sessions/tasks/dev runs/checks/reviews through adapters; a single durable active-work state machine and normalized event timeline remain Phase 7 work. Handoff and retrieval-explanation deep links still need dedicated route pages before the deep-link acceptance criterion is complete.

## Verification

```bash
pnpm typecheck
pnpm lint
node --experimental-strip-types --test tests/web.test.ts tests/api-client.test.ts
```
