# Canonical event architecture

Workbench SQLite owns normalized event history. Producers persist one `EventEnvelope`, which is a backward-compatible representation of the versioned `WorkbenchEvent` contract. Store subscribers fan the same persisted object to SSE; individual routes do not own a second event bus.

```mermaid
flowchart LR
  P[API / worker / MCP producer] --> C[createEvent]
  C --> DB[(agent_events in SQLite)]
  DB --> S[Store event subscribers]
  S --> SSE[/events/stream]
  SSE --> Web[Workbench web]
  SSE --> N[Desktop notification bridge]
  SSE --> Other[CLI and local clients]
  N --> Cursor[XDG reconnect cursor]
  N --> Desktop[Wayle / notify-send]
```

## Normalized envelope

Every newly produced event includes:

- schema version, stable event ID, creation/update/occurrence timestamps;
- project, session, task and run IDs where relevant;
- origin and source service;
- normalized severity and human summary;
- structured payload;
- correlation and optional causation IDs;
- compatibility aliases (`ts`, `level`, `agent`) used by existing clients during migration.

Migration `0016_normalized_events.sql` adds the durable normalized columns and backfills legacy rows without deleting history. `parseEventEnvelope` upgrades old JSON clients at the boundary, and the public `WorkbenchEvent` validator accepts newly created envelopes.

Development-run events now flow through the same store for API and MCP execution. A run uses its run ID as the correlation ID, while each event points to the previous event as its causation ID. Approval records are created before `approval.required` is emitted, so deep links resolve to durable approvals.

## SSE and reconnect

`GET /events/stream` supports both `?since=<event-id-or-timestamp>` and the standard `Last-Event-ID` header. Frames contain an SSE `id`, JSON `data`, a two-second retry hint, and 15-second heartbeat comments. Native browser `EventSource` therefore reconnects with its last event ID automatically.

Event-ID recovery uses SQLite row order as a tiebreaker, preventing loss when two events share the same timestamp. Clients without a cursor should use their connection timestamp when they do not want historical replay.

The API subscribes once to store persistence. Its bounded duplicate filter allows legacy route-level publish calls to coexist during migration without sending the same event twice.

## Desktop notification policy

The desktop bridge consumes canonical SSE and stores only a versioned, mode-0600 reconnect/health cursor under the XDG cache. It never owns event history.

Notifications are limited to:

- approval requested;
- development run completed or failed;
- check failed;
- manually requested indexing completed;
- failed or blocked tasks;
- runtime degradation.

The bridge reads Wayle DND state before notifying. `AI_WORKBENCH_NOTIFICATIONS_ENABLED=false` disables notifications while continuing cursor processing. Supported notification daemons expose an Open action to the related approval, run, task, checks page, or project. Older `notify-send` implementations receive a normal notification without actions.

Bridge logs are structured JSON and deliberately contain IDs, event type, error code and safe metadata only—not full prompts, clipboard data, environment values, secrets, or event payloads.

## Diagnostics

```bash
ai diagnose
ai runtime status
curl -fsS http://127.0.0.1:4417/diagnostics | jq
```

Diagnostics return core health, normalized runtime health, live event-stream connection count and up to 20 recent failure summaries. Payload contents are excluded.
