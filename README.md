# AI Workbench

Bootstrap scaffold for the local-first AI engineering workbench described in `PLAN.md`.

## Current slice

This repo currently provides:

- SQLite-backed persistence using the built-in `node:sqlite` runtime module.
- Shared TypeScript contracts for projects, sessions, events, ask requests, and retrieval results.
- A Vite React web app in `apps/web` with Zustand state, React Router routes, and API proxying.
- A Fastify API in `apps/api` with JSON routes, SSE event streaming, and SQLite persistence.
- Separate local API and web servers, with the web shell proxying API routes.
- CLI commands for `web`, `api`, `worker`, `project add`, `project index`, `ask`, `sessions`, `trace`, and model routing / health inspection.
- Basic tests for schema helpers, migration setup, event encoding, and the happy-path API flow.

## Run

```bash
pnpm dev
```

That boots the current local stack using the checked-in `.env` defaults.

## Smoke

```bash
pnpm typecheck
pnpm test
pnpm dev
pnpm cli -- api --port 4242
pnpm cli -- web --port 3000 --api-port 4242
pnpm cli -- project add <path> --name <name>
pnpm cli -- project index <project>
pnpm cli -- ask "where is auth handled?" --project <project> --depth deep
pnpm cli -- trace conversation <session-id>
pnpm cli -- models health
pnpm cli -- memory candidates
pnpm cli -- skills candidates
```

## Notes

- `ai web` starts the browser shell on port `3000` and the API on port `4242` by default.
- The web shell is a Vite React app in `apps/web`, while `ai web` still starts the browser shell plus the API for convenience.
- `AI_DATABASE_PATH`, `AI_RUNTIME_DIR`, `AI_API_PORT`, `AI_WEB_PORT`, `AI_API_URL`, `AI_CLOUD_ENABLED`, `AI_QDRANT_ENABLED`, `AI_QDRANT_URL`, and `AI_QDRANT_COLLECTION` override the derived local runtime settings when you need a custom workspace layout.
- `ai trace conversation <session-id>` now includes replayable messages, retrieval queries, context packs, model calls, events, and outcomes for the selected session.
