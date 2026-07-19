# Unified Workbench continuation plan

Updated: 2026-07-20

The repositories are coherent and verified, but the complete product objective is not yet proven. This document
lists concrete remaining gates rather than treating compatibility slices as finished phases.

## Completed and verified ownership slices

- Versioned control-plane contracts and SQLite-backed project registry/selection.
- Approved manifest import/diff/proposal/export and legacy profile import.
- Desktop observation, deterministic context evidence/rejection, pinning, and offline caches.
- Git/Compose/package-manager status aggregation and compact Wayle payload.
- Project-aware Workbench routes, Work view, diff-first run review, readable timelines, shared sessions/context.
- Runtime supervision, readiness/diagnostics, SSE replay, notifications, backup/restore, and Python RAG importer.
- Exact-context approval binding for mutating workflows, canonical path/symlink enforcement, direct supervised
  execution, process-tree cancellation, CLI controls, Workbench review, and Rofi approval deep links.
- MCP action list/run/status/cancel tools proxy the canonical loopback API, enforce explicit project/session/task
  scope, remain audit logged, and deliberately cannot self-approve.
- Interactive workflows use a durable `WorkflowLaunch` handoff, short-lived hashed capabilities, structured Kitty/tmux
  desktop launching, lifecycle callbacks, process-group cancellation, and canonical context environment identifiers.
- Manifest commands now own a backward-compatible `executionMode`; isolated workflows remap execution into a retained
  Git-worktree/safe-copy workspace and expose that workspace as a review artifact without touching the original tree.
- Background workflows use a durable queue association, worker-side canonical revalidation, tracked process groups,
  queued/running cancellation, and fail-safe restart recovery that never silently replays possible side effects.
- All workflow modes resolve only manifest-approved secret names through a user-owned mode-0600 provider. Desktop
  launches persist names only; their helper resolves values locally into a reduced child environment, while API
  responses, capability files, lifecycle calls, logs, SQLite and caches remain value-free.
- Read-only workflow retries are bounded, abort-aware, and attempt-audited; mutating retries are rejected. Required
  artifacts are type- and containment-validated and become canonical execution artifacts.
- Approved manifest commands synchronize into canonical SQLite workflow definitions. Manual definitions take
  precedence, action execution consumes them, and structural validation rejects ambiguous or cyclic DAGs.
- Workflow DAGs execute in topological order with aggregate approval binding, durable per-step evidence, shared
  isolation, background supervision, check projection, downstream blocking, and cancellation without retry.
- Failed, blocked, and cancelled workflow executions expose only their snapshotted recovery allowlist. Recovery runs
  preserve causation, reapply canonical policy and approvals, and are available through API and CLI. Workflow
  artifacts have a metadata-only inspection endpoint that redacts paths outside approved project/runtime roots.
- Workflow review now presents canonical policy, DAG evidence, redacted output, safe artifact metadata, approval
  controls, recovery history, and recovery actions. `ActiveWork` projects workflow execution/recovery identity into
  the shared status cache, and Rofi uses only those fields plus the canonical API for review and recovery.
- Sessions now own a durable context scope used by preview and Ask. Browser and CLI can edit it, MCP can inspect it,
  explicit files pass root/secret/exclusion checks, and retrieval/memory/rules/conversation flags and token ceilings
  are enforced during packing. Clipboard context requires a redacted preview and exact-hash one-use consent; raw
  clipboard and clipboard-derived answers are omitted from durable prompts, calls, events, messages, and caches.
- Isolated workflow review now includes tracked and untracked workspace diffs with secret-path exclusion and bounded
  output. Cleanup has a dedicated SQLite approval lifecycle bound to the exact execution workspace, artifact set and
  reviewed diff hash; stale, mismatched and replayed approvals fail closed. API, CLI and Workbench expose explicit
  request/approve/keep controls, and cleanup never accepts a caller-supplied deletion path.

## Priority 1 — Complete workflow modes

Build on `workflow_executions` rather than adding another runner:

1. Completed: protected desktop secret delivery without returning values to APIs, logs, SQLite or caches.
2. Completed: approval-gated artifact cleanup without caller-supplied deletion paths.
3. Completed: isolated artifact diff presentation without weakening the separate apply approval.

Acceptance evidence: API/CLI/Rofi integration tests for success, denial, approval replay, cancellation, timeout,
wrong-project invocation, secret redaction, process-tree cleanup, and restart recovery.

## Priority 2 — Explicit context consent and retrieval scope

Completed: the durable scope, active/changed/explicit-file enforcement, one-use clipboard preview/consent, browser
controls, CLI controls, and read-only MCP scope inspection are implemented. Preview items expose explicit provenance
trust and cannot grant approval; browser context/citation surfaces label untrusted evidence. Model-bound repository
content is JSON-encoded under an evidence-only warning, and adversarial TypeScript, Python, Markdown, generated-output,
retrieval, project-confusion, secret-exfiltration and stale-approval fixtures are covered. Clipboard durable-record
sanitization is compiled independently from ephemeral model context rather than relying on string replacement.

## Priority 3 — Live desktop end-to-end proof

During an active Hyprland session, execute the full 15-step acceptance workflow using a representative registered
project. Capture focus-to-context, Git-to-Wayle, cache, reconnect, observer CPU/RSS, and rapid-focus results. Verify
editor, terminal, correlated tmux, transient windows, pinning, Rofi actions, scratchpad follow/pin behavior, deep
links, failed checks, Ask→Plan→Dev→Review→Memory, MCP/OpenCode resume, and Workbench/model/Qdrant/Docker offline
states. Record raw evidence in `HARDENING_REPORT.md`.

The 2026-07-20 live rehearsal installed all six user units, registered an approved representative Dotfiles manifest,
proved persistent pin/unpin and wrong-editor-CWD rejection, measured a 405 ms file-event-to-cache update, rendered
all four Wayle chips, verified optional-runtime degradation, and recovered API plus worker after a target restart.
The rehearsal also fixed systemd shell-path, duplicate API ownership, worker recovery, watcher spin, Hyprland socket,
timestamp, event-noise, active-cache race, and unresolved-cache defects. Editor active-file hints, positively
correlated tmux, scratchpad/deep-link/check propagation, quiet observer CPU, and the complete 15-step AI workflow
remain unproven; see `HARDENING_REPORT.md`.

## Priority 4 — Python compatibility parity decisions

Exercise the importer against a real Python RAG database when one exists. Historical `execution_runs` now have a
tested provenance-only mapping because the legacy schema cannot prove canonical workspace, diff, approval or apply
semantics. The 27 legacy Python MCP tools now have an explicit canonical capability map, and a real JSON-RPC client
test covers project selection, active context, status, runtime health, memory and retrieval explanation. Rehearse the
mapping through installed OpenCode/Codex clients, compare retrieval evaluations, and retain the Python store until
row-count/content-hash parity and rollback rehearsal pass. Do not delete Python or Qdrant data.

The documented and legacy source locations were rechecked on 2026-07-18; no Python RAG SQLite database exists, so a
real-data dry run remains unavailable and is not claimed. Dedicated handoff and retrieval-explanation routes are now
implemented independently, including project synchronization and a readable why-selected/ranked/dropped view.
Ephemeral Workbench servers now isolate all registry/context/status caches beneath their runtime directory, and
embedded callers can supply an explicit desktop cache directory. This prevents tests and client rehearsals from
overwriting the real desktop fallback cache without changing normal XDG production behavior.

## Priority 5 — Retire duplicate desktop ownership

Only after priorities 1–4 pass, disable legacy Kage status probes and hard-coded action cases by default. Preserve a
documented offline rollback switch for one release, verify no canonical mutation can occur through the legacy path,
then remove obsolete adapters in a separate change.

The standalone `project-profile` duplicate has now been removed: the desktop command resolves IDs, names, aliases,
paths and tmux session names from the canonical registry/API or its read-only XDG cache. Development and verification
commands resolve approved Workbench actions and fail closed while offline; the adapter no longer owns project paths,
commands or pane layouts. Its regression test covers offline reads, canonical pinning, workflow routing and manifest
tmux naming. A separately supervised, read-only inotify bridge now watches only the canonical cached project path,
prunes dependency/build/index trees, debounces file bursts and requests project-scoped status refreshes without
running Git or Docker on the desktop. The remaining duplicate is the explicitly retained Kage rollback watcher,
pending live desktop parity.

The graphical observer/watcher/notification set now has a narrow dry-run/install/enable/status/uninstall helper, so
the live gate no longer requires running the full workstation bootstrap. Its regression test installs into an
isolated XDG configuration, verifies exact unit copies and daemon reload, then proves rollback removes only the three
known units.

## Required release commands

```bash
cd /home/namik/Documents/code/ai
pnpm lint
pnpm typecheck
pnpm test:fast

cd /home/namik/Documents/code/dotfiles
./setup/check-local.sh
./setup/test-project-profile.sh
./setup/test-workbench-desktop.sh
./setup/test-workbench-desktop-services.sh
./setup/test-workbench-actions.sh
python3 -m unittest setup/test-workbench-project-watch.py
python3 -m unittest setup/test-workbench-notification-bridge.py
python3 -m unittest setup/test-workbench-workflow-launch.py
```
