# Fastify → Express Migration Plan

> **Status**: **CONFIRMED** — Namik's decisions are in. Migration scope locked.
> **Author**: Vega
> **Date**: 2026-06-15

## TL;DR

Migrate `apps/api` from Fastify 5 to Express 5. ~3500-line `server.ts` (most is route handlers, not framework code). Realistic effort: **4–8 hours of focused work plus verification**.

Confirmed decisions from Namik:

1. ✅ **Skip Prettier**, BUT **tune Biome for more readability** (bigger line width, more whitespace, more rules, organize imports)
2. ✅ **Migrate to Express** — Namik is more comfortable with Express, no Fastify mental model, wants to focus on building features
3. ✅ **Framework swap only** — no husky/lint-staged/commitlint/EditorConfig stack

---

## Decision 1 — Biome formatting tune-up (replaces Prettier)

Prettier is **out**. Biome is **in, but tuned for Prettier-like readability**. Updated `biome.json` settings:

| Setting | Before | After | Why |
|---|---|---|---|
| `formatter.lineWidth` | 100 | **120** | More horizontal room = fewer wrapped lines, easier to scan |
| `linter.rules.style` | not set | **`{ all: true }`** | More formatting-related lint rules (e.g. `useImportType`, `useNodejsImportProtocol`, `useConsistentArrayType`) |
| `linter.rules.complexity` | not set | **`{ all: true }`** | Catches over-complex code at lint time |
| `javascript.formatter.arrowParentheses` | default | **`"always"`** | Prettier default: `(x) => x` not `x => x` |
| `javascript.formatter.bracketSpacing` | default | **`true`** | Prettier default: `{ foo }` not `{foo}` |
| `javascript.formatter.jsxQuoteStyle` | default | **`"double"`** | Consistency with JS quotes |
| `assist.actions.source.organizeImports` | not set | **`"on"`** | Auto-sorts imports on save/format |

The result: Biome-formatted code looks like Prettier-formatted code (because it follows Prettier's defaults), and there's a stricter lint net catching the kind of code that's hard to read.

I'm writing the updated `biome.json` alongside this plan.

---

## Decision 2 — Express 5 migration (confirmed)

Express 5 is **solid in 2026** and Namik is more comfortable with it. No mental model for Fastify. The benefit: shared middleware/auth patterns with `nox-billings` and `nox-tickets` (both Express 5) — that's a real win.

## Decision 3 — Framework swap only

No husky, no lint-staged, no commitlint, no EditorConfig. Just the framework swap. Biome is the only formatting/lint tool we touch (and we're only tuning it).

---

## Scope

| File | LOC | Change |
|---|---|---|
| `apps/api/package.json` | 12 | Drop `fastify`, add `express: ^5.1.0`, `@types/express`, `supertest`, `@types/supertest` |
| `apps/api/src/server.ts` | 3507 | Replace Fastify patterns; mostly route handlers, ~20% is framework code |
| `apps/api/src/main.ts` | 23 | No change (no Fastify imports) |
| `apps/api/src/retrieval-explain.ts` | 12 | No change (re-export only) |
| `biome.json` | 22 | Tune per Decision 1 above |
| `pnpm-lock.yaml` | — | Regenerated automatically |
| 49 test files | — | Some use `inject()`; switch to `supertest` |

## Fastify features used (verified by `grep` of `server.ts`)

- `import fastify from "fastify"` + `fastify({ logger: true })` constructor
- `app.removeAllContentTypeParsers()` + custom parsers with `parseAs: "string"`
- `readJsonBody(fastifyRequest, rawReq)` + `readTextBody(...)` helpers
- SSE: `text/event-stream` with `reply.raw.write(...)`
- Hooks (request/response)
- `inject({ method, url, headers, body })` for tests
- `app.inject()` returns `{ statusCode, body }`

## Risks (recap)

1. **SSE behavior parity** — Express 5 supports `res.write()` for SSE but buffering/flush differs slightly. Live event stream is core. **Most likely regression spot.**
2. **Body parser edge cases** — Fastify's `parseAs: "string"` has no exact Express equivalent. Test with: empty body, malformed JSON, large body, content-type with charset.
3. **Test surface change** — `inject()` → `supertest`.
4. **Type inference downgrade** — Fastify's route types are stricter. We already use Zod at boundaries, so this is mostly fine.
5. **Middleware order** — Express middleware order is critical. Easy to introduce subtle bugs.

## Step-by-step plan

### Step 1: Biome formatting tune-up (do this first, low risk)

1. Update `biome.json` with the new settings (already drafted).
2. Run `pnpm biome check --write` across the repo to reformat.
3. Run `pnpm typecheck` to confirm nothing broke.
4. Commit as `chore(devops): tune biome for prettier-like readability and stricter style/complexity rules`.

### Step 2: Branch + install (framework swap prep)

1. `git switch -c feat/migrate-fastify-to-express` on `namik` (or `main` — confirm with Namik).
2. Update `apps/api/package.json`:
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
   Drop `fastify` + `@types/fastify`.
3. `pnpm install`.

### Step 3: Rewrite `apps/api/src/server.ts`

In this order:

1. `import fastify from "fastify"` → `import express from "express"`.
2. `fastify({ logger: true })` → `const app = express()`.
3. `removeAllContentTypeParsers()` + custom parsers → standard middleware:
   ```ts
   app.use(express.json({ limit: "10mb" }));
   app.use(express.text({ type: ["text/plain", "text/*"] }));
   app.use(express.urlencoded({ extended: true, limit: "10mb" }));
   ```
4. `readJsonBody()` / `readTextBody()` → just read `req.body` directly (no Fastify dual-API).
5. SSE handler: `res.setHeader()` + `res.write()` + `res.flush()` + `res.end()`.
6. `inject()` test helper → `supertest`-based one in `ServerHandle`.
7. `req.raw` references → just `req`.
8. Add final error handler:
   ```ts
   app.use((err, req, res, next) => {
     console.error(err);
     res.status(err.status || 500).json({ status: "error", error: { message: err.message } });
   });
   ```
9. `app.listen(port)` returns the same `ServerHandle` shape (`{ url, close, inject }`).

### Step 4: Update tests

Tests using old `inject()` → switch to `supertest(app)`.

### Step 5: Verify

```bash
pnpm typecheck
pnpm test
pnpm cli -- api --port 4242 &
pnpm cli -- ask "where is auth handled?" --project noxcrm --depth deep
```

Manual smoke:
- Open the web app, ask a question, watch the SSE stream.
- Trigger a `/dev/run` and confirm SSE events flow.
- Test JSON POST with empty body, malformed JSON, large body.

### Step 6: Commit + merge

- Commit as `feat(api): migrate from fastify to express 5`.
- Open PR against `namik` (or merge directly per policy).

---

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
- [ ] No new `as any` introduced
- [ ] Biome formatting pass on the migrated code

## Rollback

This is a single-PR migration. If it goes sideways:

- `git revert` the merge commit
- `pnpm install` (restores Fastify from lockfile)
- All routes, tests, and web surface return to the previous state

---

## Branch policy (still need)

- Branch off `namik` (current) or `main`?
