# Runbook: Cloudflare Access for admin and staging

Implements SEC-02 (owner-only admin, passkey/MFA IdP, no one-time PIN, session ≤ 24 h)
and OPS-01 (staging entirely behind Access). See decisions D-22 to D-24 in
`docs/REQUIREMENTS.md` §13.

The owner's email address is never written in this repository. It lives only in
the Access policy and in the `ADMIN_EMAIL` Worker secret.

> Cloudflare's dashboard labels change from time to time. If a label below is
> different, look for the closest match and update this runbook.

## One-time account settings

1. Zero Trust → **Settings → Authentication → Login methods**.
2. Confirm **GitHub** is listed and **Test** succeeds.
3. **Delete "One-time PIN"** (SEC-02: OTP login MUST be disabled).

## Protect each Worker

Do this for every Worker that must be private:

| Worker                  | When                       |
| ----------------------- | -------------------------- |
| `cg-public-staging`     | M0                         |
| `cg-admin-staging`      | M0                         |
| `cg-admin` (production) | M7, before it gets a route |

Use **Worker-level** protection ("Protect this Worker behind Access"), not a
hostname app. It covers the `workers.dev` URL, preview URLs and any custom
domain added later, so a forgotten route can never be public.

1. Dashboard → **Workers & Pages** → select the Worker → **Access** tab (older UI:
   Settings → Domains & Routes) → **Protect this Worker behind Access**.
2. Choose scope **All traffic**.
3. Open the created application in Zero Trust (**Manage Cloudflare Access**, or
   Zero Trust → Access → Applications), then:
   - **Login methods:** untick everything except **GitHub**. Turn on **Instant Auth**.
   - **Session duration:** **24 hours** (or shorter).
   - **Policies:** delete any default policy (e.g. "Cloudflare account").
     Add one policy: **Action Allow** · Include → **Emails** → the owner's
     GitHub primary email. Nothing else.
   - **Public staging only:** add a second policy: **Action Service Auth** ·
     Include → **Service Token** → `ci-staging` (see below). Never add this to
     an admin application.
4. For admin apps, copy the **Application Audience (AUD) Tag**. It isn't secret,
   but it isn't committed either (D-37). Store it as the GitHub `staging`
   environment variable `ACCESS_AUD_ADMIN`, alongside `ACCESS_TEAM_DOMAIN`
   (`https://<team>.cloudflareaccess.com`).

## GitHub `staging` environment secrets (account-identifying values)

None of these are credentials, but the repo and its Actions logs are public.
Stored as **secrets** so GitHub masks them in logs; the workflow also masks the
bare hostname, `workers.dev` subdomain and team name (D-37).

| Secret                  | Value                                               |
| ----------------------- | --------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID                               |
| `STAGING_PUBLIC_URL`    | `https://cg-public-staging.<subdomain>.workers.dev` |
| `STAGING_ADMIN_URL`     | `https://cg-admin-staging.<subdomain>.workers.dev`  |
| `ACCESS_TEAM_DOMAIN`    | `https://<team>.cloudflareaccess.com`               |
| `ACCESS_AUD_ADMIN`      | AUD tag of the `cg-admin-staging` Access app        |

Plus the repository variable `STAGING_ENABLED=true` once everything above is in place.

## Admin email secret

From the repository root, after `npx wrangler login`:

```bash
npx wrangler secret put ADMIN_EMAIL --name cg-admin-staging
```

Paste the GitHub primary email at the prompt. The Worker fails closed (500) until
this is set, and denies (403) any other identity.

## CI service token (public staging only)

1. Zero Trust → Access → **Service credentials → Service Tokens → Create**.
   Name `ci-staging`, duration **1 year**.
2. Copy the **Client ID** and **Client Secret** (the secret is shown once).
3. GitHub → repository **Settings → Environments → staging → Environment
   secrets**: add `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`.
4. Record the expiry in `docs/security/tokens.md`.

## Turning on the workers.dev URL

Only after the Worker is protected:

1. In `apps/<app>/wrangler.jsonc`, `env.staging.workers_dev` → `true`.
2. Deploy, then check in a private browser window that the URL goes straight to
   GitHub sign-in (Instant Auth), and that a different GitHub account is refused.

## Verification (each milestone)

- `npm run smoke:staging` (also runs in CI after every deploy).
- Anonymous requests to either staging host are redirected to
  `*.cloudflareaccess.com`.
- The service token opens public staging but not admin staging.
