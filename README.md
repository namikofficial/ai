# AI Workbench

Bootstrap scaffold for the local-first AI engineering workbench described in `PLAN.md`.

## Current slice

This repo currently provides:

- SQLite-backed persistence using the built-in `node:sqlite` runtime module.
- Shared TypeScript contracts for projects, sessions, events, ask requests, and retrieval results.
- A Vite React web app in `apps/web` with Zustand state, React Router routes, and API proxying.
- A Fastify API in `apps/api` with JSON routes, SSE event streaming, and SQLite persistence.
- Separate local API and web servers, with the web shell proxying API routes.
- CLI commands for `web`, `api`, `worker`, `project add`, `project index`, `ask`, `sessions`, and `trace`.
- Basic tests for schema helpers, migration setup, event encoding, and the happy-path API flow.

## Run

```bash
pnpm dev
```

That boots the web cockpit and the worker using the checked-in [.env](/home/namik/Documents/code/ai/.env) defaults.

```bash
node --experimental-strip-types cli/ai/src/main.ts web --port 3000 --api-port 4242
```

Other common commands:

```bash
node --experimental-strip-types cli/ai/src/main.ts api --port 4242
node --experimental-strip-types cli/ai/src/main.ts project add ~/Documents/code/noxcrm
node --experimental-strip-types cli/ai/src/main.ts project index noxcrm
node --experimental-strip-types cli/ai/src/main.ts ask "where is auth handled?" --project noxcrm
node --experimental-strip-types cli/ai/src/main.ts sessions
node --experimental-strip-types cli/ai/src/main.ts trace <session-id>
node --experimental-strip-types cli/ai/src/main.ts mcp
node --experimental-strip-types cli/ai/src/main.ts worker
```

## Notes

- `ai web` starts the browser shell on port `3000` and the API on port `4242` by default.
- The web shell is now a Vite React app in `apps/web`, while `ai web` still starts the browser shell plus the API for convenience.
- `AI_DATABASE_PATH`, `AI_RUNTIME_DIR`, `AI_API_PORT`, `AI_WEB_PORT`, `AI_API_URL`, `AI_CLOUD_ENABLED`, `AI_QDRANT_ENABLED`, `AI_QDRANT_URL`, and `AI_QDRANT_COLLECTION` override the derived local runtime settings when you need a custom workspace layout.
