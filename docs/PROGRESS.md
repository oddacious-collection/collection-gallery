# Progress

## Status: M0 Foundations — code complete locally; staging deploy waiting on owner tasks

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
- **Docs**: threat model, ASVS 5.0 L2 checklist skeleton, token register, Access runbook; decisions D-20 to D-36 added to §13.

### In progress

- Staging on Cloudflare: needs the owner tasks in "Next".

### Next (owner tasks to finish M0)

See the M0 summary for step-by-step instructions:

1. Enable R2; send the `workers.dev` subdomain.
2. `npx wrangler login`. Then Claude creates the staging D1 database and R2 buckets and does the first deploy (with `workers.dev` off).
3. Access per `docs/runbooks/access-setup.md`; send the team domain and both AUD tags; set the `ADMIN_EMAIL` secret.
4. CI deploy token and service token into the GitHub `staging` environment. Then Claude turns on `workers.dev` and `STAGING_ENABLED`.
5. Branch protection on `main` once CI has run.

### M0 exit criteria

| Criterion                                       | State                                          |
| ----------------------------------------------- | ---------------------------------------------- |
| Hello-world public + admin on staging           | ⏳ blocked on owner tasks 1–4                  |
| Admin rejects unauthenticated requests (TST-03) | ✅ locally (unit + e2e); ⏳ staging smoke test |
| Headers test passes (TST-04)                    | ✅ locally; ⏳ staging smoke test              |
| CI green                                        | ⏳ after first push                            |

### Deviations from the spec

All are recorded in `docs/REQUIREMENTS.md` §13 as D-20 to D-36. The main ones:

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
