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
- The API lives in `apps/api` as a Fastify server with JSON endpoints and SSE event streaming.
- `pnpm dev` reads the checked-in [.env](/home/namik/Documents/code/ai/.env) file, starts the web cockpit, and keeps the worker running alongside it.
- `ai web` starts both the browser shell and the API by default; `ai api` is available when you want the API alone.
- Set `AI_DATABASE_PATH`, `AI_RUNTIME_DIR`, `AI_API_PORT`, `AI_WEB_PORT`, `AI_API_URL`, `AI_CLOUD_ENABLED`, `AI_QDRANT_ENABLED`, `AI_QDRANT_URL`, or `AI_QDRANT_COLLECTION` if you want to override the derived local runtime locations and ports.
