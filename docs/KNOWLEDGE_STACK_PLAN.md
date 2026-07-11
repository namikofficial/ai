# Knowledge stack plan

## Product decision

Use one deterministic Workbench control plane with layered retrieval:

| Layer | Use |
|---|---|
| Exact search and AST | Small questions, symbols, paths, changed files |
| SQLite FTS5 | Lexical retrieval and authoritative metadata |
| Qdrant | Dense semantic retrieval |
| RRF merge | Combine lexical and dense candidates |
| Optional reranker | Rerank top 30 before packing top 6–10 |
| Repomix | Large refactor snapshots only |
| SQLite memory | Decisions, failures, rules, preferences, timelines |
| Optional graph adapter | Relationship and temporal queries |

Repomix, Sourcebot, Graphiti, Mem0, DeepWiki, Serena, OpenHands, and OpenClaw must remain bounded adapters. They must not become competing orchestration or memory systems.

## Repomix

Use for big-context work, not every question:

~~~bash
cd /home/namik/Documents/code/ai
node scripts/repomix-pack.mjs /home/namik/Documents/code/noxcrm --style xml --output /home/namik/ai-knowledge/packs/noxcrm.xml
node scripts/repomix-pack.mjs /home/namik/Documents/code/noxcrm --style markdown --output /home/namik/ai-knowledge/packs/noxcrm.md
~~~

- [ ] Store packs outside Git.
- [ ] Add project, commit, branch, timestamp, style, file count, and content hash metadata.
- [ ] Index packs as generated snapshots with lower freshness than source files.
- [ ] Never pack secrets, env files, model files, node_modules, or credentials.
- [ ] Show snapshot commit and freshness in citations.

## Project-native knowledge

Ingest with this precedence:

1. AGENTS.md
2. CLAUDE.md, .codex, and .cursor/rules
3. llms.txt
4. README.md and docs
5. API, schema, build, and deployment manifests
6. Generated maps

Supported sources:

~~~text
AGENTS.md
CLAUDE.md
.cursor/rules/**
.codex/**
README.md
docs/**/*.md
llms.txt
openapi.json
swagger.json
package.json
Cargo.toml
turbo.json
pnpm-workspace.yaml
docker-compose.yml
~~~

Generate initial artifacts:

~~~bash
cd /home/namik/Documents/code/ai
node scripts/generate-project-knowledge.mjs /home/namik/Documents/code/noxcrm /home/namik/ai-knowledge/projects/noxcrm
~~~

The generator creates project summary, repo map, and agent rules. Add API, DB-schema, and testing maps from deterministic parsers; do not ask a model to invent them.

- [ ] Add provenance and generated-at metadata to every artifact.
- [ ] Make rule precedence visible in the context trace.
- [ ] Mark generated summaries stale when sources change.
- [ ] Never allow generated rules to override safety policy.

## Sourcebot and Serena

- [ ] Keep Workbench exact search and AST as the default for one-machine use.
- [ ] Add Sourcebot as an optional multi-project search adapter only when needed.
- [ ] Normalize Sourcebot results into Workbench citations and trace events.
- [ ] Use Serena as a bounded symbol-edit adapter with project-root and approval checks.
- [ ] Keep both out of the authoritative memory path.

## Memory: SQLite first, graph optional

The Workbench already has memory candidates, facts, rules, outcomes, retrieval feedback, and sessions. Keep SQLite authoritative.

- [ ] Add temporal fields: validAt, invalidAt, sourceKind, sourceRef, and confidence.
- [ ] Add contradiction detection before promotion.
- [ ] Implement SQLite graph edges first.
- [ ] Evaluate Graphiti or Mem0 only behind an adapter and only for local/private deployment.
- [ ] Never send private project content to a hosted memory service by default.

## Retrieval and reranking

~~~text
question
 -> deterministic query rewrite
 -> SQLite FTS/BM25 candidates
 -> Qdrant dense candidates
 -> RRF merge
 -> feedback/path/symbol boosts
 -> optional rerank top 30
 -> context budget top 6–10
 -> answer with file/line citations
~~~

- [x] SQLite FTS fallback.
- [x] Dense Qdrant path.
- [x] Hybrid merge and retrieval explanation.
- [x] Feedback, path, and symbol signals.
- [ ] Add explicit RRF scoring tests.
- [ ] Add a local Qwen3 reranker adapter on a separate model profile.
- [ ] Keep heuristic reranking as fallback.
- [ ] Track reranker latency and grounding metrics.

Optional model:

~~~bash
mkdir -p /home/namik/llama-models/rerank
hf download ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF --include "*.gguf" --local-dir /home/namik/llama-models/rerank/qwen3-reranker-0.6b-q8
~~~

Do not send reranking requests through the chat endpoint.

## DeepWiki

- [ ] Add DeepWiki only as an opt-in public-repository MCP adapter.
- [ ] Require a public-repository URL allowlist.
- [ ] Show external-source badges and URLs in every result.
- [ ] Never pass private repository paths, secrets, or local memory to it.
- [ ] Keep local retrieval as the default.

## YAML workflow layer

Use workflows/*.yaml as declarative plans, not executable shell scripts. The Workbench must:

- [ ] Parse and schema-validate workflow YAML.
- [ ] Resolve tools through the safe registry.
- [ ] Resolve checks through the allowlist.
- [ ] Require approval for writes, network, secrets, package changes, migrations, and external MCP.
- [ ] Emit typed events for every step.
- [ ] Persist workflow runs and step outcomes in SQLite.
- [ ] Support resume/retry with bounded repair loops.

The initial example is workflows/fix-bug.yaml.

## OpenHands/OpenClaw lessons

Adopt gateway/control-plane separation, channel adapters, typed MCP, approval gates, persistent sessions, queues, the browser cockpit, and durable memory.

Reject unrestricted shell, unrestricted network, automatic approval, all-secrets access, unreviewed plugins, and always-on public ingress.

## Definition of done

- [ ] Repomix packs are reproducible, redacted, commit-bound, and indexed.
- [ ] Rules, docs, and manifests are ingested with visible precedence.
- [ ] Generated maps are stale-aware and cited.
- [ ] Search combines exact, FTS, dense, feedback, and optional reranking.
- [ ] SQLite remains authoritative for memory and run history.
- [ ] Optional adapters cannot bypass Workbench safety or citation contracts.
- [ ] A YAML workflow can run retrieval, plan, patch, checks, review, and memory with manual approval.
