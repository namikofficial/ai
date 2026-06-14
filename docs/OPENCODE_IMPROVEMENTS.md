# OpenCode Improvements

> **Date**: 2026-06-15
> **Audience**: Namik
> **Reading**: `~/.config/opencode/opencode.json` (symlinked to `dotfiles/configs/opencode/opencode.local-llamacpp.json`)

## TL;DR — what to do

1. **Remove `deepseek-r1-7b` as a default-able option** (it can't do tool calls — you noticed this)
2. **Use `qwen3-8b` as the new default** (best small model for tool use / agentic work in 2026)
3. **Use `qwen3-4b` as the `small_model`** (perfect for commit messages, search, summarize — fast + cheap)
4. Add the new config to `opencode.json` (snippets below)
5. Add 3 specialist subagents: reviewer, test-writer, docs
6. Wire in `dotfiles/ai/system/GLOBAL_SYSTEM.md` as the system prompt
7. Add LSP for TS / Rust / Python / Lua / Bash (massive upgrade)
8. Add a `conventional-commit` skill for the commit-message use case

---

## Model recommendations (with research, June 2026)

I did 4 web searches to check current consensus. Here's what the community is using on RTX 4050 6GB for local agentic work:

### What I found

| Source | Recommendation |
|---|---|
| **Overchat / AI Hub** (Jun 2026) | "Qwen3-Coder-Next" (235B/22B MoE, 24GB VRAM) is top for coding, but **too big for your hardware**. "Qwen 3.5-27B" needs 18GB — also too big. |
| **LM Market Cap** (Jun 2026) | Top local coding LLMs: DeepSeek V4 Pro, Gemma 4 31B, R1 0528. Most are 24GB+ VRAM. |
| **Alex Ewerlöf blog** (Jun 2026) | Detailed guide on local LLMs for agentic coding. Confirms Qwen and Llama as the workhorses. |
| **ToolHalla** (Feb 2026) | "Qwen 3.5-8B punches above its weight class but requires more validation in production." "Qwen 2.5-14B is the most reliable workhorse." |
| **Kunal Ganglani** (Jun 2026) | "Qwen3-32B correctly identified which tool to call roughly 87% of the time on first attempt — close to GPT-4o's 92%." Qwen3 is "the most capable open-weight agent model currently available." |
| **LLM Hardware** (May 2026) | Qwen3-8B at Q4 = **~5GB VRAM**. Fits any 8GB GPU at Q4. RTX 4050 6GB is fine. |
| **Prompt Quorum** (Jun 2026) | "6 GB VRAM tier: 7B-8B at Q4 is the sweet spot." |

### What this means for your hardware

**RTX 4050 6GB VRAM** = the sweet spot is **7-8B dense models at Q4 quantization**.

**The verdict: Qwen3-8B is the best default for local agentic work in 2026.** It fits in 5GB at Q4, has native thinking mode, ~87% tool-call accuracy, and is the most modern open-weight model family.

### Recommended lineup (replace current config)

```jsonc
"llamacpp": {
  // ...
  "models": {
    "qwen3-4b": {
      "name": "qwen3-4b",
      "tools": true,
      "_purpose": "Small model: commit messages, search/explore, quick summaries, single-shot operations. ~3GB VRAM Q4."
    },
    "qwen3-8b": {
      "name": "qwen3-8b",
      "tools": true,
      "_purpose": "Default model: full agentic work — code, planning, retrieval-augmented answers. ~5GB VRAM Q4. Best tool-calling small model in 2026."
    },
    "qwen-coder-7b": {
      "name": "qwen-coder-7b",
      "tools": true,
      "_purpose": "Fallback for pure code generation when Qwen3-8B isn't enough. Battle-tested Qwen2.5-Coder generation."
    },
    "gemma-3-4b": {
      "name": "gemma-3-4b",
      "tools": true,
      "_purpose": "Tertiary fallback. Fine for tiny stuff if Qwen3-4B is unavailable."
    },
    "phi-4-mini": {
      "name": "phi-4-mini",
      "tools": true,
      "_purpose": "Microsoft's compact model. Use for specialized tasks or as a backup."
    }
    // REMOVED: deepseek-r1-7b — it's a reasoning model, bad at tool calls. Confirmed by your own experience.
  }
}
```

Then:
```jsonc
"model":       "llamacpp/qwen3-8b",   // was: qwen-coder-7b
"small_model": "llamacpp/qwen3-4b"    // was: gemma-3-4b
```

### Why drop deepseek-r1-7b entirely

- **Reasoning models can't do tools well.** They spend tokens thinking, then output reasoning chains instead of tool calls. That's the pattern DeepSeek R1 was designed for, but it's the wrong tool for OpenCode.
- **You noticed this yourself.** "It sucks ass when it needs to do a tool call." Exactly right.
- **It's already `tools: false` in your config** — so it can't be used for tool work anyway. It just sits there as a dead option. Remove it.

### Why Qwen3-4B is the right small_model for the "small things" use case

Things you mentioned wanting a small model for:
- "generating commit messages in conventional commit order in details"
- "search and explore helpers"
- "small explorer and similar things"

Qwen3-4B is **purpose-built for this**:
- 3GB VRAM at Q4 — fits alongside Qwen3-8B
- Supports tools (so it can call the conventional-commit skill)
- Trained on instruction-following + code
- Apache 2.0 (commercial OK)
- 32K context (extendable)

Plus: a 4B model is **fast**. For a commit message, you're looking at <1 second response time. Perfect for "small things."

---

## Other improvements (priority order)

### 🔥 #1 — Add LSP servers

This is the single biggest upgrade. OpenCode becomes IDE-grade with hover, go-to-def, refactor, errors inline.

Add to `opencode.json`:

```json
"lsp": {
  "typescript": {
    "command": ["typescript-language-server", "--stdio"],
    "extensions": [".ts", ".tsx", ".mts", ".cts"]
  },
  "rust": {
    "command": ["rust-analyzer"],
    "extensions": [".rs"]
  },
  "python": {
    "command": ["pyright-langserver", "--stdio"],
    "extensions": [".py"]
  },
  "lua": {
    "command": ["lua-language-server"],
    "extensions": [".lua"]
  },
  "bash": {
    "command": ["bash-language-server", "start"],
    "extensions": [".sh", ".bash", ".zsh"]
  }
}
```

Install:
```bash
sudo pacman -S rust-analyzer lua-language-server bash-language-server
pnpm add -g typescript-language-server pyright
```

### #2 — Wire in the system prompt

`dotfiles/ai/system/GLOBAL_SYSTEM.md` (16 lines) is the system prompt for AI agents in your stack. Add:

```json
"agent": {
  "build": {
    "prompt": "{file:~/Documents/code/dotfiles/ai/system/GLOBAL_SYSTEM.md}\n\nYou also have:\n- Local RAG via MCP (rag server, context7 for lib docs)\n- 15 skills in ~/Documents/code/dotfiles/configs/opencode/skills/\n- Multi-provider routing: prefer local (llamacpp); cloud (cerebras, minimax) for higher-stakes work\n\nRules:\n- Cite file paths in every answer\n- Run checks before reporting done\n- Minimum diff; no scope creep\n- If unsure, ask or run a small experiment\n- For commit messages: always use conventional commit format with detailed body explaining the WHY"
  }
}
```

### #3 — Add focused subagents

```json
"agent": {
  "reviewer-subagent": {
    "description": "Read-only code review. Returns structured findings (correctness, scope, tests, risks). Never edits files.",
    "mode": "subagent",
    "model": "minimax/MiniMax-M3",
    "prompt": "You are a read-only code reviewer. Inspect the diff. Output JSON: { summary, risks[], missing_tests[], scope_creep, suggested_fixes[] }. Do not edit files. Do not run commands that change state."
  },
  "test-writer-subagent": {
    "description": "Adds tests for changed code. Matches existing test style. No scope creep into production code.",
    "mode": "subagent",
    "model": "llamacpp/qwen3-8b",
    "prompt": "Add or update tests for the changed code. Match existing test style. Do not modify production code. Run the test suite and report pass/fail."
  },
  "docs-subagent": {
    "description": "Updates README, JSDoc, and code comments for the change. Verifies each line against current source.",
    "mode": "subagent",
    "model": "llamacpp/qwen3-4b",
    "prompt": "Update README, JSDoc, and code comments for the change. Verify each line against the current source — never invent APIs."
  },
  "debug-subagent": {
    "description": "Reproduces a bug, isolates the cause, returns a hypothesis + minimal repro.",
    "mode": "subagent",
    "model": "llamacpp/qwen3-8b",
    "prompt": "Reproduce the bug, isolate the cause, return { hypothesis, repro, affected_files[], minimal_fix }. No fixes — just diagnosis."
  }
}
```

### #4 — Per-agent temperature and topP

```json
"agent": {
  "build":                { "temperature": 0.1, "topP": 0.95 },
  "plan":                 { "temperature": 0.3, "topP": 0.95 },
  "reviewer-subagent":    { "temperature": 0.0, "topP": 1.0  },
  "test-writer-subagent": { "temperature": 0.1, "topP": 0.95 },
  "docs-subagent":        { "temperature": 0.1, "topP": 0.95 },
  "debug-subagent":       { "temperature": 0.2, "topP": 0.95 }
}
```

### #5 — New skills for the "small things" use case

You already have 15 skills. Add 2 more specifically for the things you mentioned:

- **`conventional-commit`** — a skill that, when invoked, walks the model through conventional commit format with a detailed body. Pair this with `qwen3-4b` as the small_model for fast commit messages.
- **`codebase-tour`** — a skill that gives a quick orientation of an unfamiliar repo: "what does this project do", "where is X handled", "where do tests live". Use `qwen3-4b` here too.

### #6 — Auto-approve safe tools, ask for risky

```json
"permission": {
  "edit": "allow",
  "read": "allow",
  "bash": {
    "ls": "allow",
    "cat": "allow",
    "head": "allow",
    "tail": "allow",
    "rg": "allow",
    "fd": "allow",
    "git status": "allow",
    "git diff": "allow",
    "git log": "allow",
    "git show": "allow",
    "git add": "ask",
    "git commit": "ask",
    "git push": "ask",
    "pnpm typecheck": "allow",
    "pnpm test": "allow",
    "pnpm lint": "allow",
    "pnpm format": "allow",
    "biome check": "allow",
    "biome format": "allow",
    "default": "ask"
  }
}
```

`git add/commit/push` always ask (so you can review the diff and message before they happen).

### #7 — Format-on-save plugin (4th plugin)

```js
// ~/.config/opencode/plugins/biome-format.js
export const BiomeFormat = {
  name: "biome-format",
  "file.save": async ({ path }) => {
    if (/\.(ts|tsx|js|jsx|mjs|cjs|json)$/.test(path)) {
      await $`biome check --write ${path}`.quiet();
    }
  }
};
```

### #8 — Enable `obsidian` MCP

Currently `obsidian` is in the JSON but `enabled: false`. Copy the env vars from your Codex `obsidian` MCP block (or the env file) and set them in OpenCode's config.

---

## Suggested implementation order

1. **Update model lineup** (5 min) — replace the `models` block, change `model` and `small_model`
2. **Wire in system prompt** (5 min)
3. **Per-agent temperature** (5 min)
4. **Permission rules** (10 min)
5. **3 new subagents** (20 min)
6. **LSP** (1 hour)
7. **Format-on-save plugin** (15 min)
8. **New skills** (1–2 hours writing)
9. **Enable obsidian MCP** (5 min)

Total: ~4 hours. Test after each step.

---

## What I need from Namik

1. **Model change**: confirm `qwen3-8b` as default + `qwen3-4b` as small + remove `deepseek-r1-7b`?
2. **LSP languages**: which do you actually code in? (TS strict, Rust, Python, Lua, Bash, others?)
3. **System prompt injection**: OK with OpenCode loading `GLOBAL_SYSTEM.md` on every session? (Slight token cost.)
4. **Subagents**: keep all 4 specialist suggestions?
5. **Format-on-save**: yes/no?
6. **Permission rules**: any adjustments?
7. **Obsidian MCP env vars**: set in shell already, or add to config?
