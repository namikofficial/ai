# AI Workbench Implementation Plan

Status: living plan
Purpose: this file is the single source of truth for the new `ai` repository until the first useful version is complete.

How to use this file:
- Read it before every implementation session.
- Follow the phases in order.
- Do not widen scope unless the current slice is done.
- Update the checklist and notes after each completed step.
- If a step is blocked, leave the blocker explicit and continue with the next unblocked item.

## 1. Product Goal

Build a local-first AI engineering workbench for real production use on Namik's workstation:
- Web harness is the main UI.
- CLI is the second main interface.
- MCP support comes after the web/API/CLI core is stable.
- TUI is deferred until later.
- Local RAG is copied from dotfiles and rewritten into a TypeScript-first product boundary.
- Persistent observability, safe execution, and session traceability are first-class.
- The system must be useful for real repo work: ask, research, plan, handoff, check, learn, and debug.

Core user outcomes:
- Open the web app and see active sessions, task progress, retrieval results, model usage, and repo health.
- Ask questions about a selected repo and get cited answers from local context.
- Generate a task graph and handoff prompt for an external coding agent.
- Run allowlisted checks and store failures as durable memory.
- Keep lessons and retrieval quality improving over time.

## 2. Non-Negotiable Product Decisions

- TypeScript owns the product boundary.
- Web, API, CLI, MCP, shared schemas, and orchestration should live in the Node/TS monorepo.
- Python is not the product surface anymore.
- If any Python remains, it should be isolated behind a worker boundary or temporary compatibility layer.
- SQLite is the source of truth for local state.
- Qdrant is optional and must have a SQLite FTS fallback.
- SSE is the default live event transport.
- No arbitrary shell execution from LLM output.
- No destructive commands without explicit manual approval.
- No TUI in MVP1.
- No autonomous editing in MVP1.

## 3. Target Architecture

### 3.1 High-level layers

1. `apps/web`
   - React UI.
   - Main cockpit for sessions, projects, retrieval, checks, memory, and models.
   - Subscribes to live session events via SSE.

2. `apps/api`
   - Fastify API.
   - Owns auth-lite, session orchestration, project management, ask/research/plan/handoff endpoints, event stream, and persistence APIs.
   - Emits typed events and writes all durable state to SQLite.

3. `apps/worker`
   - Background jobs for indexing, retrieval refresh, model calls, checks, and summaries.
   - Can run in-process in MVP1 if needed, but the boundary should already exist.

4. `packages/shared`
   - Shared Zod schemas, enums, event envelopes, API payloads, and common types.

5. `packages/api-client`
   - Typed client for web and CLI.

6. `packages/ui`
   - Shared UI primitives, layout shell, event stream components, trace drawers, and command palette components.

7. `packages/agent-protocol`
   - Agent/task graph contracts, event names, handoff payloads, and session trace schemas.

8. `packages/db`
   - SQLite schema, migrations, repository helpers, and persistence utilities.

9. `python/ai_core`
   - Temporary home for ported RAG logic if any Python survives the migration phase.
   - This should shrink over time, not grow.

10. `cli/ai`
   - The `ai` CLI entrypoint.
   - Should call the API, not duplicate orchestration logic.

11. `mcp/server`
   - Safe, allowlisted MCP tools only.
   - No raw shell tool by default.

12. `runtime`
   - Ephemeral session files, handoff packets, exports, logs, caches, and active task graph state.

## 4. Exact Folder Structure

```txt
ai/
├── apps/
│   ├── web/
│   ├── api/
│   └── worker/
├── packages/
│   ├── shared/
│   ├── api-client/
│   ├── ui/
│   ├── config/
│   ├── agent-protocol/
│   └── db/
├── python/
│   └── ai_core/
│       ├── rag/
│       ├── indexer/
│       ├── retrieval/
│       ├── embeddings/
│       ├── models/
│       ├── agents/
│       ├── tools/
│       └── observability/
├── cli/
│   └── ai/
├── mcp/
│   └── server/
├── runtime/
│   ├── agent/
│   ├── cache/
│   ├── exports/
│   └── logs/
├── docs/
├── scripts/
├── tests/
├── docker-compose.yml
├── package.json
├── pnpm-workspace.yaml
├── pyproject.toml
└── README.md
```

## 5. What To Copy From Dotfiles

### 5.1 Copy directly, then adapt

These files contain durable logic worth porting into the new architecture:

- `system/rag/retrieval.py`
- `system/rag/indexing.py`
- `system/rag/memory.py`
- `system/rag/llm.py`
- `system/rag/code_intel.py`
- `system/rag/rerank.py`
- `system/rag/workflow_policy.py`
- `system/rag/model_registry.py`
- `system/rag/runtime.py`
- `system/rag/types.py`
- `system/rag/task_graph.py`
- `system/rag/contracts.py`
- `system/rag/orchestrator.py`
- `system/rag/state.py`
- `system/rag/learning.py`
- `system/rag/profile.py`
- `system/rag/profiles.py`
- `system/rag/run_trace.py`
- `system/rag/outcomes.py`

### 5.2 Copy as reference material, not as final product

These are good source docs and prompt assets, but they should be rewritten into the new repo voice and structure:

- `ai/system/GLOBAL_SYSTEM.md`
- `ai/system/PROJECT_SYSTEM_TEMPLATE.md`
- `ai/system/TASK_PROMPT_TEMPLATE.md`
- `ai/templates/code-agent.md`
- `ai/templates/rag-answer.md`
- `ai/templates/query-rewrite.md`
- `ai/templates/tool-router.md`
- `ai/skills/rag-diagnosis.md`
- `ai/skills/local-ai-runtime-debug.md`
- `ai/skills/code-review.md`
- `ai/mcp/README.md`
- `ai/mcp/codex-mcp.example.toml`
- `ai/mcp/mcp.servers.example.json`
- `ai/mcp/opencode-mcp.example.json`

### 5.3 Rewrite instead of copying

- `system/rag/cli.py` -> new TypeScript CLI in `cli/ai`
- `system/rag/server.py` -> new Fastify API in `apps/api`
- `system/rag/mcp_server.py` -> new safe MCP server in `mcp/server`
- `system/rag/app.py` -> obsolete; replace with web/API entrypoints
- `system/rag/commands.py` -> reworked into typed command helpers
- `system/rag/prompt_compiler.py` -> rewritten for the new agent protocol
- `system/rag/router.py` -> rewritten for TS routing and agent selection
- `system/rag/settings.py` -> rewritten around the new product config model
- `system/rag/storage.py` -> rewritten as `packages/db`
- `system/rag/cli.py` argument parser surface -> replaced by TS command definitions

## 6. Product Surfaces

### 6.1 Web pages

Required routes:

- `/dashboard`
- `/projects`
- `/projects/:id`
- `/sessions`
- `/sessions/:id`
- `/tasks/:id`
- `/ask`
- `/research`
- `/planner`
- `/handoff`
- `/checks`
- `/memory`
- `/retrieval`
- `/models`
- `/mcp`
- `/settings`

### 6.2 Web UX requirements

Layout:
- Left sidebar.
- Top project selector.
- Live session indicator.
- Main content area.
- Right-side trace/context drawer.
- Dense compact panels.
- Dark mode first.

Interactions:
- Command palette with `Cmd/Ctrl + K`.
- Global navigation shortcuts:
  - `g d` dashboard
  - `g p` projects
  - `g s` sessions
  - `g a` ask
  - `g r` research
  - `g m` memory
  - `g c` checks
- `Esc` closes drawers and dialogs.

### 6.3 Dashboard page

Show:
- Active sessions.
- Recent sessions.
- Model server status.
- Qdrant status.
- SQLite status.
- MCP server status.
- Indexed projects.
- Failed checks.
- Recent lessons.
- Token/model usage summary.

### 6.4 Projects page

Show:
- Project path.
- Language/framework detection.
- Last indexed time.
- Document count.
- Chunk count.
- Embedding status.
- Git branch.
- Dirty state.
- Repo health.

Actions:
- Add project.
- Reindex project.
- Open project dashboard.
- View memory.
- View retrieval stats.

### 6.5 Project detail page

Show:
- Repo summary.
- Detected stack.
- Important files.
- Recent git changes.
- Indexed documents.
- Retrieval quality.
- Previous sessions.
- Project lessons.
- Project rules.

### 6.6 Ask page

Features:
- Project selector.
- Question input.
- Local-only/cloud toggle.
- Retrieval depth selector.
- Context preview before answer.
- Answer with citations.
- Source chunks list.
- Confidence indicator.
- Save answer as note/lesson.

### 6.7 Research page

Features:
- Topic input.
- Local-only, web, or hybrid mode.
- Source list.
- Credibility ranking.
- Contradiction detection.
- Summary.
- Final research brief.
- Save to project memory.

### 6.8 Planner page

Features:
- Project selector.
- Goal input.
- Risk level.
- Generated task graph.
- Expected files.
- Checks.
- Required approvals.
- Cloud/model recommendation.
- Edit-scope preview.

### 6.9 Session detail page

This is the most important page.

Show:
- Session status.
- Timeline.
- Task graph.
- Current active agent.
- Live events.
- Agent traces.
- Tool calls.
- Model calls.
- Retrieval events.
- Selected context.
- Generated handoff.
- Check results.
- Errors.
- Final summary.
- Lessons learned.

### 6.10 Handoff page

Features:
- Choose target: OpenCode, Codex, Manual, Clipboard, File.
- Show current subtask.
- Show selected context.
- Show constraints.
- Show files to inspect.
- Show files likely to edit.
- Show checks to run.
- Generate handoff prompt.
- Copy to clipboard.
- Save to runtime file.

### 6.11 Checks page

Show:
- Allowlisted checks.
- Recent check runs.
- Failed checks.
- Parsed errors.
- Affected files.
- Suggested next action.

### 6.12 Memory page

Show:
- Project lessons.
- Global lessons.
- Failed assumptions.
- Retrieval misses.
- Good patterns.
- Bad patterns.
- Pinned rules.

### 6.13 Retrieval page

Show:
- Search query.
- Vector results.
- Keyword results.
- Reranked results.
- Selected chunks.
- Missed files.
- Retrieval quality score.

### 6.14 Models page

Show:
- Local llama.cpp server status.
- Available local models.
- Current default model.
- Context window.
- Tokens/sec if available.
- Provider routing rules.
- Cloud provider config status.
- Usage history.

### 6.15 MCP page

Show:
- MCP server status.
- Exposed tools.
- Recent MCP calls.
- Blocked MCP calls.
- Client connection notes.
- Safety policy.

### 6.16 Settings page

Show:
- Default project path.
- Local model endpoint.
- Qdrant endpoint.
- Database path.
- Cloud enabled/disabled.
- Provider keys status.
- Safety settings.
- Indexing settings.
- Retention settings.

## 7. API Design

### 7.1 API principles

- All request/response payloads must be schema-validated.
- Use Zod schemas shared with web and CLI.
- Keep routes small and obvious.
- Avoid multi-purpose endpoints.
- Every mutating action should create events.

### 7.2 Core routes

Health and metadata:
- `GET /health`
- `GET /version`
- `GET /config`

Projects:
- `GET /projects`
- `POST /projects`
- `GET /projects/:id`
- `POST /projects/:id/index`
- `POST /projects/:id/reindex`
- `GET /projects/:id/memory`
- `GET /projects/:id/retrieval`

Sessions:
- `GET /sessions`
- `GET /sessions/:id`
- `POST /sessions`
- `POST /sessions/:id/pause`
- `POST /sessions/:id/resume`
- `POST /sessions/:id/cancel`
- `POST /sessions/:id/retry`

Tasks:
- `GET /tasks/:id`
- `POST /tasks`
- `POST /tasks/:id/start`
- `POST /tasks/:id/complete`
- `POST /tasks/:id/fail`

Ask / research / plan:
- `POST /ask`
- `POST /research`
- `POST /plan`

Handoffs:
- `POST /handoff`
- `GET /handoffs/:id`

Checks:
- `GET /checks`
- `POST /checks/run`
- `GET /checks/:id`

Retrieval:
- `POST /retrieval/search`
- `POST /retrieval/explain`
- `POST /retrieval/context`

Memory:
- `GET /memory`
- `POST /memory/lesson`
- `POST /memory/reflect`

Models and MCP:
- `GET /models`
- `GET /mcp`
- `GET /mcp/calls`

Events:
- `GET /events/stream`
- `GET /sessions/:id/events`

### 7.3 API conventions

- IDs are stable opaque strings.
- Timestamps are ISO strings in API responses.
- Responses should include `status`, `data`, and `error` only when needed.
- Error payloads should be structured and user-readable.
- Long-running actions should return a created session/job reference immediately.

## 8. Database Schema

Use SQLite first. Keep migrations explicit and versioned.

### 8.1 Core tables

Projects:
- `projects`
  - `id`
  - `name`
  - `path`
  - `repo_url`
  - `branch`
  - `language`
  - `framework`
  - `status`
  - `last_indexed_at`
  - `created_at`
  - `updated_at`

Files:
- `files`
  - `id`
  - `project_id`
  - `path`
  - `language`
  - `size_bytes`
  - `content_hash`
  - `is_indexed`
  - `is_generated`
  - `last_seen_at`

RAG docs and chunks:
- `rag_documents`
  - `id`
  - `project_id`
  - `file_id`
  - `path`
  - `content_hash`
  - `chunk_count`
  - `indexed_at`
- `rag_chunks`
  - `id`
  - `project_id`
  - `document_id`
  - `chunk_index`
  - `content`
  - `content_hash`
  - `start_line`
  - `end_line`
  - `token_count`
  - `embedding_id`
  - `metadata_json`
  - `created_at`

Sessions and tasks:
- `agent_sessions`
  - `id`
  - `project_id`
  - `title`
  - `user_goal`
  - `mode`
  - `status`
  - `source`
  - `started_at`
  - `finished_at`
  - `duration_ms`
  - `active_task_id`
  - `model_profile`
  - `final_summary`
  - `error_message`
- `agent_tasks`
  - `id`
  - `session_id`
  - `parent_task_id`
  - `title`
  - `description`
  - `type`
  - `status`
  - `priority`
  - `risk`
  - `expected_files_json`
  - `actual_files_json`
  - `checks_json`
  - `result_json`
  - `created_at`
  - `updated_at`

Events and traces:
- `agent_events`
- `agent_tool_calls`
- `agent_model_calls`
- `retrieval_events`
- `check_runs`
- `handoffs`
- `lessons`
- `mcp_calls`

### 8.2 Supporting tables

- `jobs`
  - durable queue for indexing, retriever refresh, summaries, and check jobs.
- `project_rules`
  - project-specific pinned rules and conventions.
- `project_memory`
  - curated project lesson summaries when needed.
- `model_usage_daily`
  - optional aggregation table for dashboard summaries.

### 8.3 Schema rules

- Use migrations for all schema changes.
- Keep JSON payload columns where shape is expected to evolve.
- Keep lookup columns indexed.
- Add `created_at` and `updated_at` consistently.
- Do not store secrets.

## 9. Event Schema

### 9.1 Envelope

```json
{
  "id": "evt_...",
  "type": "task.started",
  "sessionId": "sess_...",
  "taskId": "task_...",
  "projectId": "proj_...",
  "agent": "orchestrator",
  "level": "info",
  "ts": "2026-06-03T11:30:00.000Z",
  "payload": {}
}
```

### 9.2 Required event types

- `session.created`
- `session.started`
- `session.paused`
- `session.resumed`
- `session.cancelled`
- `session.completed`
- `session.failed`
- `task.created`
- `task.started`
- `task.completed`
- `task.failed`
- `agent.started`
- `agent.completed`
- `agent.failed`
- `retrieval.started`
- `retrieval.completed`
- `retrieval.low_confidence`
- `tool.called`
- `tool.completed`
- `tool.failed`
- `tool.blocked`
- `model.called`
- `model.completed`
- `model.failed`
- `check.started`
- `check.completed`
- `check.failed`
- `handoff.created`
- `lesson.created`

### 9.3 Event rules

- Every important state transition emits an event.
- Events are append-only.
- UI should never infer final state without an event or persisted row.
- SSE should stream append events in order.
- Pagination is required for old session traces.

## 10. Agent Contracts

### 10.1 Main orchestrator

Responsibilities:
- Receive task from web, CLI, or MCP.
- Create session.
- Emit events.
- Choose agents.
- Enforce safety policy.
- Manage task graph.
- Persist all actions.
- Coordinate long-running jobs.
- Handle cancellation and resume.
- Produce final summary.

Must support:
- start session
- pause session
- cancel session
- resume session
- retry failed step
- rerun retrieval
- regenerate handoff

### 10.2 Plan agent

Outputs:
- task graph
- risk level
- likely files
- checks
- model recommendation
- research depth recommendation

### 10.3 Research agent

Responsibilities:
- Query local RAG.
- Query project memory.
- Query previous sessions.
- Query web only if explicitly allowed.
- Rank evidence.
- Detect contradictions.
- Separate evidence from inference.
- Mark low-confidence claims.

### 10.4 Edit-scope agent

Responsibilities:
- Narrow edit scope.
- Select minimal context.
- Identify files likely to edit.
- Identify files that should not be touched.
- Identify hidden dependencies.
- Warn if context is insufficient.

### 10.5 Coding handoff agent

Responsibilities:
- Generate target-specific handoff prompt.
- Package context.
- Include exact stop conditions.
- Include validation commands.
- Include risks.

Targets:
- OpenCode
- Codex
- Manual
- Clipboard
- File

### 10.6 Check agent

Responsibilities:
- Run allowlisted checks.
- Parse failures.
- Summarize failures.
- Map failures to files.
- Recommend next step.
- Save check result.

### 10.7 Review agent

Responsibilities:
- Review git diff.
- Compare implementation against plan.
- Detect scope creep.
- Detect missing tests.
- Detect risky changes.
- Generate review summary.

### 10.8 Learning agent

Responsibilities:
- Store lessons.
- Compare planned vs edited files.
- Measure retrieval quality.
- Record missed files.
- Update project memory.
- Improve next run.

## 11. CLI Contract

### 11.1 CLI principles

- CLI should be thin.
- CLI should call the API.
- CLI should not duplicate orchestration logic.
- CLI should be useful for scripts and keyboard-driven workflows.
- CLI must be stable enough to rely on in terminal workflows.

### 11.2 Commands

Core:
- `ai web`
- `ai api`
- `ai worker`
- `ai mcp`

Projects:
- `ai project add <path>`
- `ai project list`
- `ai project index <project>`
- `ai project status <project>`

Workflows:
- `ai ask "<question>" --project <name>`
- `ai research "<topic>" --project <name> --web`
- `ai plan "<goal>" --project <name>`
- `ai status`
- `ai sessions`
- `ai trace <session-id>`
- `ai handoff --opencode`
- `ai handoff --codex`
- `ai handoff --manual`
- `ai reflect <session-id>`

Checks:
- `ai checks list`
- `ai checks run <check-name>`

### 11.3 CLI output rules

- Use clean terminal summaries.
- Print session IDs and task IDs clearly.
- Exit non-zero on errors.
- Save full traces to runtime when appropriate.

## 12. MCP Contract

### 12.1 MCP principles

- Only expose safe, allowlisted tools.
- No raw shell execution by default.
- Every MCP request should be visible in the web harness.
- Every MCP call should be logged.
- Never assume the client is trusted.

### 12.2 MCP tools

- `ai_search_project`
- `ai_ask_rag`
- `ai_create_session`
- `ai_create_plan`
- `ai_get_current_task`
- `ai_get_next_subtask`
- `ai_get_subtask_context`
- `ai_create_handoff`
- `ai_mark_subtask_done`
- `ai_mark_subtask_failed`
- `ai_get_recent_lessons`
- `ai_reflect_session`
- `ai_list_sessions`
- `ai_get_session_trace`
- `ai_run_check`

### 12.3 MCP safety

- `ai_run_check` accepts only allowlisted check names.
- No arbitrary command strings.
- No file write tools in MVP3 unless explicitly approved.

## 13. Performance Plan

### 13.1 Local-first defaults

- No cloud unless explicitly selected.
- Prefer local retrieval before generation.
- Prefer small models for planning and summarization.
- Use a larger local model only when required.

### 13.2 Indexing optimizations

- Content hash per file.
- Chunk hash per chunk.
- Only re-embed changed chunks.
- Maintain project index metadata.
- Skip binary, large, and generated files.
- Language-aware chunking.
- Track line numbers.
- Support import/export of project index metadata.

### 13.3 Retrieval optimizations

- Hybrid search: vector + keyword + path scoring.
- Rerank only when needed.
- Project-specific boosts.
- Recent git changes boost.
- Test file boosts for debugging.
- Config file boosts for setup issues.
- Previous lesson boosts.
- Deduplicate near-identical chunks.
- Compress selected context.

### 13.4 Model optimizations

- Track latency and tokens per model.
- Auto-warn when context is too large.
- Split large tasks into smaller subtasks.
- Cache safe model outputs where appropriate.

### 13.5 Web optimizations

- SSE append instead of heavy polling.
- Paginate traces and events.
- Lazy-load panels.
- Virtualize long lists.
- Avoid re-rendering huge JSON blobs.
- Keep dashboard snappy on laptop hardware.

## 14. Safety Plan

### 14.1 Safety rules

- No arbitrary shell execution from LLM output.
- Only allowlisted checks.
- Destructive commands require manual approval.
- Do not edit outside project root.
- Do not send code/files to cloud unless explicit.
- Redact secrets in traces.
- Never store raw API keys.
- Log every tool call.
- Log every MCP call.
- Show blocked commands in UI.

### 14.2 Dangerous commands that require approval

- `rm`
- `sudo`
- `chmod -R`
- `chown -R`
- `git reset --hard`
- `git clean`
- `docker system prune`
- `pacman`
- `curl | sh`
- `wget | sh`

## 15. Phased Roadmap

### Phase 1: First useful version

Goal:
- Repo skeleton.
- SQLite schema + migrations.
- Project indexing.
- Ask flow.
- Sessions table.
- Live session events.
- Basic dashboard.
- Basic project page.
- Basic session detail page.
- CLI: `ai web`, `ai api`, `ai worker`, `ai project add`, `ai project index`, `ai ask`, `ai sessions`.

### Phase 2: Control workflow

Add:
- Planner page.
- Task graph.
- Handoff generation.
- Check agent.
- Check runs.
- Model usage tracking.
- Retrieval quality tracking.
- Memory / lessons page.

### Phase 3: MCP and review

Add:
- MCP server.
- Safe MCP tools.
- MCP call logging.
- OpenCode / Codex handoff improvements.
- Review agent.
- Better model routing.

### Phase 4: Automation and TUI

Add:
- TUI.
- Workflow automation.
- Deeper learning loop.
- Cloud routing when explicitly needed.
- Team/export features if needed.

## 16. First Implementation Slice

This is the slice to implement first.

### 16.1 Deliverables

- Monorepo scaffold.
- Shared Zod schemas.
- SQLite schema + migrations.
- API health and project endpoints.
- Session creation and event stream.
- Ask endpoint stub wired to retrieval.
- Minimal worker boundary.
- Minimal web shell with navigation and the first pages.
- CLI commands for project add/index/ask/sessions/trace.
- Basic tests for schema, API, and event serialization.

### 16.2 Exact order of work

1. Initialize workspace tooling.
2. Add `package.json`, `pnpm-workspace.yaml`, and TypeScript config packages.
3. Add `packages/shared` with Zod schemas for projects, sessions, tasks, events, ask requests, and retrieval results.
4. Add `packages/db` with SQLite migrations and typed repository helpers.
5. Add `apps/api` with Fastify and a `/health` route.
6. Add `GET /projects`, `POST /projects`, `POST /projects/:id/index`, `GET /sessions`, `GET /sessions/:id`, `POST /ask`, and `GET /events/stream`.
7. Add `apps/web` shell with layout, sidebar, top project selector, and placeholder pages, then split the browser shell from the API server.
8. Add `cli/ai` with `web`, `project add`, `project index`, `ask`, `sessions`, and `trace`.
9. Add a minimal retrieval/indexing worker path or stub that can be replaced later.
10. Add tests for API contracts, DB migrations, and event encoding.
11. Add docs for local development and runtime assumptions.
12. Verify the end-to-end happy path on one local repo.

### 16.3 First slice acceptance criteria

You should be able to run:

```bash
ai web
ai project add ~/Documents/code/noxcrm
ai project index noxcrm
```

Then open the web app and:
- See the project.
- See indexing status.
- Ask a question about the repo.
- See retrieved chunks.
- See answer with citations.
- See session trace.
- See events.
- See model usage.

CLI should also work:

```bash
ai ask "where is auth handled?" --project noxcrm
ai sessions
ai trace <session-id>
```

### 16.4 Definition of done for slice 1

- Web app starts locally on its own port.
- API starts locally on its own port.
- SQLite migrations apply cleanly.
- Project add/index works for a real local repo.
- Ask returns a response object with citations or explicit insufficiency.
- Session data persists.
- Event stream updates the UI.
- No unsafe execution path exists in the product surface.

## 17. Verification Plan

Run checks in this order:

1. TypeScript typecheck.
2. API unit tests.
3. DB migration tests.
4. Event serialization tests.
5. CLI smoke tests.
6. Web build.
7. One end-to-end local smoke flow against a real repo.

If a check fails:
- Fix the failing layer first.
- Do not widen scope.
- Re-run only the relevant check plus one adjacent check.

## 18. Working Rules For This Repo

- Small, reviewable changes only.
- No giant rewrites.
- Migrations for DB changes.
- Strict TypeScript.
- Typed API contracts.
- Zod schemas everywhere payloads cross boundaries.
- Clear error handling.
- Logs and traces from day one.
- Tests for core logic.
- No hidden cloud calls.
- No unsafe shell execution.
- No editing outside the allowed project path.

## 19. Immediate Next Actions

1. Finish the intelligence upgrade in section 25.
2. Keep the existing observability schema, API routes, CLI trace output, MCP call logging, and web pages intact.
3. Replace remaining heuristic orchestration in `packages/db/src/store.ts` with calls into the modular intelligence packages.
4. Verify the full local-first ask path with model-call, retrieval, context-pack, agent-run, and replayable prompt records.
5. Run `pnpm typecheck` and `pnpm test` after each completed slice.

## 20. Notes And Decisions

- TypeScript is the main implementation language for the product boundary.
- Python is a migration target, not the long-term center.
- The first serious UI is the web app, not a TUI.
- The first serious orchestration surface is sessions and events, not autonomous editing.
- Retrieval quality matters, but the product boundary must be stable first.

## 21. Current Implementation Status

Implemented in this bootstrap slice:

- Workspace scaffold with `package.json`, `pnpm-workspace.yaml`, and strict TypeScript config.
- Shared contracts for projects, sessions, events, ask requests, and retrieval results.
- SQLite migrations and repository helpers with real indexing and ask flows.
- Split local API and web servers, JSON API routes, SPA shell, and SSE event stream proxying.
- CLI commands for `web`, `api`, `project add`, `project index`, `ask`, `sessions`, and `trace`.
- Basic tests for schema parsing, DB persistence, API flows, and event serialization.
- Local smoke run against a real throwaway repo under `/tmp`.
- Safe MCP tool server entrypoint with allowlisted tool dispatch and call logging.
- Background worker entrypoint with queued plan, handoff, and reflection follow-up jobs.
- Session model/profile routing plus env-aware settings snapshots and a best-effort FTS-backed retrieval index with heuristic fallback.
- Model route records, model-call persistence, daily usage rollups, and replayable session trace endpoints/CLI output for observable routing decisions.
- Live reindex and retrieval smoke against a freshly indexed workspace project.
- Persisted task graphs with `/tasks` list/detail pages and task lifecycle routes.
- Review history with `/reviews` list and `/reviews/:id` detail pages.
- MCP call inspection with `/mcp/calls` list and `/mcp/calls/:id` detail pages.
- Separate web shell startup on port `3000` with API proxying and `ai api` for API-only runs.
- Vite React shell in `apps/web` with React Router, Zustand state, and `apps/web/package.json` as the browser package boundary.
- Environment overrides for local runtime paths and ports via `AI_DATABASE_PATH`, `AI_RUNTIME_DIR`, `AI_API_PORT`, `AI_WEB_PORT`, and `AI_API_URL`.
- Review-created background reflection jobs and a worker path for review learning follow-ups.

## 22. Observability Slice (in progress)

Per the user's explicit "do not jump to auto-agents; make the system observable and replayable first" directive, the following slice adds durable traces for every important action.

Implemented:

- Migration `0002_observability.sql` with 50+ new tables covering conversations, retrieval queries/rewrites/results/selected-context/feedback/misses, model providers/profiles/routes/health-checks/calls, context packs/items/budget events, memory candidates/entries/facts/rule rows, agent runs/messages/handoffs, eval cases/runs/answer and retrieval evaluations/session outcomes, and skill candidates/skills/usage rows.
- `packages/db/src/migrate.ts` with `listMigrations` and `runMigrations` (tracks applied versions in `schema_migrations`; migrations must be idempotent because `PRAGMA journal_mode = WAL` cannot run inside a transaction).
- `packages/db/src/repositories/{_shared,conversation,retrieval,models,agents,context,memory,skills,eval,index}.ts` providing typed factory functions for every observability table.
- `packages/agent-protocol/src/index.ts` rewritten as a real agent registry with 16 typed agent descriptors, tool gating, model role mapping, and required-event lists (`listAgents`, `getAgent`, `isToolAllowed`, `agentsWithTool`, `agentsWithModelRole`).
- `store.ts` `createStore()` now exposes `store.conversation`, `store.retrieval`, `store.models`, `store.agents`, `store.context`, `store.memory`, `store.skills`, `store.evals` plus the new query-analysis helpers (`tokenize`, `classifyIntent`, `analyzeQuery`, `rewriteQuery`, `detectQueryLanguage`).
- `ask()` now records: conversation user/assistant messages, `retrieval_query` + rewrite + result rows + selected context rows + miss (when applicable), `agent_runs` for `retrieval_agent` and `answer_agent` with input/output/prompt/tokens, `context_packs` with item rows and budget event, `answer_evaluations` with groundedness, and a `session_outcomes` row.
- `createHandoff()` now records an `agent_handoff` row, a handoff context pack, and an `agent_run` for the `handoff_agent`.
- `indexProject()` now records an `agent_run` for the `indexer` with `model_role = embedding` and indexed-file summary output.
- `createLesson()` now dual-writes to the legacy `lessons` table and a new `memory_candidates` row (kind `workflow_lesson`) so memory review tooling can see them.
- New CLI commands: `ai memory candidates|accept|reject|list`, `ai models list|health`, `ai trace conversation <session-id>`, `ai skills candidates|accept|reject`, `ai eval add|list|run` (CLI opens the local store directly; network-bound commands continue to route through the API client).
- New tests in `tests/observability.test.ts` (7 tests): ask populates retrieval/conversation/agent/context/memory/eval tables; retrieval-miss recording; handoff records context pack + agent run; indexProject records indexer run; memory candidate accept/reject lifecycle; agent-protocol registry; agent-protocol required events.

## 23. Observability API Slice (slice 2)

Per the user's "do not jump to auto-agents; make the system observable and replayable first" directive, slice 2 exposes every observability table through the API so the web UI and external clients can read and review traces.

Implemented:

- Body-parser fix: `app.removeAllContentTypeParsers()` + explicit parsers for `application/json` (`parseAs: "string"`), `text/plain`, and `application/x-www-form-urlencoded`; `readJsonBody`/`readTextBody` now read from the fastify `request.body` first and fall back to the raw stream.
- 18 new JSON routes in `apps/api/src/server.ts`:
  - `GET /retrieval/queries?sessionId=&projectId=&limit=`
  - `GET /retrieval/queries/:id` (returns rewrites, results, selected, misses, feedback)
  - `GET /memory/candidates?status=&projectId=`
  - `POST /memory/candidates/:id/accept` (body: `{ notes? }`)
  - `POST /memory/candidates/:id/reject` (body: `{ reason? }`)
  - `GET /memory/entries?projectId=&scope=`
  - `GET /memory/facts?projectId=`
  - `GET /memory/rules?projectId=`
  - `GET /skills`, `GET /skills/candidates?status=`
  - `POST /skills/candidates/:id/accept`, `POST /skills/candidates/:id/reject`
  - `GET /models/providers`, `GET /models/calls?limit=`, `GET /models/health`
  - `GET /agents/runs?sessionId=`, `GET /agents/runs/:id`, `GET /agents/handoffs?sessionId=`
  - `GET /context/packs?sessionId=`, `GET /context/packs/:id` (returns items + budget events)
  - `GET /conversations/:sessionId/messages`
  - `GET /eval/cases?projectId=`, `POST /eval/cases`, `GET /eval/answers`, `GET /eval/outcomes?sessionId=`
- New repos helpers: `agents.listAllHandoffs`, `evals.listAllOutcomes`, `evals.listAnswerEvaluations`.
- 20 new typed methods in `packages/api-client/src/index.ts` covering every new route.
- 5 new HTTP tests in `tests/observability-api.test.ts`: full trace of a real ask (retrieval query + rewrites + results + selected + runs + messages), memory candidate accept/reject, models/skills/context/eval endpoints clean, handoff records context pack + agent run + handoff row, retrieval query detail.

Not yet implemented (next slices):

- Web detail pages for retrieval, memory, models, skills, eval that consume these new endpoints. → done in slice 3.
- Real embeddings, real reranker, real model router.
- Worker reflection job that promotes `memory_candidates` / `skill_candidates` and records `facts` automatically.

## 24. Observability Web UI Slice (slice 3)

Replaces the placeholder observability pages in `apps/web/src/pages.tsx` with real implementations that consume the slice 2 API routes, adds two new top-level pages (Skills, Eval, Agents) plus two detail subpages (Retrieval query detail, Agent run detail), and wires everything into the React Router surface and nav.

### 24.1 Pages replaced

- `MemoryPage`: three panels — pending candidates (Accept / Reject buttons), accepted entries table, project rules dropdown selector. Reads from `api.listMemoryCandidates({ status: "pending" })`, `api.listMemoryEntries`, and a `useResource` that calls `api.listProjects` + `api.listProjectRules`.
- `RetrievalPage`: kept the search box; added "Recent Retrieval Queries" panel listing `api.listRetrievalQueries()` and linking to `/retrieval/queries/:queryId`, plus a "Missed Paths" panel derived from each query's `misses`.
- `ModelsPage`: five panels — Providers, Profiles, Health (last call per provider), Recent Calls, Daily Usage. Reads from `api.getModelProviders`, `api.getModelCalls`, `api.getModelHealth`.

### 24.2 Pages added

- `SkillsPage`: Active Skills, Pending Candidates (Accept / Reject), Rejected Candidates. Reads `api.listSkills`, `api.listSkillCandidates({ status: "pending" })`, `api.listSkillCandidates({ status: "rejected" })`.
- `EvalPage`: form to add a new eval case (project + question + expected substring), Cases list, Answer Evaluations (groundedness + citation coverage + contradiction), Session Outcomes. Uses `api.listEvalCases`, `api.listAnswerEvaluations`, `api.listSessionOutcomes`, `api.addEvalCase`.
- `AgentsPage`: session picker + Agent Runs list (links to `/agents/runs/:runId`) + Context Packs. Uses `api.listSessions`, `api.listAgentRuns`, `api.listContextPacks`.
- `RetrievalQueryDetailPage`: linked from retrieval page; shows the original query, rewrites, results, selected paths, misses, and any feedback. Uses `useParams` + `useResource` with `runId` dep.
- `AgentRunDetailPage`: linked from agents page; shows run summary (agent, status, model role, session, task, started/finished), `input`/`output` JSON, and the agent's message history. Uses `useParams` + `useResource` with `runId` dep.

### 24.3 Router & nav updates (`apps/web/src/App.tsx`)

- Imported the 5 new page components in alphabetical order.
- New routes: `/agents`, `/agents/runs/:runId`, `/retrieval/queries/:queryId`, `/skills`, `/eval`.
- Added `/agents`, `/skills`, `/eval` to both `navItems` and `commandItems` (subpages are not in the main nav).

### 24.4 Test surface

- Extended `tests/web.test.ts`'s "Vite React shell and router surface" test to assert every new route is registered in `App.tsx` and every new page is exported from `pages.tsx` (AgentRunDetailPage, AgentsPage, EvalPage, RetrievalQueryDetailPage, SkillsPage, plus the existing MemoryPage, ModelsPage, RetrievalPage).
- All 28 tests pass; typecheck is clean.

### 24.5 Acceptance criteria (met)

- Every observability API route from slice 2 is reachable from a web page.
- A reviewer can accept/reject memory and skill candidates from the UI without touching the API.
- A reviewer can drill from the retrieval page into a query's rewrites, selected paths, and misses.
- A reviewer can drill from the agents page into a run's input/output/messages.
- No new dependencies; all pages use the existing `Panel`, `Badge`, `EmptyState`, `KeyValueList`, `useResource` primitives.

## 25. Intelligence Upgrade Slice (active)

Correction after re-checking the repository: the observability foundation already exists. The next implementation target is not "add observability." It is to replace the heuristic brain with real modular intelligence while preserving all trace/replay records.

### 25.1 Current state

Already present:

- `packages/db/migrations/0002_observability.sql` for conversation, retrieval, model, context, memory, agent, eval, and skill observability.
- `packages/db/migrations/0003_intelligence.sql` for embedding metadata, path boosts, retrieval path feedback, rewrite usage, and context-pack dependencies.
- Modular package directories:
  - `packages/model-runtime`
  - `packages/retrieval-engine`
  - `packages/context-engine`
  - `packages/prompt-compiler`
  - `packages/reflection-engine`
  - `packages/safety`
- Repository splits under `packages/db/src/repositories`.
- Tests for the new modules and MCP trace surface.

Completed in the current intelligence pass:

- Ask answer synthesis uses `model-runtime.invoke()` instead of a manual answer `model_calls` insert.
- Ask answer prompts are compiled by `prompt-compiler` and persisted in redacted model-call request metadata for replay.
- Ask context packs are built through `context-engine` with selected chunks, previous messages, accepted memories, facts, project rules, and active skills where available.
- Direct store/CLI ask flows lazily create a local-first model runtime, so the runtime-backed path is not API-only.
- Query rewrite and retrieval judge calls now use compiled prompts and `model-runtime.invoke()` with trace metadata instead of direct synthetic `recordCall()` rows.
- Ask answer profile selection now goes through `model-runtime.route()` and records the router decision.
- Handoff prompt generation now records its `coder_handoff` model call through `model-runtime.invoke()` with compiled prompt metadata.
- Planner generation now records its `planner` model call through `model-runtime.invoke()` with compiled prompt metadata and a deterministic response trace.
- Indexing now uses `model-runtime.embed()` for embedding batches, records embedding model calls, and stores embedding provider/model/dimension metadata on chunks.
- Qdrant collection creation/upsert now uses the runtime embedding dimension and fails safely when the existing collection dimension is incompatible.
- Worker reflection now compiles replayable reflection prompts and records `reflection` model calls through `model-runtime.invoke()` before applying deterministic candidates.
- MCP request handling is async so MCP tools can safely call model-backed workflows without bypassing the runtime.

Still not complete:

- `packages/db/src/store.ts` is still a large orchestration file and still contains ask/index/handoff/reflection flow composition.
- Query rewrite still uses deterministic rewrite output for retrieval until model rewrite JSON parsing/validation is implemented.
- Retrieval judge still uses deterministic confidence output for final control flow until model-judged confidence parsing/validation is implemented.
- Reflection candidate creation still uses deterministic extraction until validated model output parsing is implemented.
- The context engine exists, but reflection must consistently use persisted context-pack items and compiled prompts as the replayable prompt source.
- Embeddings still have heuristic hash fallback behavior; provider-based embeddings and Qdrant dimension validation must be the real path when configured.
- Reflection exists, but must reliably create memory candidates, fact candidates, skill candidates, retrieval feedback/miss candidates, stale fact warnings, and routing notes from completed sessions.
- Agent execution exists in `packages/agent-protocol`, but the ask flow must be refactored into runnable agent steps rather than only descriptor-backed trace rows.

### 25.2 Non-negotiable constraints

- TypeScript owns the product boundary.
- Keep local-first as the default.
- No hidden cloud calls.
- Cloud providers can only be used when `AI_CLOUD_ENABLED=true` or an explicit config enables them.
- No arbitrary shell execution from LLM output.
- Destructive actions require approval.
- Preserve existing tests and web/API/CLI/MCP surfaces.
- Keep all observability writes.
- Every model invocation must create a `model_calls` row through the model runtime.
- Every agent execution must create an `agent_runs` row.
- Every retrieval must create retrieval query/result/selected-context records.
- Every generated prompt must be replayable from trace data.

### 25.3 Slice 1: model runtime

Goal: make `packages/model-runtime` the only path for model health, routing, invocation, embedding, reranking, latency, usage, fallback, and cloud blocking.

Required behavior:

- Provider adapters for `heuristic`, `llama_cpp`, `openai_compat`, and `mock`.
- `llama_cpp` uses OpenAI-compatible `/v1/models`, `/v1/chat/completions`, and optional `/v1/embeddings`.
- `openai_compat` is blocked unless cloud is enabled.
- Routing considers model role, mode, local/cloud permission, profile scores, context need, and fallback profile.
- Successful, failed, blocked, and fallback invocations are recorded in `model_calls`.
- Provider health checks are recorded through existing model health tables.
- Token usage is estimated when provider usage is absent.

CLI acceptance:

```bash
ai models list
ai models health
ai models route "where is auth handled?" --role answer --mode local
ai models call --role summarizer --prompt "Summarize this"
```

Tests required:

- Router chooses local by default.
- Cloud route/call is rejected when cloud is disabled.
- Failed primary call uses configured fallback.
- Every invocation records `model_calls`.
- Usage rows are updated.

### 25.4 Slice 2: prompt compiler

Goal: remove ad hoc prompt construction from store/API/worker/MCP and make every model prompt replayable.

Required behavior:

- `packages/prompt-compiler` owns prompt construction for `answer`, `query_rewrite`, `planner`, `handoff`, `reflection`, `review`, `skill_candidate`, `summarizer`, and `intent`.
- Prompt layers include global rules, project rules, user request, previous messages, accepted memory, fresh facts, retrieval citations, selected context pack, task constraints, and output schema.
- Compiled prompts expose included context, omitted context with reasons, safety notes, token estimate, and optional context-pack id.
- Ask, handoff, and reflection use compiled prompts.
- Trace output can show the exact compiled prompt that produced each model call.

Tests required:

- Snapshot answer prompt shape.
- Snapshot handoff prompt shape.
- Snapshot reflection prompt shape.
- Prompt compiler omits stale facts and over-budget context with reasons.

### 25.5 Slice 3: retrieval engine

Goal: make `packages/retrieval-engine` the real retrieval pipeline, not a holder for functions copied out of `store.ts`.

Pipeline:

1. Classify intent.
2. Analyze query.
3. Generate 2-5 query rewrites.
4. Extract path hints.
5. Extract symbol hints.
6. Search SQLite FTS.
7. Search Qdrant when enabled and dimension-compatible.
8. Apply memory/fact/rule boosts.
9. Apply recent session/check/review boosts.
10. Apply feedback and miss boosts.
11. Rerank.
12. Select context under token budget.
13. Record trace.
14. Compute confidence.
15. Record retrieval misses and low-confidence evaluations.

CLI acceptance:

```bash
ai retrieval explain "where is auth handled?" --project <project>
```

The output must show original query, rewrites, FTS results, vector results, reranked results, selected context, omitted context, confidence, and trace ids.

Tests required:

- Query rewrite returns multiple useful variants.
- Reranking uses path/symbol/content evidence.
- Positive and missed-path feedback changes ranking.
- Low confidence creates retrieval misses and answer evaluation records.

### 25.6 Slice 4: real embeddings

Goal: use provider-based embeddings when configured and keep hash embeddings only as fallback.

Required behavior:

- Embedding provider interface lives in `model-runtime`.
- Config supports:

```env
AI_EMBEDDING_PROVIDER=llama_cpp|fastembed|heuristic
AI_EMBEDDING_MODEL=...
AI_EMBEDDING_DIM=...
AI_QDRANT_COLLECTION=...
```

- Qdrant collection dimension is validated before indexing/searching.
- Collection name includes embedding model/dimension or validation proves compatibility.
- Dimension mismatch fails safely and falls back to SQLite FTS.
- Indexing only re-embeds changed chunks.
- Retrieval traces include embedding provider/model/dimension metadata.

Tests required:

- Hash fallback remains available.
- Qdrant dimension mismatch does not crash indexing.
- Changed chunks only are re-embedded.
- Trace shows embedding metadata.

### 25.7 Slice 5: context engine

Goal: make context packs real compressed context, not filenames or selected chunks only.

Required sources:

- Retrieval chunks.
- Previous conversation messages.
- Previous sessions.
- Accepted memory entries.
- Fresh facts.
- Project rules.
- Recent failed checks.
- Recent reviews.
- Relevant skills.

Required behavior:

- Pinned project rules are included first.
- Current user message is included.
- Top retrieval chunks are included.
- Accepted memories are included only when relevant.
- Fresh facts are included; stale facts are omitted with reasons.
- Previous messages use recency and relevance budget.
- Near-identical excerpts are deduped.
- Ask, handoff, planner, and reflection use this package.

Tests required:

- Budget enforcement.
- Dedupe.
- Priority ordering.
- Stale fact omission.

### 25.8 Slice 6: reflection engine

Goal: replace lesson-only reflection with reviewable candidates and evidence.

Required outputs:

- Memory candidates.
- Fact candidates.
- Skill candidates.
- Retrieval feedback/miss candidates.
- Stale fact warnings.
- Model routing notes.

Rules:

- Do not auto-accept memories.
- Do not auto-apply skills.
- Store evidence JSON.
- Cite source session/query/context/result ids.
- Redact secrets.

Tests required:

- Ask reflection creates useful pending candidates.
- Handoff reflection creates handoff-oriented candidates.
- Review reflection creates review-oriented candidates.
- Repeated retrieval misses create a retrieval-improvement memory candidate.
- Repeated successful workflow creates a skill candidate.

### 25.9 Slice 7: runnable agents

Goal: keep `packages/agent-protocol` as the contract layer and add real execution semantics for ask.

Required behavior:

- `AgentExecutor.run()` validates allowed tools.
- Records `agent_runs` and `agent_messages`.
- Uses `model-runtime` for every model call.
- Records failure state.
- Supports fallback retry.
- Enforces timeout.
- Emits required events.
- Uses `prompt-compiler` when a model is needed.

Ask flow target:

```txt
orchestrator
-> intent_agent
-> query_rewriter_agent
-> retrieval_agent
-> context_agent
-> answer_agent
-> reflection job
```

Tests required:

- Successful ask flow creates separate agent runs.
- Failed agent run is visible in trace.
- Tool outside allowlist is blocked.

### 25.10 Slice 8: MCP full trace

Goal: MCP trace tools expose the same replayable data as CLI trace.

Required tools:

- `ai_get_session_trace`
- `ai_get_context_pack`
- `ai_get_retrieval_query`
- `ai_list_memory_candidates`
- `ai_accept_memory_candidate`
- `ai_list_skill_candidates`
- `ai_accept_skill_candidate`
- `ai_get_model_calls`

Rules:

- Every MCP tool logs an `mcp_calls` row.
- Write-like tools remain narrow and explicit.
- Memory/skill accept tools are logged.

Tests required:

- Full session trace includes conversation, retrieval, context packs, model calls, agent runs/messages, memory/facts/rules, skills, evals, checks, reviews, outcomes, and events.
- Accept tools update state and log MCP calls.

### 25.11 Slice 9: split `store.ts`

Goal: make `store.ts` a composition layer, not a god file.

Move domain logic into:

```txt
packages/db/src/repositories/*     # DB only
packages/retrieval-engine/*        # retrieval logic
packages/context-engine/*          # context packing
packages/model-runtime/*           # model routing/invocation
packages/reflection-engine/*       # reflection and learning
packages/prompt-compiler/*         # prompt construction
packages/safety/*                  # guards/redaction/path policy
```

The DB layer must not contain:

- Answer generation.
- Retrieval scoring.
- Model routing.
- Reflection logic.
- Prompt construction.
- Qdrant HTTP adapter logic.

Acceptance:

- Public API remains compatible.
- Web pages continue working.
- `pnpm typecheck` passes.
- `pnpm test` passes.

### 25.12 End-to-end verification

Run:

```bash
pnpm typecheck
pnpm test
node --experimental-strip-types cli/ai/src/main.ts api --port 4242
node --experimental-strip-types cli/ai/src/main.ts web --port 3000 --api-port 4242
node --experimental-strip-types cli/ai/src/main.ts project add ~/Documents/code/noxcrm
node --experimental-strip-types cli/ai/src/main.ts project index noxcrm
node --experimental-strip-types cli/ai/src/main.ts ask "where is auth handled?" --project noxcrm --depth deep
node --experimental-strip-types cli/ai/src/main.ts trace conversation <session-id>
node --experimental-strip-types cli/ai/src/main.ts models health
node --experimental-strip-types cli/ai/src/main.ts memory candidates
node --experimental-strip-types cli/ai/src/main.ts skills candidates
node --experimental-strip-types cli/ai/src/main.ts eval run --project <project-id>
```

Definition of done:

- Ask uses the real model-runtime abstraction.
- Answer prompt is compiled and replayable.
- Retrieval rewrites are better than a single heuristic rewrite.
- Context packs include previous messages, accepted memories, facts, selected chunks, project rules, and relevant skills.
- Reflection creates useful memory, skill, fact, retrieval feedback, and stale-fact candidates.
- Model routing refuses cloud when cloud is disabled.
- Qdrant uses configured embedding dimensions or falls back safely.
- MCP trace is complete.
- Web pages continue working.
- Tests pass.
- No hidden unsafe execution path is introduced.
