# Unified Workbench continuation plan

Updated: 2026-07-18

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
- Direct, isolated, and background workflows resolve manifest-approved names through a user-owned mode-0600 secret
  provider and redact resolved values before any result is persisted; desktop secret delivery remains blocked.
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

## Priority 1 — Complete workflow modes

Build on `workflow_executions` rather than adding another runner:

1. Add a protected desktop secret-delivery channel without returning values to APIs, logs, or caches.
2. Add approval-gated artifact cleanup without allowing arbitrary path deletion.
3. Add isolated artifact diff presentation without weakening the separate apply approval.

Acceptance evidence: API/CLI/Rofi integration tests for success, denial, approval replay, cancellation, timeout,
wrong-project invocation, secret redaction, process-tree cleanup, and restart recovery.

## Priority 2 — Explicit context consent and retrieval scope

Add durable per-session retrieval scope and explicit-file/clipboard inputs. Clipboard ingestion must require per-use
consent, show a redacted preview and token estimate, record only the consent decision/source hash by default, and
never enter desktop caches or logs. Add adversarial prompt-injection fixtures with untrusted-source labels.

## Priority 3 — Live desktop end-to-end proof

During an active Hyprland session, execute the full 15-step acceptance workflow using a representative registered
project. Capture focus-to-context, Git-to-Wayle, cache, reconnect, observer CPU/RSS, and rapid-focus results. Verify
editor, terminal, correlated tmux, transient windows, pinning, Rofi actions, scratchpad follow/pin behavior, deep
links, failed checks, Ask→Plan→Dev→Review→Memory, MCP/OpenCode resume, and Workbench/model/Qdrant/Docker offline
states. Record raw evidence in `HARDENING_REPORT.md`.

## Priority 4 — Python compatibility parity decisions

Exercise the importer against a real Python RAG database when one exists. Decide and test historical
`execution_runs` mapping, expose equivalent TypeScript MCP capability, compare retrieval evaluations, and retain the
Python store until row-count/content-hash parity and rollback rehearsal pass. Do not delete Python or Qdrant data.

## Priority 5 — Retire duplicate desktop ownership

Only after priorities 1–4 pass, disable legacy Kage status probes and hard-coded action cases by default. Preserve a
documented offline rollback switch for one release, verify no canonical mutation can occur through the legacy path,
then remove obsolete adapters in a separate change.

## Required release commands

```bash
cd /home/namik/Documents/code/ai
pnpm lint
pnpm typecheck
pnpm test:fast

cd /home/namik/Documents/code/dotfiles
./setup/check-local.sh
./setup/test-workbench-desktop.sh
./setup/test-workbench-actions.sh
python3 -m unittest setup/test-workbench-notification-bridge.py
python3 -m unittest setup/test-workbench-workflow-launch.py
```
