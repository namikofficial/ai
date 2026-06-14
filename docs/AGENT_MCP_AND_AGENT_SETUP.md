# Agent MCP & Setup — Codex, OpenCode, OpenClaw (Vega)

> **Date**: 2026-06-15
> **Goal**: Make Codex, OpenCode, and OpenClaw (Vega) have **equivalent MCP server coverage** so any of them can do the same work.

---

## The three setups, side by side

### Codex — `~/.codex/config.toml` (3.5 KB)

- **Default model**: `gpt-5.5` (medium reasoning effort)
- **Trusted projects**: 16 (everything under `~/Documents/code/*`)
- **MCP servers (3 active)**:
  - `obsidian` — full config: custom cert path, API key, 4 explicit `approval_mode: approve` tool gates
  - `browser` — `@browsermcp/mcp`, no approvals
  - `chrome-devtools` — `chrome-devtools-mcp`, 8 tools with `approval_mode: approve`
- **Model providers (2 proxies)**:
  - `minmax` → `http://127.0.0.1:18101/v1` (local proxy)
  - `cerebras` → `http://127.0.0.1:18102/v1` (local proxy)
- **Custom agents (`~/.codex/agents/`)**: `minmax-worker.toml`, `cerebras-backup.toml`
- **Skills (`~/.codex/skills/`)**: `copilot-cli-offload`, `noxcrm-mobile-fix-board-sync`, plus 5 system skills

### OpenCode — `~/.config/opencode/opencode.json` (13.7 KB, symlinked to dotfiles)

- **Default model**: `llamacpp/qwen-coder-7b` | **Small**: `llamacpp/gemma-3-4b`
- **MCP servers (5 configured, 4 actually enabled)**:
  - `chrome-devtools` ✅
  - `browser` ✅
  - `obsidian` ❌ (config present but `enabled: false` — env vars not set)
  - `context7` ✅ (remote, library docs)
  - `rag` ✅ (local dotfiles RAG bridge)
- **Model providers (3)**: `llamacpp` (local CUDA :8080), `minmax` (M2.7/M2.7-highspeed/M3), `cerebras` (gpt-oss-120b, zai-glm-4.7)
- **Subagents (2 inline)**: `minmax-subagent`, `cerebras-backup-subagent`
- **Skills (15)**: in `dotfiles/configs/opencode/skills/`, paths also include `~/.codex/skills/`
- **Plugins (3)**: `inject-local-ai-env.js`, `linux-notify.js`, `session-log.js`

### OpenClaw (me) — `~/.openclaw/openclaw.json` (2.8 KB)

- **Default model**: `minimax/MiniMax-M3`
- **MCP servers**: ❌ none
- **Model providers (1)**: `minimax` → `https://api.minimax.io/anthropic`
- **Plugins enabled**: `minimax`, `parallel`
- **Hooks**: `boot-md`, `bootstrap-extra-files`, `command-logger`, `compaction-notifier`, `session-memory`
- **Plugin-skills**: `browser-automation` (OpenClaw built-in, symlinked to dist)
- **Web search**: `parallel-free` enabled
- **Denied node commands**: camera.snap/clip, screen.record, contacts.add, calendar.add, reminders.add, sms.send, sms.search

---

## Parity matrix

| Capability | Codex | OpenCode | OpenClaw (me) | Notes |
|---|---|---|---|---|
| Obsidian (notes) | ✅ with cert | ❌ disabled | ❌ | OpenCode needs env vars; OpenClaw needs MCP config |
| Browser (browsermcp) | ✅ | ✅ | ❌ (different: plugin-skill) | OpenClaw's `browser-automation` is OpenClaw-built-in, not MCP |
| Chrome DevTools | ✅ with approvals | ✅ | ❌ | Add to OpenClaw |
| Context7 (lib docs) | ❌ | ✅ | ❌ | Add to Codex and OpenClaw |
| Local RAG bridge | ❌ | ✅ | ❌ | Add to Codex and OpenClaw |
| Filesystem MCP | ❌ | ❌ | ❌ | Consider for all three |
| Git MCP | ❌ | ❌ | ❌ | Consider for all three |
| Multi-model fallback | ✅ cerebras | ✅ cerebras + minimax | ❌ (minimax only) | OpenClaw needs `llamacpp` and `cerebras` providers |
| Subagents | ✅ (2 TOML) | ✅ (2 inline) | ❌ | OpenClaw multi-agent support exists but no config |
| Skills dir | ✅ | ✅ | partial | OpenClaw has 1 plugin-skill, no `skills/` dir |
| Hooks/plugins | many | 3 plugins | 5 hooks | Different model, similar capability |
| Local llama.cpp | ❌ (cloud) | ✅ | ❌ | Codex could add it; OpenClaw should add it |

---

## What I'd add to each

### OpenClaw (me) — the most important

This is **my** home. If you (Namik) bless it, I'll write the config to `~/.openclaw/openclaw.json`. Otherwise I write a snippet to `ai/mcp/openclaw-mcp.servers.json` and you paste.

**Add to `models.providers`:**

```json
"llamacpp": {
  "baseUrl": "http://127.0.0.1:8080/v1",
  "models": [
    { "id": "qwen-coder-7b",  "name": "qwen-coder-7b (local)",  "contextWindow": 32768 },
    { "id": "gemma-3-4b",    "name": "gemma-3-4b (local)",     "contextWindow": 8192  }
  ],
  "api": "openai-completions"
},
"cerebras": {
  "baseUrl": "http://127.0.0.1:18102/v1",
  "api": "openai-completions"
}
```

**Add MCP servers:**

```json
"mcp": {
  "context7":    { "type": "remote", "url": "https://mcp.context7.com/mcp", "enabled": true },
  "rag":         { "type": "local",  "command": ["/home/namik/Documents/code/dotfiles/system/rag-mcp.sh"], "enabled": true },
  "obsidian":    { "type": "local",  "command": ["/home/namik/.config/nvm/versions/node/v24.14.0/bin/obsidian-mcp-server"], "environment": { "OBSIDIAN_API_KEY": "{env:OBSIDIAN_API_KEY}", "OBSIDIAN_BASE_URL": "{env:OBSIDIAN_BASE_URL}", "OBSIDIAN_VERIFY_SSL": "true" }, "enabled": false },
  "git":         { "type": "local",  "command": ["npx", "-y", "@modelcontextprotocol/server-git", "--repository", "/home/namik/Documents/code"], "enabled": true }
}
```

### Codex — for parity with OpenCode

Add to `~/.codex/config.toml` under `[mcp_servers]`:

```toml
[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
enabled = true

[mcp_servers.rag]
command = "rag-mcp"
args = []
enabled = true
```

Also add `llamacpp` provider so Codex can route to local models when you want it (matching OpenCode):

```toml
[model_providers.llamacpp]
name = "llama.cpp local"
base_url = "http://127.0.0.1:8080/v1"
wire_api = "responses"
experimental_bearer_token = "local"
```

### OpenCode — minor

The only thing missing is **`obsidian`** being disabled. Either set the env vars (matches Codex's config) or remove it from the JSON. Also consider adding `filesystem` and `git` MCPs for parity with the others.

---

## Files I'm creating alongside this doc

- `ai/mcp/codex-mcp.servers.toml` — drop-in snippet for Codex
- `ai/mcp/opencode-mcp.servers.json` — drop-in snippet for OpenCode
- `ai/mcp/openclaw-mcp.servers.json` — drop-in snippet for OpenClaw

(Snippets to be written in a follow-up step — see "What I need from Namik" below.)

---

## What I need from Namik

1. **OpenClaw MCP config**: am I allowed to add to `~/.openclaw/openclaw.json`? Or do I just write the snippets and you paste them in?
2. **Codex MCP**: do you want me to append to `~/.codex/config.toml` directly, or just provide a snippet?
3. **OpenCode MCP**: same question.
4. **Obsidian creds**: do you want OpenCode's `obsidian` MCP to use the same Obsidian URL/key as Codex, or different? (The Codex one has a custom cert — that's a per-host thing.)
5. **Local providers for Codex**: add `llamacpp` provider to Codex, or keep it cloud-only?
