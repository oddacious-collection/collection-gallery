# Progress

## Status: M0 Foundations — code done, CI green; Access setup done (2026-11-22); first CI staging deploy pending

### Done (M0)

- **Repo scaffold**: npm workspaces: `apps/public` and `apps/admin` (Astro 7, SSR on Workers), and `packages/core` (shared config, headers, errors, Access validation, Drizzle schema, public data-access layer). TypeScript strict (plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- **Bindings** (ARC-03): public → `DB`, `MEDIA_PUBLIC`; admin → `DB`, `MEDIA_PUBLIC`, `MEDIA_PRIVATE`. Local and staging environments in each `wrangler.jsonc`. `preview_urls: false` everywhere; production `workers_dev: false`.
- **Drizzle + D1**: `settings` table, migration `0000_init.sql`, `db:generate` / `db:migrate:*` scripts. CI applies staging migrations before deploy (OPS-03).
- **Security headers** (SEC-07): one shared policy applied by both Workers and via the generated `_headers` for public static assets. Admin adds Trusted Types and `no-store`. Non-production and admin get `noindex`.
- **Admin auth** (SEC-03): every request, including static assets, passes Access JWT validation (RS256, JWKS, iss/aud/exp, owner email) and fails closed. CSRF check on writes (SEC-04).
- **Public pipeline**: GET/HEAD only, strips any `Set-Cookie`, generic errors.
- **Tests**:
  - 72 Workers-runtime unit tests: TST-03 forged-token matrix, CSRF, config, headers, public DAL.
  - 21 Playwright e2e tests × 3 browsers (Chromium, desktop WebKit, iPhone WebKit): TST-03 against the built admin, TST-04 on every public route type, axe, no cookies/storage/third-party requests, no CSP violations.
- **Guards**:
  - ESLint import boundary (public code → only `@cg/core/public|config|headers|errors`).
  - `npm run check:bundle`: the public bundle has no admin code, the dev bypass isn't shipped, and there are no inline scripts.
- **CI** (`.github/workflows/ci.yml`):
  - Lint, typecheck, unit tests, build, bundle check, `npm audit`, e2e, gitleaks.
  - Staging deploy + smoke test + ZAP baseline. These are gated on the `STAGING_ENABLED` repository variable until Cloudflare is set up.
  - CodeQL workflow. Dependabot (npm + Actions, 7-day cooldown).
- **Docs**: threat model, ASVS 5.0 L2 checklist skeleton, token register, Access runbook; decisions D-20 to D-37 added to §13.
- **Staging resources** (created 2026-11-13): D1 `cg-staging` (migrated to `0000_init`), R2 `cg-media-public-staging` and `cg-media-private-staging`. Workers `cg-public-staging` and `cg-admin-staging` are deployed with `workers_dev` off (no public URL; both return 404).
- **CI is green** on `main` (lint, typecheck, unit, build, e2e, gitleaks, CodeQL).

### Resume point (where we paused)

Owner: Access setup per `docs/runbooks/access-setup.md` — done 2026-11-22.

- [x] R2 enabled; `workers.dev` subdomain chosen (kept out of the repo, D-37)
- [x] `wrangler login` on the owner's machine
- [x] Both staging Workers protected with Worker-level Access, all traffic
- [x] **A.** Team-wide login methods: delete One-time PIN. Keep the team-wide Cloudflare method; just don't allow it on the apps.
- [x] **B.** On each staging app: login methods = GitHub only, Instant Auth on, session 24 h; replace the default "Cloudflare account" policy with Allow → Emails → owner's GitHub primary email; copy the **admin** app's AUD tag.
- [x] **C.** Service token `ci-staging` (1 year) and a Service Auth policy on the **public** app only.
- [x] **D.** `npx.cmd wrangler secret put ADMIN_EMAIL --name cg-admin-staging`
- [x] **E.** Cloudflare API token (account-owned `ci-staging-deploy`): Workers Scripts Edit + D1 Edit, expires 2027-11-22.
- [x] **F.** GitHub environment `staging` (deployment branches: `main` only), with secrets `CLOUDFLARE_API_TOKEN`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`.
- [x] **G.** Team domain and admin AUD collected (the AUD was read from Access's login redirect: the dashboard didn't show it for Worker-level Access apps).

Then Claude:

1. [x] Staging values stored as GitHub `staging` **secrets** (not variables: Actions logs are public, D-37), with log masking in the workflow.
2. [x] `env.staging.workers_dev: true` in both configs. Both `workers.dev` URLs verified to redirect signed-out visitors to Access (2026-11-22).
3. [ ] Push (after owner OK), set `STAGING_ENABLED=true`, watch the deploy, smoke test and ZAP baseline.
4. [ ] The owner checks sign-in in a private browser window (their GitHub account gets in; any other account is refused).
5. [ ] Branch protection on `main` (owner, with Claude's exact settings).
6. [ ] M0 review summary.

### M0 exit criteria

| Criterion                                       | State                                        |
| ----------------------------------------------- | -------------------------------------------- |
| Hello-world public + admin on staging           | ⏳ deployed but not public; Access steps A–G |
| Admin rejects unauthenticated requests (TST-03) | ✅ locally + CI; ⏳ staging smoke test       |
| Headers test passes (TST-04)                    | ✅ locally + CI; ⏳ staging smoke test       |
| CI green                                        | ✅ (2026-11-13)                              |

### Deviations from the spec

All are recorded in `docs/REQUIREMENTS.md` §13 as D-20 to D-37. The main ones:

- Staging runs on `workers.dev` until the domain exists (D-21).
- Staging serves media from the public host (D-25).
- `ADMIN_EMAIL` is split from the contact-form address (D-28).
- `npm audit` is used instead of OSV-Scanner (D-36).

### Known advisories (accepted, dev-only, below the high/critical CI gate)

- `esbuild <=0.24.2` (moderate, GHSA-67mh-4wv8-2f99): pulled in by `drizzle-kit`'s `@esbuild-kit/*`. It affects esbuild's dev server, which we never run. Re-check when drizzle-kit drops `@esbuild-kit`.
- `minimatch` (moderate, GHSA-g3hv-75wg-m249): inside `typescript-eslint` lint tooling only. Dependabot will pick up the fix.

### Dependencies (exact-pinned; one-line justification each)

| Package                                                                             | Where      | Why                                                                                                                      |
| ----------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| `astro`                                                                             | apps       | Settled framework (D-02)                                                                                                 |
| `@astrojs/cloudflare`                                                               | apps       | Official Workers adapter for Astro                                                                                       |
| `@cg/core`                                                                          | apps       | Internal shared package (ARC-02)                                                                                         |
| `zod`                                                                               | core       | Validation at trust boundaries (SEC-05, settled stack)                                                                   |
| `jose`                                                                              | core       | Standard, dependency-free JWT/JWKS verification for SEC-03 (Web Crypto, works in Workers)                                |
| `drizzle-orm`                                                                       | core       | Settled ORM, parameterised queries                                                                                       |
| `drizzle-kit` (dev)                                                                 | core       | Generates forward-only SQL migrations (OPS-03). Its transitive `@esbuild-kit/*` deps are old but dev-only, never shipped |
| `wrangler` (dev)                                                                    | root, apps | Cloudflare CLI: dev, deploy, D1 migrations, types                                                                        |
| `typescript` (dev)                                                                  | root, apps | Strict typing; held at 6.0 for tool compatibility (D-33)                                                                 |
| `@astrojs/check` (dev)                                                              | apps       | Typechecks `.astro` files                                                                                                |
| `vitest` (dev)                                                                      | core       | Unit/integration tests (TST-01)                                                                                          |
| `@cloudflare/vitest-plugin` (dev)                                                   | core       | Runs tests inside workerd (TST-01, D-34)                                                                                 |
| `@cloudflare/workers-types` (dev)                                                   | core, apps | Workers runtime types                                                                                                    |
| `@playwright/test` (dev)                                                            | root       | E2E across Chromium + WebKit (TST-01)                                                                                    |
| `@axe-core/playwright` (dev)                                                        | root       | Accessibility checks in CI (NFR-03)                                                                                      |
| `eslint`, `@eslint/js`, `typescript-eslint`, `eslint-plugin-astro`, `globals` (dev) | root       | Linting incl. the INV-1 import boundary                                                                                  |
| `prettier`, `prettier-plugin-astro` (dev)                                           | root       | Formatting                                                                                                               |
| `@types/node` (dev)                                                                 | root       | Types for build/test scripts                                                                                             |
