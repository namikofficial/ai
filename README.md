# AI Workbench

Bootstrap scaffold for the local-first AI engineering workbench.

## Core Mandates

- **Local-first**: Storage, retrieval, and reasoning should prioritize local resources.
- **Traceable**: Every model call, retrieval query, and context pack is recorded and replayable.
- **Extensible**: Small packages with clear responsibilities (e.g., `ask-engine`, `retrieval-engine`, `prompt-compiler`).

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm dev
```

## CLI Commands

The `pnpm cli` command provides the main entry point for managing the workbench.

### Servers
- `pnpm cli -- api --port 4242`: Start the Fastify API server.
- `pnpm cli -- web --port 3000 --api-port 4242`: Start the Vite React web dashboard.
- `pnpm cli -- worker`: Start the background job worker (for reflections and indexing).
- `pnpm cli -- mcp`: Start the MCP (Model Context Protocol) server.

### Project Management
- `pnpm cli -- project add <path> --name <name>`: Add a local directory as a project.
- `pnpm cli -- project index <project>`: Scan and index project files into SQLite/Qdrant.

### Interaction & Debugging
- `pnpm cli -- ask "where is auth handled?" --project <project> --depth deep`: Run the hybrid RAG pipeline.
- `pnpm cli -- trace conversation <session-id>`: View the full execution trace of a session.
- `pnpm cli -- models health`: Check connectivity to model providers.
- `pnpm cli -- memory candidates`: View captured learning candidates.
- `pnpm cli -- skills candidates`: View potential skill extractions.

## Configuration

Projects can be configured via an optional `.ai-workbench.json` file in the project root:

```json
{
  "ignore": ["dist/**", "coverage/**"],
  "include": ["apps/**", "packages/**"],
  "chunking": {
    "preferTreeSitter": false,
    "maxChunkTokens": 900
  },
  "retrieval": {
    "boostPaths": ["apps/api/**", "packages/**"],
    "authHints": ["auth", "session", "jwt", "tenant"]
  },
  "models": {
    "answer": "ask-fast-local",
    "embedding": "embedding-local"
  }
}
```

*Note: `preferTreeSitter` is currently disabled in the heuristic implementation.*

## Environment Variables

- `AI_DATABASE_PATH`: Path to the SQLite database (default: `./runtime/ai.db`).
- `AI_RUNTIME_DIR`: Directory for transient state (default: `./runtime`).
- `AI_CLOUD_ENABLED`: Set to `true` to allow routing to cloud model providers.
- `AI_QDRANT_ENABLED`: Set to `true` for vector-enabled hybrid retrieval.

## System Health

The API exposes read-only status endpoints:
- `GET /health`: Basic database and connectivity status.
- `GET /status`: Detailed snapshot of project, session, and model health.
