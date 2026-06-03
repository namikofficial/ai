# Local Development

## Prerequisites

- Node 24 or newer.
- `node --experimental-strip-types` enabled for direct TypeScript execution.

## Quick start

```bash
node --experimental-strip-types cli/ai/src/main.ts web --port 3000 --api-port 4242
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
- `ai web` starts both the browser shell and the API by default; `ai api` is available when you want the API alone.
