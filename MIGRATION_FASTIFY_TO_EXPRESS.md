# Fastify → Express Migration Plan

> **Status**: DRAFT — pending Namik's review of the decisions below.
> **Author**: Vega
> **Date**: 2026-06-15
> **Branch to use**: TBD (`namik` is current; confirm with Namik)

---

## TL;DR

Migrate `apps/api` from Fastify 5 to Express 5. The actual surface is **smaller than it looks** — one `server.ts` of 3507 lines, but ~80% of that is route handlers, not framework code. Estimated effort: **4–8 hours of focused work** plus verification.

But there are **three decisions blocking any code change**. See the next section.

---

## ⚠️ Decisions blocking the work

### Decision 1 — Skip Prettier (keep Biome)

**My recommendation: skip Prettier. Do not add it.**

Evidence from the repo:

- `biome.json` is fully configured (formatter + linter + `recommended` rules + custom JS formatter).
- Latest commit on the branch: `86f71fe feat(devops): add Biome for linting/formatting and remove as any/unknown casts`.
- No `prettier.config.*` file, no `.prettierrc`, no `prettier` in any `package.json`.
- The "remove `as any`" commit is *the same direction* as Prettier-style strictness — Biome is doing both jobs.

Why adding Prettier is a regression:

1. **Format war**: Biome and Prettier disagree on quote style, trailing commas, semicolons, JSX handling. Running both = the codebase will never be cleanly formatted by either.
2. **Install cost**: Biome is Rust, ~5ms to format. Prettier + plugins is ~150ms and ~30MB.
3. **Lint duplication**: Biome already lints (`recommended` rules). ESLint on top is pure overlap.
4. **Confusing ownership**: "What formats my code?" becomes a question with two wrong answers.

**If "Prettier" was a stand-in for "the prettier-quality dev tools"** — you already have them via Biome. There's nothing else to add unless you want git hooks / commit lint, which I cover below.

**If you have a specific Prettier feature you actually want** (e.g., a plugin, a print-width you can't get from Biome), name it and I'll research the Biome equivalent.

### Decision 2 — Confirm the "Express is much better for me" reason

The PLAN.md (sections 3.1, 16.2, 16.2.5) chose Fastify deliberately. The current code uses Fastify-specific patterns: `app.removeAllContentTypeParsers()`, custom `parseAs: "string"` body parsing, dual-API `req.raw` access, Fastify's `inject()` for tests.

Plausible real reasons to switch:

| Reason | Verdict | Notes |
|---|---|---|
| **Consistency with `nox-billings` and `nox-tickets`** (both Express 5) | ✅ **Strongest** | Real value: shared middleware/auth patterns. Worth it. |
| **Team familiarity** / future contributors | ✅ | Real cost-saver over time. |
| **More middleware in npm ecosystem** | ✅ Mild | Fastify has enough middleware for this app, but Express has 10x more options. |
| **Performance** | ❌ Don't bother | Fastify is ~2-3x faster. For a local single-user dev tool, this is invisible. |
| **Express is more popular** | ❌ Not a real reason | Choose for fit, not for popularity. |

**Tell me which** so the plan reflects the real goal. If it's "consistency with the other repos" → I'm in. If it's just "feels better" → I want to push back harder.

### Decision 3 — What is "etc those things"?

I assumed the standard "polish the dev workflow" stack. The safe additions that **don't** conflict with Biome:

| Tool | Verdict | Notes |
|---|---|---|
| `husky` (pre-commit hooks) | ✅ | Pairs with lint-staged. No Biome conflict. |
| `lint-staged` | ✅ | Run `biome check --write` on staged files. |
| `commitlint` + `cz` (conventional commits) | ✅ | Biome is silent on commit messages. |
| `EditorConfig` | ✅ (cosmetic) | Biome already reads it; explicit file is harmless. |
| `vitest` | ❌ | Already using `node --test`. Don't add a parallel runner. |
| `eslint` | ❌ | Conflicts with Biome's linter. |
| `prettier` | ❌ | See Decision 1. |

**Tell me which of the four ✅ ones to add** (or "all four" / "none, just the framework swap").

---

## Scope

| File | LOC | Change |
|---|---|---|
| `apps/api/package.json` | 12 | Swap `fastify: ^5.8.5` for `express: ^5.1.0` + `@types/express`; add `supertest` + `@types/supertest` for tests |
| `apps/api/src/server.ts` | 3507 | The big one. Mostly route handlers (framework-agnostic), but ~20% is Fastify-specific (body parsing, SSE, hooks, `inject()`) |
| `apps/api/src/main.ts` | 23 | No change (no Fastify imports) |
| `apps/api/src/retrieval-explain.ts` | 12 | No change (re-export only) |
| `pnpm-lock.yaml` | — | Regenerated automatically |
| 49 test files | — | Some use `inject()`; need to switch to `supertest` |

## Fastify features actually used (verified by `grep` of `server.ts`)

- `import fastify from "fastify"` + `fastify({ logger: true })` constructor
- `app.removeAllContentTypeParsers()` + custom parsers with `parseAs: "string"`
- `readJsonBody(fastifyRequest, rawReq)` + `readTextBody(...)` helpers (uses both `req.body` and `req.raw`)
- SSE: `text/event-stream` with `reply.raw.write(...)`
- Hooks (request/response — need full review)
- `inject({ method, url, headers, body })` for tests (this is the test-only API)
- `app.inject()` returns `{ statusCode, body }`

## Risks

1. **SSE behavior parity** — Express 5 supports `res.write()` for SSE but buffering/flush differs slightly. Live event stream is core. Must verify byte-for-byte. *Most likely place for a regression.*
2. **Body parser edge cases** — Fastify's `parseAs: "string"` has no exact Express equivalent. Need to verify multipart / text/plain / JSON parsing match. Test with: empty body, malformed JSON, large body, content-type with charset.
3. **Test surface change** — `inject()` → `supertest`. Easy to mask regressions if the test rewrite is sloppy.
4. **Type inference downgrade** — Fastify's route types are stricter. We lose some type safety unless we add Zod guards at route boundaries (we already use Zod, so this is mostly fine).
5. **Middleware order** — Express middleware order is critical. Easy to introduce subtle bugs in setup.

## Step-by-step plan

1. **Branch**: `git switch -c feat/migrate-fastify-to-express` (or whatever branch policy Namik confirms)
2. **Install deps**:
   ```json
   "dependencies": {
     "express": "^5.1.0"
   },
   "devDependencies": {
     "@types/express": "^5.0.0",
     "supertest": "^7.0.0",
     "@types/supertest": "^6.0.0"
   }
   ```
   Drop `fastify` + `@types/fastify`. Keep everything else.
3. **Rewrite `apps/api/src/server.ts`** in this order:
   a. Replace `import fastify from "fastify"` with `import express from "express"`.
   b. Replace `fastify({ logger: true })` with `const app = express()`.
   c. Replace `removeAllContentTypeParsers()` + custom parsers with:
      ```ts
      app.use(express.json({ limit: "10mb" }));
      app.use(express.text({ type: ["text/plain", "text/*"] }));
      app.use(express.urlencoded({ extended: true, limit: "10mb" }));
      ```
   d. Rewrite `readJsonBody()` / `readTextBody()` to read `req.body` directly (drop the Fastify dual-API path).
   e. Rewrite SSE handler with `res.setHeader()` + `res.write()` + `res.flush()` + `res.end()`. Express 5 supports this natively.
   f. Replace `inject()` test helper with a `supertest`-based one in the `ServerHandle` interface.
   g. Update all handlers using `req.raw` → just use `req`.
   h. Add a final `app.use((err, req, res, next) => ...)` error handler (Express 5's built-in async error catching works).
   i. `app.listen(port)` startup with the same `ServerHandle` shape (`{ url, close, inject }`).
4. **Update `apps/api/package.json`** scripts — no change (`main.ts` is the entry).
5. **Update tests** that use the old `inject()` helper — switch to `supertest(app)`. The `inject` method on `ServerHandle` should now wrap `supertest`.
6. **Run verification**:
   ```bash
   pnpm install
   pnpm typecheck
   pnpm test
   pnpm cli -- api --port 4242 &
   pnpm cli -- ask "where is auth handled?" --project noxcrm --depth deep
   ```
7. **Manual smoke**:
   - Open the web app, ask a question, watch the SSE stream.
   - Trigger a `/dev/run` and confirm SSE events flow.
   - Test JSON POST with empty body, malformed JSON, large body.

## Acceptance criteria

- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes (all 49+ tests)
- [ ] API server starts on the same default port (4242)
- [ ] Web app boots and renders `/dashboard`
- [ ] Ask flow returns a real answer (uses model-runtime)
- [ ] SSE event stream updates the UI live
- [ ] `/dev/run` flow works end-to-end with approval
- [ ] No regression in memory / retrieval / skills / eval / observability endpoints
- [ ] No new dependencies beyond `express`, `@types/express`, `supertest`, `@types/supertest`
- [ ] No change to the public API surface (route paths, request shapes, response shapes)
- [ ] No new `as any` introduced (matches the recent Biome cleanup commit)

## Rollback

This is a single-PR migration. If it goes sideways:

- `git revert` the merge commit
- `pnpm install` (restores Fastify from lockfile)
- All routes, tests, and web surface return to the previous state

---

## What I need from Namik before I start

1. **Prettier**: confirm skip. If not, name the specific Prettier feature you want and I'll add a Prettier-vs-Biome section.
2. **Express reason**: which of the 4 reasons, or what I missed. (If it's "consistency with nox-billings/nox-tickets" → I get it, let's go.)
3. **"etc" tools**: which of the 4 (husky / lint-staged / commitlint / EditorConfig), or "all four", or "none, just the framework swap".
4. **Branch policy**: branch off `namik` (current) or `main`?

Once you answer, I'll execute.
