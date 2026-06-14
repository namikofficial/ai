# Browsing the docs I create — Obsidian setup

> **TL;DR**: Yes, Obsidian is the right tool. The simplest setup is a **symlink** from your existing Obsidian vault into `~/Documents/code/ai/`. That way the docs show up alongside your other notes, with full search, graph view, backlinks, and wiki linking. You and I (Vega) can co-edit the same files.

---

## Why Obsidian

- The docs I write are plain `.md` files at well-known paths
- You already have Obsidian set up (with cert + key + Local REST API)
- Obsidian handles markdown beautifully: graph view, backlinks, search, plugins
- The **symlink pattern** is the standard 2026 way to share docs between Obsidian and code repos (confirmed by time2value.com's "Obsidian Symlink Pattern" guide)

## Option A — Quickest: symlink the whole ai/ folder into your existing vault

Find your existing Obsidian vault (you've got one, since you have Obsidian Local REST API running). The default is `~/Documents/obsidian` or `~/ObsidianVault` or `~/notes`. Let me check what you have:

```bash
ls -la ~/Documents/obsidian 2>/dev/null || ls -la ~/ObsidianVault 2>/dev/null
# (whichever exists is your vault)
```

Then:

```bash
# Pick a name for the symlink inside your vault
ln -s ~/Documents/code/ai ~/Documents/obsidian/Code-AI   # adjust path/name
```

Or, if you want a more specific subdir:

```bash
mkdir -p ~/Documents/obsidian/code
ln -s ~/Documents/code/ai ~/Documents/obsidian/code/ai
```

Open Obsidian → your existing vault → you'll see the `ai/` folder in the file tree. The three docs I wrote (and any future ones) are there:

- `ai/MIGRATION_FASTIFY_TO_EXPRESS.md`
- `ai/docs/AGENT_MCP_AND_AGENT_SETUP.md`
- `ai/docs/OPENCODE_IMPROVEMENTS.md`
- `ai/docs/OBSIDIAN_BROWSING.md` (this file)

Open them, search, link between them with `[[wiki-style]]` linking — works as expected.

## Option B — Make a separate "Code" vault

If you'd rather keep your personal notes separate from project docs:

1. Open Obsidian → "Create new vault" → point at `~/Documents/code` (or `~/Documents/code/ai`)
2. The whole `code/` folder becomes your vault
3. Less personal, more code-focused

Downside: you can't easily cross-link between personal notes and code docs.

## Option C — Use the Obsidian Local REST API from OpenClaw (me)

You have the `obsidian-mcp-server` set up. I can read and write Obsidian files programmatically. So I can:

- Update a doc → I can write directly to the file → you see it in Obsidian
- Search your notes from a session
- Create new notes from our conversations

This is already configured in your Codex config. Same for me if you give the go-ahead.

## What about committing the docs?

When I update a doc, the file lives in `~/Documents/code/ai/docs/...` and the file is part of the `ai/` git repo. I commit to that repo. Your Obsidian vault doesn't need its own git — it just reads via symlink.

If you ever want to version your Obsidian vault itself, that's a separate concern (use the Obsidian Git plugin for that).

## The "UI adapter" pattern (from time2value.com)

The key insight: **symlink is not a sync mechanism, it's a UI adapter**. There's only one copy of each file. You and I are co-working on the same bytes — you see them in Obsidian, I see them as project files. Edits from either side are instantly visible to the other.

This means:
- I can write a doc → commit it → you see it in Obsidian immediately
- You can edit a doc in Obsidian → I see the changes on next read
- No conflict, no merge, no sync lag

## TL;DR for Namik

```bash
# 1. Find your vault
ls -d ~/Documents/obsidian ~/ObsidianVault ~/notes 2>/dev/null

# 2. Symlink the ai folder in
VAULT=$(ls -d ~/Documents/obsidian | head -1)
ln -s ~/Documents/code/ai "$VAULT/Code-AI"

# 3. Open Obsidian, refresh, browse to Code-AI/
```

Or just point Obsidian at a new vault rooted at `~/Documents/code`.

Both work. I use the symlink approach myself because it keeps personal and code docs in the same vault.
