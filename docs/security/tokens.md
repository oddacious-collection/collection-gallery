# Token and credential register (SEC-09)

Every credential: purpose, scope (least privilege), where it is stored, rotation.
Values are never written here or anywhere in the repository.

| Name                                                                           | Purpose                                                                                                           | Scope                                                                          | Stored in                            | Created    | Expires / rotate                                                    |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------ | ---------- | ------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN` (CI deploy; account-owned token `ci-staging-deploy`)    | Deploy staging Workers, apply staging D1 migrations, add and read the privacy-leak suite's sentinel rows (TST-02) | Account · Workers Scripts · Edit; Account · D1 · Edit; this account only       | GitHub Environment `staging` secret  | 2026-11-22 | Expires 2027-11-22; rotate on expiry or suspicion                   |
| `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` (`ci-staging` service token) | CI smoke test, ZAP baseline and privacy-leak crawl against **public** staging                                     | Service Auth policy on the `cg-public-staging` Access app only (never admin)   | GitHub Environment `staging` secrets | 2026-11-22 | Expires 2027-11-22; rotate secret in Zero Trust (⋯ → Rotate secret) |
| `ADMIN_EMAIL`                                                                  | The single identity allowed into admin (SEC-03)                                                                   | Worker secret on `cg-admin-staging` (later `cg-admin`)                         | Cloudflare Worker secrets            | 2026-11-22 | On email change                                                     |
| Wrangler OAuth login (owner's machine)                                         | Local resource creation / first deploy                                                                            | Wrangler default OAuth scopes                                                  | Owner's local Wrangler config        | 2026-11-13 | `npx wrangler logout` when not needed                               |
| `GITHUB_TOKEN` (Actions)                                                       | Built-in per-job token                                                                                            | `permissions:` set per job (contents: read; security-events: write for CodeQL) | GitHub-managed                       | n/a        | Per job                                                             |

Planned (later milestones): B2 backup key (write/list, **no delete**, BAK-05), B2
break-glass key (offline, owner only), R2 presigning credentials (M1), Turnstile
secret (M5).

Not credentials, but kept out of the public repo and logs (D-37): `CLOUDFLARE_ACCOUNT_ID`,
`STAGING_PUBLIC_URL`, `STAGING_ADMIN_URL`, `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD_ADMIN` are
GitHub Environment `staging` secrets so Actions masks them.

**Scope caveat:** `CLOUDFLARE_API_TOKEN` is account-wide; Cloudflare can't limit it to the staging Workers or database. Production must get separate credentials before it exists (D-39). In CI it is given only to the migrate, deploy and staging leak-suite steps, never to `npm ci` or the build.

**Local machine:** the owner's `wrangler login` (OAuth) and GitHub CLI login are broad, long-lived credentials (Claude's sessions use them too). Run `npx.cmd wrangler logout` during long breaks.

**Reminder:** renew both CI tokens before 2027-11-22. When they expire, the sites keep
running; only CI deploys and the staging smoke test fail.

## Rotation procedure

See `docs/runbooks/rotate-secrets.md` (written in M1, BAK-07).
