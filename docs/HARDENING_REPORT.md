# Phase 11 hardening report

Date: 2026-07-18  
Workbench revision at measurement: `0f0dd93` plus the uncommitted Phase 10/11 working tree  
Host: 13th Gen Intel Core i7-13620H, Linux, Asia/Kolkata

This report records reproducible evidence, not universal performance promises. The live rehearsal used an isolated
12 KiB SQLite database, disabled optional model/embedding endpoints, a temporary cache, and a terminal-launched API
on `127.0.0.1:55417`. It did not read or mutate the canonical Workbench database.

## Security hardening

- Approvals are single-use transitions bound to run ID, project ID, exact diff, sorted changed paths, base commit,
  and original branch.
- Apply refuses unapproved runs, stale review context, project/workspace confusion, a changed target commit or
  branch, dirty reviewed paths, and workspace/target symlinks.
- Project reads, writes, edits, removals, and text search now reject symlink components and canonical-root escapes.
- Safe-copy workspaces skip repository symlinks instead of following them.
- The complete threat inventory and remaining clipboard/MCP-authentication gaps are documented in
  [SECURITY_THREAT_MODEL.md](./SECURITY_THREAT_MODEL.md).

## Performance sample

Measured with `AI_PERFORMANCE_SAMPLES=25 ./scripts/measure-runtime.sh`:

| Metric | Result | Notes |
|---|---:|---|
| API startup to listening | approximately 1.2 s | Observed by the isolated process harness; includes Node module load and migrations. |
| `/ready` median | 0.599 ms | 25 loopback requests. |
| `/project-status/compact` median | 31.671 ms | 25 requests against one selected empty Git project; includes canonical aggregation/cache refresh. |
| Status cache read/validation median | 4 ms | 25 `jq` validations of a 2,918-byte cache. This includes process startup and is a conservative client-side measurement. |
| API idle CPU | 0.000% | One-second `/proc` sample after requests completed. |
| API resident memory | 151,660 KiB | Terminal API process only; worker/web UI/optional runtimes excluded. |

The stopped-service sample reported `api.ready=false`, `null` API latency, no process PID, and a missing cache
without malformed output. `measure-runtime.sh` supports supervised and tmux/terminal PIDs and remains read-only.

## Recovery rehearsal

1. Started the API against a disposable database and created a project.
2. Stopped the process cleanly.
3. Restarted against the same database, selected and persistently pinned the project, and generated compact status.
4. Stopped and restarted a second time.
5. Verified `/context/selection` retained the exact project ID and `/project-status/compact` returned that project.
6. Verified optional model and embedding endpoints could remain offline throughout.

The automated suite separately covers core readiness with optional runtimes offline, cache fallback contracts,
SSE cursor replay, migration idempotency, consistent SQLite backup, guarded restore validation, and Python RAG
backup-first import.

## Verification

```text
pnpm lint       -> 199 files, zero errors or warnings
pnpm typecheck  -> passed
pnpm test:fast  -> 349/349 passed
shellcheck scripts/measure-runtime.sh -> passed
bash -n scripts/measure-runtime.sh    -> passed
```

## Measurements still requiring a live desktop

The following cannot be claimed from a headless/inactive Hyprland observer and remain manual release gates:

- editor focus to canonical context latency;
- terminal/tmux focus correlation latency;
- Git filesystem change to Workbench cache and Wayle update latency;
- rapid focus switching and transient-window hysteresis under the actual compositor;
- observer and notification-bridge idle CPU/RSS;
- SSE/desktop reconnect after a real supervised Workbench restart.

Use the procedure in [RUNTIME_SUPERVISION.md](./RUNTIME_SUPERVISION.md) during the next active graphical session,
attach the raw JSON and timestamps, and record repository size and revision. Do not mark the complete Phase 11
performance gate finished until those desktop measurements pass.
