# AI Workbench

Bootstrap scaffold for the local-first AI engineering workbench described in `PLAN.md`.

## Current slice

This repo currently provides:

- SQLite-backed persistence using the built-in `node:sqlite` runtime module.
- Shared TypeScript contracts for projects, sessions, events, ask requests, and retrieval results.
- Separate local API and web servers, with the web shell proxying API routes.
- CLI commands for `web`, `api`, `worker`, `project add`, `project index`, `ask`, `sessions`, and `trace`.
- Basic tests for schema helpers, migration setup, event encoding, and the happy-path API flow.

## Run

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
- The web shell is still incremental and server-backed for now, but the browser client now lives in a standalone asset file.
- The plan still calls for a deeper React/Fastify split later; this scaffold keeps that boundary visible in the directory structure.
- `AI_DATABASE_PATH`, `AI_RUNTIME_DIR`, `AI_API_PORT`, `AI_WEB_PORT`, and `AI_API_URL` override the derived local runtime settings when you need a custom workspace layout.
