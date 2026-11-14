# Token and credential register (SEC-09)

Every credential: purpose, scope (least privilege), where it is stored, rotation.
Values are never written here or anywhere in the repository.

| Name                                                                           | Purpose                                                 | Scope                                                                          | Stored in                            | Created   | Expires / rotate                      |
| ------------------------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------ | --------- | ------------------------------------- |
| `CLOUDFLARE_API_TOKEN` (CI deploy)                                             | Deploy staging Workers, apply staging D1 migrations     | Account · Workers Scripts · Edit; Account · D1 · Edit; this account only       | GitHub Environment `staging` secret  | _pending_ | 1 year; rotate on expiry or suspicion |
| `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` (`ci-staging` service token) | CI smoke test + ZAP baseline against **public** staging | Service Auth policy on the `cg-public-staging` Access app only (never admin)   | GitHub Environment `staging` secrets | _pending_ | 1 year                                |
| `ADMIN_EMAIL`                                                                  | The single identity allowed into admin (SEC-03)         | Worker secret on `cg-admin-staging` (later `cg-admin`)                         | Cloudflare Worker secrets            | _pending_ | On email change                       |
| Wrangler OAuth login (owner's machine)                                         | Local resource creation / first deploy                  | Wrangler default OAuth scopes                                                  | Owner's local Wrangler config        | _pending_ | `npx wrangler logout` when not needed |
| `GITHUB_TOKEN` (Actions)                                                       | Built-in per-job token                                  | `permissions:` set per job (contents: read; security-events: write for CodeQL) | GitHub-managed                       | n/a       | Per job                               |

Planned (later milestones): B2 backup key (write/list, **no delete**, BAK-05), B2
break-glass key (offline, owner only), R2 presigning credentials (M1), Turnstile
secret (M5).

## Rotation procedure

See `docs/runbooks/rotate-secrets.md` (written in M1, BAK-07).
