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

1. Create the monorepo scaffolding.
2. Create shared schema packages.
3. Create SQLite migration files.
4. Create API health and project/session routes.
5. Create the minimal web shell.
6. Create the CLI commands.
7. Add the first tests.
8. Verify the local happy path.

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
- Live reindex and retrieval smoke against a freshly indexed workspace project.
- Persisted task graphs with `/tasks` list/detail pages and task lifecycle routes.
- Review history with `/reviews` list and `/reviews/:id` detail pages.
- MCP call inspection with `/mcp/calls` list and `/mcp/calls/:id` detail pages.
- Separate web shell startup on port `3000` with API proxying and `ai api` for API-only runs.
- Vite React shell in `apps/web` with React Router, Zustand state, and `apps/web/package.json` as the browser package boundary.
- Environment overrides for local runtime paths and ports via `AI_DATABASE_PATH`, `AI_RUNTIME_DIR`, `AI_API_PORT`, `AI_WEB_PORT`, and `AI_API_URL`.
- Review-created background reflection jobs and a worker path for review learning follow-ups.

No pending items remain in this slice.
