# Threat model (STRIDE) — SEC-01

Living document: updated at the end of every milestone. Last update: **M1 kickoff** (2026-11-23).

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

 Owner browser: photo processing (decode, orient, strip ALL metadata, resize, encode)
   ──▶ admin Worker ──▶ R2 (proxied upload, D-46; server verifies each file before storing)

 backup Worker (cron, no routes) ──▶ D1 (read) + R2 media-private (read)
   ──(write-and-lock, no-delete key)──▶ Backblaze B2 (Object Lock, versioned)
   ──(send_email, failures only)──▶ owner's verified mailbox
```

| #   | Boundary                         | Crossing                       |
| --- | -------------------------------- | ------------------------------ |
| TB1 | Internet → public Worker         | Anonymous HTTP requests        |
| TB2 | Internet → Access → admin Worker | Owner's authenticated requests |
| TB3 | Workers → D1 / R2                | Bindings (in-account)          |
| TB4 | GitHub → Cloudflare              | CI deploy credentials          |
| TB5 | Dependencies → build             | npm packages, GitHub Actions   |
| TB6 | backup Worker → B2               | Backup credentials (M1, D-47)  |
| TB7 | Owner device → admin Worker      | Uploaded media (M1)            |

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

| Threat                                                                                            | Mitigation                                                                                                                                                                                                 | Status                          |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Attacker reaches admin without being the owner                                                    | Access (GitHub IdP only, email policy, OTP disabled); Worker independently verifies JWT signature/iss/aud/exp/email on every request incl. assets (`run_worker_first`)                                     | ✅ (D-22, D-29; TST-03)         |
| Forged or replayed `Cf-Access-Jwt-Assertion` sent straight to the Worker                          | RS256-only verification against team JWKS; `alg:none`, HS256 confusion, wrong key, expired, wrong aud/iss/email all rejected                                                                               | ✅ (`access.test.ts`)           |
| Owner's GitHub account phished (password + TOTP fallback)                                         | Passkey sign-in, GitHub mandatory 2FA, recovery codes offline                                                                                                                                              | ⚠️ D-23                         |
| A custom domain attached to a Worker is public (Worker-level Access doesn't cover custom domains) | Rule: a hostname Access app must exist before any staging/admin custom domain is attached; staging stays on `workers.dev` in M1; smoke test checks anonymous requests are blocked on every configured host | ✅ rule (D-22 corrected), 🔜 M7 |
| Access service token misused                                                                      | Token only on **public staging** app; admin rejects tokens without the owner email                                                                                                                         | ✅ (D-24, smoke test)           |
| Spoofed visitor actions (likes, contact)                                                          | Rate limits, Turnstile, HMAC dedupe                                                                                                                                                                        | 🔜 M5/M6                        |

### Tampering

| Threat                                                   | Mitigation                                                                                                                                                                                                                          | Status                                    |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Cross-site request forgery against admin                 | Non-GET + exact `Origin` + `Sec-Fetch-Site` + custom header; Astro `checkOrigin`                                                                                                                                                    | ✅ (SEC-04 tests)                         |
| Public Worker used to write data                         | Public pipeline allows GET/HEAD only (M0); no admin routes/code in bundle                                                                                                                                                           | ✅ (bundle check, ESLint boundary)        |
| Malicious upload (polyglot, SVG, oversized)              | Client sniffs real type and re-encodes from pixels; server verifies every file before storing it: magic bytes, full JPEG/WebP structure, no trailing data, no metadata, exact planned size, size limits (owner-only uploads, INV-5) | ✅ M1 (MED-01–03, D-51; core + e2e tests) |
| Supply-chain compromise (npm/Actions)                    | Exact pins + lockfile + `npm ci`; 7-day release-age floor; install scripts blocked; Actions pinned to SHAs; Dependabot with cooldown; npm audit; CodeQL                                                                             | ✅ (D-33)                                 |
| SQL injection                                            | Drizzle parameterised queries only                                                                                                                                                                                                  | ✅ (pattern), 🔜 enforced as model grows  |
| WebAssembly WebP encoder in admin (`'wasm-unsafe-eval'`) | Admin only; scripts still `'self'`, Trusted Types still enforced; exact-pinned, justified dependency; public CSP unchanged (header tests); e2e runs the built encoder under the real admin CSP                                      | ✅ M1 (D-44)                              |
| Backups destroyed with a stolen job key                  | Job key can't delete or bypass governance; Object Lock per object; break-glass key offline; separate backup Worker holds the key                                                                                                    | 🔜 M1 (D-47, BAK-04/05)                   |
| Stored XSS via descriptions                              | Restricted Markdown + allowlist sanitiser; strict CSP, no inline script                                                                                                                                                             | 🔜 M1 (SEC-06); CSP ✅                    |

### Repudiation

| Threat                      | Mitigation            | Status                 |
| --------------------------- | --------------------- | ---------------------- |
| Admin change with no record | Audit log + revisions | 🔜 M1 (SEC-13, ADM-05) |

### Information disclosure

| Threat                                                                           | Mitigation                                                                                                                                                                                                                                                                              | Status                             |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Private fields/items in public responses                                         | Single public DAL selecting allowlisted fields; ESLint import boundary; bundle check; privacy-leak suite                                                                                                                                                                                | ✅ DAL + boundary; 🔜 TST-02 in M1 |
| Staging indexed or public                                                        | Worker-level Access; `X-Robots-Tag: noindex`; robots disallow; preview URLs off                                                                                                                                                                                                         | ✅                                 |
| Preview/version URLs bypass Access                                               | `preview_urls: false` on every Worker; Worker-level Access covers previews anyway                                                                                                                                                                                                       | ✅ (D-30)                          |
| Stack traces / internals in errors                                               | Generic error bodies; structured logs without PII                                                                                                                                                                                                                                       | ✅ (SEC-12 tests)                  |
| IPs/PII in logs                                                                  | Invocation logs disabled; app logs carry reasons only                                                                                                                                                                                                                                   | ✅ (D-32)                          |
| Secrets in repo                                                                  | `.dev.vars` ignored; gitleaks in CI; GitHub secret scanning/push protection (public repo)                                                                                                                                                                                               | ✅                                 |
| Photo metadata identifies the owner (GPS, serials, device, software, timestamps) | Photos are redrawn from pixels on the device; the server refuses any file still carrying metadata; only creator and copyright (pen name, from server config) are written back, byte-for-byte checked; e2e uploads a camera photo full of sentinel metadata and finds none in any output | ✅ M1 (D-43, MED-07, TST-05)       |
| Owner's email address exposed via backup alerts                                  | Address stored as a Worker secret, never committed; Email Routing with no inbound rules; alert text has no collection data                                                                                                                                                              | 🔜 M1 (D-47)                       |
| Private media URL guessed                                                        | ≥128-bit random keys; every request re-checks that the key is a public variant (never a master) of a non-removed photo of a publicly visible item, else the same 404 as an unknown key; no edge caching in M1 (D-45), browsers keep files ≤ 60 s                                        | ✅ M1 (MED-10; core + e2e tests)   |
| Search index exposes non-public text                                             | FTS rows hold only public fields of publicly visible items, rewritten in the same D1 batch as every change that affects them; public search also joins `items` with the one visibility rule; tests check every visibility transition, admin fields and category renames/moves           | ✅ M1 (PUB-08, INV-1)              |
| Item descriptions inject HTML/script (stored XSS)                                | Restricted Markdown renderer escapes every character and emits a fixed tag set; links limited to http/https/mailto with `rel=nofollow noopener noreferrer`; strict CSP as a backstop                                                                                                    | ✅ M1 (SEC-06)                     |

### Denial of service / cost

| Threat                                    | Mitigation                                                                                                                                                                                         | Status                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Request floods run up cost                | Cloudflare edge DDoS; Workers Paid included quotas; static assets served without invoking the public Worker                                                                                        | ✅ baseline                                            |
| Expensive endpoints abused (search in M1) | Search: Workers rate-limit binding, one shared key per Cloudflare location (no visitor data, D-53); words-only FTS queries (max 8 words, 100 chars, 1000 results); feed fragment capped at 5 items | ✅ M1 search (SEC-11); likes, contact, random in M3–M5 |

### Elevation of privilege

| Threat                                            | Mitigation                                                                                                             | Status         |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------- |
| Public code path reaches admin capabilities       | Separate Workers; public has no `media-private` binding; import boundary                                               | ✅ (ARC-01/03) |
| Dev-server Access bypass ships to production      | Only behind build-time `import.meta.env.DEV`; refuses unless `ENVIRONMENT=local`; bundle check fails if marker present | ✅ (D-35)      |
| Misconfigured deploy (e.g. "local" label in prod) | Zod config schema ties environment to origins; fails closed                                                            | ✅             |

## Residual risks and notes

- D1 bindings are full read/write; the public Worker's read-only behaviour is enforced in code, not by the platform.
- No edge caching until M7 (D-45). Every request is served live, so hiding an item takes effect immediately; caching with a TTL of 60 s or less arrives with the domain move.
- Browsers that already displayed an image may keep it in their own cache after the item is hidden; nothing can revoke that. New requests are refused at once.
