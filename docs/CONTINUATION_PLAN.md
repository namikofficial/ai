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

## Priority 1 — Complete workflow modes

Build on `workflow_executions` rather than adding another runner:

1. Implement terminal and tmux adapters carrying canonical project/session/task/run identifiers.
2. Implement isolated and background modes, dependencies/retries, expected artifacts, and restart recovery.
3. Resolve environment references from an approved secret provider without returning values to logs/caches.
4. Add MCP tools for action list/run/status with the same mutating/read-only boundaries.
5. Add recovery workflows and artifact inspection to workflow reviews.

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
```
