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
- `pnpm cli -- project index <project>`: Scan and index project files into SQLite/Qdrant. Extracts code symbols and builds a project context graph.
- `pnpm cli -- project graph <project>`: View the project context graph (entrypoints, route files, hot paths).
- `pnpm cli -- project symbols <project> --query auth`: Search for extracted code symbols in a project.
- `pnpm cli -- project symbol <symbol-id>`: View details for a specific code symbol, including linked chunks and edges.

### Interaction & Debugging
- `pnpm cli -- ask "where is auth handled?" --project <project> --depth deep`: Run the hybrid RAG pipeline.
- `pnpm cli -- plan "implement auth middleware" --project <project>`: Generate a multi-step execution plan.
- `pnpm cli -- trace conversation <session-id>`: View the full execution trace of a session.
- `pnpm cli -- trace timeline <session-id>`: View a visual timeline of session events (messages, model calls, retrieval).
- `pnpm cli -- prompts list --session <session-id>`: List all compiled prompts for a session.
- `pnpm cli -- prompts show <prompt-id>`: Show the full content and metadata of a compiled prompt.
- `pnpm cli -- replay <session-id> --prompt <prompt-id> --model <profile>`: Re-invoke a model with a previously compiled prompt.
- `pnpm cli -- config show --project <project>`: Show resolved configuration for a project.
- `pnpm cli -- config init --project <project>`: Write a starter `.ai-workbench.json` for a project.
- `pnpm cli -- config validate --project <project>`: Validate the project configuration file.
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

*Note: `preferTreeSitter` is currently ignored; the code intelligence extractor uses the fallback parser only.*

## Current Scope

The workbench intentionally stays local-first and read-only by default:
- Fallback symbol extraction is implemented; Tree-sitter is not wired yet.
- Watcher mode is not implemented yet.
- Prompt Lab is available but not exposed as a separate product surface yet.
- MCP host mode is not implemented yet.
- Terminal/Xterm mode is not implemented yet.
- Cloud routing stays disabled unless explicitly enabled.

### CLI Surfaces

Project intelligence:
- `ai project graph <project>` — Show the context graph (routes, middleware, hot paths).
- `ai project symbols <project> [--query <text>] [--limit <n>]` — List symbols with optional search.
- `ai project symbol <symbol-id>` — Show a single symbol with edges and chunks.

Observability:
- `ai trace timeline <session-id>` — Show the session timeline (events, model calls, retrieval).
- `ai replay <session-id> --prompt <id> --model <profile-id>` — Replay a session with a different model.

Prompt Lab:
- `ai prompts list [--session <id>] [--limit <n>]` — List compiled prompts.
- `ai prompts show <prompt-id>` — Show prompt details and messages.

## Environment Variables

- `AI_DATABASE_PATH`: Path to the SQLite database (default: `./runtime/ai.db`).
- `AI_RUNTIME_DIR`: Directory for transient state (default: `./runtime`).
- `AI_CLOUD_ENABLED`: Set to `true` to allow routing to cloud model providers.
- `AI_QDRANT_ENABLED`: Set to `true` for vector-enabled hybrid retrieval.

## System Health

The API exposes read-only status endpoints:
- `GET /health`: Basic database and connectivity status.
- `GET /status`: Detailed snapshot of project, session, and model health.
