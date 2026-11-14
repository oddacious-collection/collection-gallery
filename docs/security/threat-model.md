# Threat model (STRIDE) — SEC-01

Living document: updated at the end of every milestone. Last update: **M0** (2026-11-13).

## System and trust boundaries

```
 Visitor browser ──HTTPS──▶ Cloudflare edge ──▶ public Worker ──▶ D1 (read via public DAL)
                                              │                └─▶ R2 media-public (M1)
                                              │
 Owner browser ──HTTPS──▶ Cloudflare Access ──▶ admin Worker ──▶ D1 (read/write)
   (GitHub sign-in,       (policy: owner        (validates JWT    ├─▶ R2 media-public
    passkey)               email only)           itself, SEC-03)  └─▶ R2 media-private

 GitHub Actions ──(API token)──▶ Cloudflare (deploy, migrate)
                ──(service token)──▶ Access ──▶ public staging only (smoke, ZAP)

 Nightly backups (M1) ──▶ Backblaze B2 (Object Lock, write-no-delete key)
```

| #   | Boundary                         | Crossing                       |
| --- | -------------------------------- | ------------------------------ |
| TB1 | Internet → public Worker         | Anonymous HTTP requests        |
| TB2 | Internet → Access → admin Worker | Owner's authenticated requests |
| TB3 | Workers → D1 / R2                | Bindings (in-account)          |
| TB4 | GitHub → Cloudflare              | CI deploy credentials          |
| TB5 | Dependencies → build             | npm packages, GitHub Actions   |
| TB6 | Cloudflare → B2                  | Backup credentials (M1)        |

## Assets

1. **Private data**: admin-only fields (price, value, provenance, documents), non-public items (draft, private, wishlist, trashed), private media originals.
2. **Integrity of public content**: only the owner can change it.
3. **Admin access**: the owner's GitHub account and Access session.
4. **Visitor privacy**: no tracking, no IPs stored.
5. **Availability** of the public site (cheap, behind Cloudflare).
6. **Backups**.

## STRIDE

Status: ✅ mitigated in M0 · 🔜 planned (milestone) · ⚠️ accepted residual risk.

### Spoofing

| Threat                                                                   | Mitigation                                                                                                                                                             | Status                  |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Attacker reaches admin without being the owner                           | Access (GitHub IdP only, email policy, OTP disabled); Worker independently verifies JWT signature/iss/aud/exp/email on every request incl. assets (`run_worker_first`) | ✅ (D-22, D-29; TST-03) |
| Forged or replayed `Cf-Access-Jwt-Assertion` sent straight to the Worker | RS256-only verification against team JWKS; `alg:none`, HS256 confusion, wrong key, expired, wrong aud/iss/email all rejected                                           | ✅ (`access.test.ts`)   |
| Owner's GitHub account phished (password + TOTP fallback)                | Passkey sign-in, GitHub mandatory 2FA, recovery codes offline                                                                                                          | ⚠️ D-23                 |
| Access service token misused                                             | Token only on **public staging** app; admin rejects tokens without the owner email                                                                                     | ✅ (D-24, smoke test)   |
| Spoofed visitor actions (likes, contact)                                 | Rate limits, Turnstile, HMAC dedupe                                                                                                                                    | 🔜 M5/M6                |

### Tampering

| Threat                                      | Mitigation                                                                                                                                              | Status                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Cross-site request forgery against admin    | Non-GET + exact `Origin` + `Sec-Fetch-Site` + custom header; Astro `checkOrigin`                                                                        | ✅ (SEC-04 tests)                        |
| Public Worker used to write data            | Public pipeline allows GET/HEAD only (M0); no admin routes/code in bundle                                                                               | ✅ (bundle check, ESLint boundary)       |
| Malicious upload (polyglot, SVG, oversized) | Client re-encode + server magic-byte/size checks                                                                                                        | 🔜 M1 (MED-01–03)                        |
| Supply-chain compromise (npm/Actions)       | Exact pins + lockfile + `npm ci`; 7-day release-age floor; install scripts blocked; Actions pinned to SHAs; Dependabot with cooldown; npm audit; CodeQL | ✅ (D-33)                                |
| SQL injection                               | Drizzle parameterised queries only                                                                                                                      | ✅ (pattern), 🔜 enforced as model grows |
| Stored XSS via descriptions                 | Restricted Markdown + allowlist sanitiser; strict CSP, no inline script                                                                                 | 🔜 M1 (SEC-06); CSP ✅                   |

### Repudiation

| Threat                      | Mitigation            | Status                 |
| --------------------------- | --------------------- | ---------------------- |
| Admin change with no record | Audit log + revisions | 🔜 M1 (SEC-13, ADM-05) |

### Information disclosure

| Threat                                   | Mitigation                                                                                               | Status                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Private fields/items in public responses | Single public DAL selecting allowlisted fields; ESLint import boundary; bundle check; privacy-leak suite | ✅ DAL + boundary; 🔜 TST-02 in M1 |
| Staging indexed or public                | Worker-level Access; `X-Robots-Tag: noindex`; robots disallow; preview URLs off                          | ✅                                 |
| Preview/version URLs bypass Access       | `preview_urls: false` on every Worker; Worker-level Access covers previews anyway                        | ✅ (D-30)                          |
| Stack traces / internals in errors       | Generic error bodies; structured logs without PII                                                        | ✅ (SEC-12 tests)                  |
| IPs/PII in logs                          | Invocation logs disabled; app logs carry reasons only                                                    | ✅ (D-32)                          |
| Secrets in repo                          | `.dev.vars` ignored; gitleaks in CI; GitHub secret scanning/push protection (public repo)                | ✅                                 |
| Private media URL guessed                | ≥128-bit random keys; visibility check on serve                                                          | 🔜 M1 (MED-10)                     |

### Denial of service / cost

| Threat                     | Mitigation                                                                                                  | Status            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------- |
| Request floods run up cost | Cloudflare edge DDoS; Workers Paid included quotas; static assets served without invoking the public Worker | ✅ baseline       |
| Expensive endpoints abused | Rate-limit bindings                                                                                         | 🔜 M1/M5 (SEC-11) |

### Elevation of privilege

| Threat                                            | Mitigation                                                                                                             | Status         |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------- |
| Public code path reaches admin capabilities       | Separate Workers; public has no `media-private` binding; import boundary                                               | ✅ (ARC-01/03) |
| Dev-server Access bypass ships to production      | Only behind build-time `import.meta.env.DEV`; refuses unless `ENVIRONMENT=local`; bundle check fails if marker present | ✅ (D-35)      |
| Misconfigured deploy (e.g. "local" label in prod) | Zod config schema ties environment to origins; fails closed                                                            | ✅             |

## Residual risks and notes

- D1 bindings are full read/write; the public Worker's read-only behaviour is enforced in code, not by the platform.
- `workers.dev` staging can't exercise CDN cache purging; the domain must exist before M1 ends (D-21).
