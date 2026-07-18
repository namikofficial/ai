# Project-aware Workbench web shell

The web UI no longer treats Zustand as the owner of project selection. On startup it reads the durable Workbench registry selection; a direct project route synchronizes that project through `/context/selection` with source `workbench_route`. Zustand remains a local rendering cache only.

## Project deep links

```text
/projects/<project-id>
/projects/<project-id>/work
/projects/<project-id>/ask
/projects/<project-id>/planner
/projects/<project-id>/checks
/runs/<run-id>
```

Ask, Planner, Checks, and Dev/Work initialize from the route project first, then the canonical selected project, then the first registered project only as an empty-state fallback. Explicit user changes inside a form remain local to that form until a route or project-selection action changes canonical state.

The global shell shows a compact context strip with selected project, active task, model role, runtime state, index state, and pending approval. Failed, blocked, or offline status receives a visible warning border.

The project Work view groups current goal/task/progress/blocker, task graph, development runs, project-scoped checks and reviews, and next actions. The run route is diff-first: summary/approval controls, proposed diff, changed files, then checks and warnings. Approve, apply, and cancel remain gated by the persisted run state.

Desktop `open-ai-workbench.sh` reads the canonical XDG status cache and generates the corresponding project route. It starts Workbench when necessary and retains the root URL as an offline/cache-miss fallback.

## Current boundary

The Work cockpit uses existing sessions/tasks/dev runs/checks/reviews through adapters; a single durable active-work state machine and normalized event timeline remain Phase 7 work. Approval, handoff, and retrieval-explanation deep links still need dedicated route pages before the deep-link acceptance criterion is complete.

## Verification

```bash
pnpm typecheck
pnpm lint
node --experimental-strip-types --test tests/web.test.ts tests/api-client.test.ts
```
