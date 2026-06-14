# OpenCode Improvements

> **Date**: 2026-06-15
> **Audience**: Namik
> **Reading**: `~/.config/opencode/opencode.json` (symlinked to `dotfiles/configs/opencode/opencode.local-llamacpp.json`)

## Current state (TL;DR)

- 3 providers: **llamacpp** (local CUDA :8080), **minmax** (M2.7 / M2.7-highspeed / M3), **cerebras** (gpt-oss-120b, zai-glm-4.7)
- Default model: `llamacpp/qwen-coder-7b` (good)
- Small model: `llamacpp/gemma-3-4b` (small for code; OK for short edits / summaries)
- 5 MCP servers configured (3 enabled, 1 disabled, 1 different)
- 2 subagents (both generic, no specialists)
- 15 skills (great coverage already)
- 3 plugins
- **No LSP** (this is the biggest gap)
- **No per-agent temperature / topP** (everything defaults)
- **No system prompt wired in** (GLOBAL_SYSTEM.md not used by OpenCode)

---

## The improvements, in priority order

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

Install commands (Arch + pnpm):

```bash
sudo pacman -S rust-analyzer lua-language-server bash-language-server
pnpm add -g typescript-language-server pyright
```

### #2 — Wire in the system prompt

`dotfiles/ai/system/GLOBAL_SYSTEM.md` (16 lines) is **the** system prompt for AI agents in your stack, but OpenCode doesn't read it. Add:

```json
"agent": {
  "build": {
    "prompt": "{file:~/Documents/code/dotfiles/ai/system/GLOBAL_SYSTEM.md}\n\nYou have:\n- Local RAG via MCP (rag server, context7 for lib docs)\n- 15 skills in ~/Documents/code/dotfiles/configs/opencode/skills/\n- Multi-provider routing: prefer local (llamacpp); cloud (cerebras, minimax) for higher-stakes work\n\nRules:\n- Cite file paths in every answer\n- Run checks before reporting done\n- Minimum diff; no scope creep\n- If unsure, ask or run a small experiment"
  }
}
```

### #3 — Add focused subagents

You have 2 generic subagents. Add 3 specialists that you can call in parallel:

```json
"agent": {
  "reviewer-subagent": {
    "description": "Read-only code review. Returns structured findings (correctness, scope, tests, risks). Never edits files.",
    "mode": "subagent",
    "model": "minmax/MiniMax-M3",
    "prompt": "You are a read-only code reviewer. Inspect the diff. Output JSON: { summary, risks[], missing_tests[], scope_creep, suggested_fixes[] }. Do not edit files. Do not run commands that change state."
  },
  "test-writer-subagent": {
    "description": "Adds tests for changed code. Matches existing test style. No scope creep into production code.",
    "mode": "subagent",
    "model": "llamacpp/qwen-coder-7b",
    "prompt": "Add or update tests for the changed code. Match existing test style. Do not modify production code. Run the test suite and report pass/fail."
  },
  "docs-subagent": {
    "description": "Updates README, JSDoc, and code comments for the change. Verifies each line against current source.",
    "mode": "subagent",
    "model": "llamacpp/qwen-coder-7b",
    "prompt": "Update README, JSDoc, and code comments for the change. Verify each line against the current source — never invent APIs."
  },
  "debug-subagent": {
    "description": "Reproduces a bug, isolates the cause, returns a hypothesis + minimal repro.",
    "mode": "subagent",
    "model": "llamacpp/qwen-coder-7b",
    "prompt": "Reproduce the bug, isolate the cause, return { hypothesis, repro, affected_files[], minimal_fix }. No fixes — just diagnosis."
  }
}
```

### #4 — Per-agent temperature and topP

Right now everything defaults. Code agents should be deterministic; brainstorm agents should be creative.

```json
"agent": {
  "build":             { "temperature": 0.1, "topP": 0.95 },
  "plan":              { "temperature": 0.3, "topP": 0.95 },
  "reviewer-subagent": { "temperature": 0.0, "topP": 1.0  },
  "test-writer-subagent": { "temperature": 0.1, "topP": 0.95 },
  "docs-subagent":     { "temperature": 0.1, "topP": 0.95 },
  "debug-subagent":    { "temperature": 0.2, "topP": 0.95 }
}
```

### #5 — More skills

The 15 existing skills are great. Add 4 more:

- `typescript-strict` — patterns for strict TS, no `as any`, narrow types, Zod at boundaries
- `conventional-commit` — exact conventional-commit format with scope rules
- `biome-format` — when to run `biome check --write`, what it catches, what it doesn't
- `arch-decision-record` — when to add an ADR to `docs/adr/`, the template

### #6 — Format-on-save plugin

You have 3 plugins. Add a 4th that runs Biome on save:

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

(Biome is fast — should be invisible to the user.)

### #7 — Auto-approve safe tools, manual for risky

OpenCode supports per-tool approval. None are configured. Add:

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

`git push`, `rm`, `sudo`, `chmod`, `pnpm publish`, etc. all ask.

### #8 — Better model tiering

```json
"small_model":  "llamacpp/gemma-3-4b",
"medium_model": "llamacpp/qwen-coder-7b",
"large_model":  "minmax/MiniMax-M3"
```

If OpenCode version supports it. Lets subagents use a cheaper/faster tier for short work and escalate for serious work.

(Verify your OpenCode version supports `medium_model` / `large_model` — older versions only have `model` and `small_model`.)

### #9 — Enable `obsidian` MCP

Currently `obsidian` is in the JSON but `enabled: false`. Copy the env vars from your Codex `obsidian` MCP block and set them in the OpenCode config.

### #10 — Cost / quality guardrails for cloud

For `minmax` and `cerebras` providers, you can set per-model `cost` to track usage:

```json
"models": {
  "minmax/MiniMax-M3": { "cost": { "input": 0.6, "output": 2.4 } },
  "cerebras/gpt-oss-120b": { "cost": { "input": 0.0, "output": 0.0 } }
}
```

So OpenCode shows you what each agent call costs.

---

## Suggested implementation order

1. **LSP** (1 hour, biggest win)
2. **System prompt wiring** (5 min)
3. **Per-agent temperature** (5 min)
4. **Permission rules** (10 min)
5. **3 new subagents** (20 min)
6. **Format-on-save plugin** (15 min)
7. **New skills** (1–2 hours writing the 4 skills)
8. **Model tiering** (5 min if version supports it)
9. **Enable obsidian MCP** (5 min if env vars are set up)
10. **Cost tracking** (5 min)

Total: ~4 hours. Test after each step.

---

## What I need from Namik

1. **LSP languages**: which do you actually code in? (TS strict, Rust, Python, Lua, Bash, others?)
2. **System prompt injection**: OK with OpenCode loading `GLOBAL_SYSTEM.md` on every session? (Slight token cost.)
3. **Subagents**: keep all 4 specialist suggestions, or pick a subset?
4. **Format-on-save**: yes/no?
5. **Permission rules**: any tools I should explicitly deny or allow beyond the default?
6. **Obsidian MCP**: env vars already set in your shell, or need to add to OpenCode config?
7. **OpenCode version**: do you know what version is installed? (Affects which config keys are supported.)
