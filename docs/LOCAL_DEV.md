# Local Development

## Prerequisites

- Node 24 or newer.
- `node --experimental-strip-types` enabled for direct TypeScript execution.

## Quick start

```bash
pnpm dev
```

In another shell:

```bash
node --experimental-strip-types cli/ai/src/main.ts api --port 4242
node --experimental-strip-types cli/ai/src/main.ts project add /path/to/repo --name demo
node --experimental-strip-types cli/ai/src/main.ts project index demo
node --experimental-strip-types cli/ai/src/main.ts ask "where is auth handled?" --project demo
node --experimental-strip-types cli/ai/src/main.ts sessions
node --experimental-strip-types cli/ai/src/main.ts trace <session-id>
node --experimental-strip-types cli/ai/src/main.ts mcp
node --experimental-strip-types cli/ai/src/main.ts worker
```

## Notes

- The server writes its SQLite database under `runtime/ai.db`.
- The first slice uses the built-in `node:sqlite` module, so there is no external database dependency yet.
- The browser UI lives in `apps/web` as a Vite React app with Zustand state and React Router routes.
- The API lives in `apps/api` as an Express server with JSON endpoints and SSE event streaming.
- `pnpm dev` reads the checked-in [.env](/home/namik/Documents/code/ai/.env) file, starts the web cockpit, and keeps the worker running alongside it.
- `ai web` starts both the browser shell and the API by default; `ai api` is available when you want the API alone.
- Set `AI_DATABASE_PATH`, `AI_RUNTIME_DIR`, `AI_API_PORT`, `AI_WEB_PORT`, `AI_API_URL`, `AI_CLOUD_ENABLED`, `AI_QDRANT_ENABLED`, `AI_QDRANT_URL`, or `AI_QDRANT_COLLECTION` if you want to override the derived local runtime locations and ports.

## Local Agentic Development

The workbench can run safe local coding tasks end to end:

```bash
node --experimental-strip-types cli/ai/src/main.ts models health
node --experimental-strip-types cli/ai/src/main.ts project add /path/to/repo --name demo
node --experimental-strip-types cli/ai/src/main.ts project index demo
node --experimental-strip-types cli/ai/src/main.ts dev "add a small README note" --project demo --checks typecheck
node --experimental-strip-types cli/ai/src/main.ts dev diff <run-id>
node --experimental-strip-types cli/ai/src/main.ts dev approve <run-id>
```

Safety rules enforced by `packages/execution-engine`:

- No raw shell from LLM output. Every check is resolved from `.ai-workbench.json` or the built-in allowlist.
- All edits happen in a git worktree (with a safe-copy fallback under `runtime/workspaces/<session-id>`).
- `.env`, secrets, lockfiles, migrations, auth, db, and package files always require explicit approval.
- The original project is not modified until you pass `--approve-edits` and run `ai dev approve <run-id>`.

`.ai-workbench.json` example for dev:

```json
{
  "checks": {
    "typecheck": "pnpm typecheck",
    "test": "pnpm test",
    "lint": "pnpm lint"
  },
  "dev": {
    "defaultChecks": ["typecheck"],
    "maxRepairLoops": 1,
    "requireApprovalFor": ["env", "migrations", "auth", "db", "package"]
  }
}
```

Built-in check command IDs (resolved by the execution engine):

- `typecheck` -> `pnpm typecheck`
- `test` -> `pnpm test`
- `lint` -> `pnpm lint`
- `format_check` -> `pnpm format:check`

Local model runtime env overrides:

- `AI_LOCAL_BASE_URL` (default `http://127.0.0.1:8080/v1`) — OpenAI-compatible llama.cpp / llama-swap endpoint.
- `AI_LOCAL_MODEL_FAST`, `AI_LOCAL_MODEL_DEEP`, `AI_LOCAL_MODEL_CODER` — model names per role.
- `AI_LOCAL_EMBEDDING_MODEL` — embedding model name for hybrid retrieval.

The default model catalog now seeds `provider_llamacpp_local` against `AI_LOCAL_BASE_URL` and wires the most-used profiles (ask, planner, query-rewrite, retrieval-judge, handoff, dev-editor, dev-repair) to it. The heuristic profile remains only as an explicit fallback.
