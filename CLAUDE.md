# Collection Gallery

A public web gallery for one owner's personal "collection of collections" (meteorites, books, and so on), with a private, passkey-protected admin area. There is a single owner and no visitor accounts.

**The full specification is `docs/REQUIREMENTS.md`. Read it before starting any milestone.**
Decisions recorded there (§13 Decision log) are settled. Don't re-argue them. If something is ambiguous, contradictory or infeasible, stop and ask the owner. Don't guess on anything touching the invariants below.

## Non-negotiable invariants

1. **Private never leaks.** Admin-only fields, and items that are draft, private, wishlist or trashed, MUST be excluded **on the server**. They must never be sent to a public client and then hidden. That applies to HTML, JSON, search indexes, sitemaps, OG tags, embeds, random picks and media URLs. A dedicated "privacy-leak" test suite enforces this (TST-2), and it must pass before any deploy.
2. **Nothing is lost by accident.** Deletes are soft (trash, 30 days), edits keep revision history, and backups are versioned and stored with a second provider (§9).
3. **Privacy by default.** The public and media hosts set no cookies, use no browser storage (localStorage, sessionStorage, IndexedDB) and load no third-party scripts. The single exception is Turnstile, on `/contact` only. Raw IP addresses are never stored.
4. **Secure by default.** Target OWASP ASVS Level 2 (§6). Never weaken CSP or security headers to make something work. Find another way, or ask.
5. **Only the owner creates content.** Visitors can only view, like, and submit the permission-request form.
6. **Cheap.** Stay within Cloudflare free tiers plus Workers Paid ($5/mo). Flag any feature that would push past that before building it.

## Settled stack

Astro + TypeScript (strict) on Cloudflare Workers · D1 (SQLite) via Drizzle ORM · R2 for media · Cloudflare Access with a passkey-enforcing IdP for admin · Zod for validation · Turnstile on /contact only · Cloudflare Email (send_email binding) for the contact form · Backblaze B2 with Object Lock for off-site backups · Vitest + Playwright + axe for tests · GitHub Actions for CI/CD.

## How to work

- Build **milestone by milestone** (§12, in order). When a milestone's exit criteria are met, stop, then summarize what was built, what deviated and what the owner needs to do, and wait for review.
- Keep `docs/PROGRESS.md` current: done / in progress / next / deviations / new dependencies (with a one-line justification each).
- Append any new decision to §13 with its rationale. Never silently change a requirement.
- **Vendor facts in §14 may be out of date.** Check current official docs before relying on them. If one is wrong, propose an alternative that keeps the invariants.
- Use few, well-maintained, widely used dependencies. Never use an abandoned or obscure package for anything security-relevant.
- Turn every acceptance criterion (`AC:`) into an automated test where feasible.
- Never commit secrets. Placeholders `{{OWNER_NAME}}`, `{{DOMAIN}}` and `{{OWNER_EMAIL}}` live in config or env, never hard-coded.
- Tasks only a human can do (accounts, DNS, passkeys, payments) are listed in §15. When one blocks you, tell the owner exactly what to do.

## Commands

Run from the repo root (Node 26, `npm ci` first).

| Command | What it does |
|---|---|
| `npm run dev:public` / `npm run dev:admin` | Astro dev servers on :4321 / :4322 (admin skips Access locally, dev only — D-35) |
| `npm run build` | Builds both Workers. Set `CLOUDFLARE_ENV=staging` to build for staging |
| `npm test` | Core unit/integration tests inside workerd (Vitest) |
| `npm run test:e2e` | Playwright + axe against the **built** Workers (run `npm run build` and `npm run db:migrate:local` first) |
| `npm run lint` | ESLint (incl. the public/admin import boundary) + Prettier check |
| `npm run typecheck` | `tsc` for core/scripts + `astro check` for both apps |
| `npm run check:bundle` | After a build: public bundle has no admin code; no dev bypass or inline scripts shipped |
| `npm run db:generate` | Drizzle: generate a SQL migration from `packages/core/src/db/schema.ts` |
| `npm run db:migrate:local` / `db:migrate:staging` | Apply D1 migrations locally / to staging |
| `npm run deploy:staging` | Deploy both built Workers to staging (CI does this on `main`) |
| `npm run smoke:staging` | Post-deploy checks against real staging (needs `STAGING_*` and `CF_ACCESS_*` env) |
| `npm run backup:verify` | Implemented in M1 (BAK-08) |
