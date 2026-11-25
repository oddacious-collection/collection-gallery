# Restore the database (BAK-07)

Two ways back, newest first. Decide what you need before touching anything:
a single item can usually be fixed from **revision history** or the **trash**
in the admin (BAK-09) with no restore at all.

## 1. D1 Time Travel (any minute in the last 30 days, BAK-01)

Use this when the database is damaged but Cloudflare is fine.

```powershell
npx.cmd wrangler d1 time-travel info cg-staging
```

Note the bookmark or pick a timestamp from before the problem, then:

```powershell
npx.cmd wrangler d1 time-travel restore cg-staging --timestamp=2026-12-01T03:00:00Z
```

Time Travel replaces the **whole** database with its state at that moment.
Afterwards, run `npm run leak:staging` (or redeploy, which runs it) to check
nothing private became public, and check the admin item list.

## 2. From a Backblaze backup (older than 30 days, or Cloudflare lost the data)

The nightly exports in B2 are `daily/YYYY-MM-DD.json.gz` (30 days) and
`monthly/YYYY-MM.json.gz` (12 months). Credentials: the **verify** key (read
only) as `B2_VERIFY_KEY_ID` / `B2_VERIFY_APP_KEY`.

1. **Inspect first**, into a scratch local database (nothing deployed is
   touched):

   ```powershell
   $env:B2_VERIFY_KEY_ID = '...'; $env:B2_VERIFY_APP_KEY = '...'
   npm run db:restore -- --from b2:latest --to-local C:\temp\restore-check
   ```

   (`--from b2:daily/2026-12-01.json.gz` for a specific day.) It creates the
   schema with the migrations, loads the export, rebuilds the search index and
   compares every table's row count. It refuses a target that already has
   items, and refuses an export made with a different schema version: check
   out the commit whose migrations match, restore, then migrate forward.

2. **Restoring a deployed database** (disaster recovery) is a reviewed,
   manual step: create a new D1 database, apply the migrations, load the same
   SQL the script generates, point the Workers' `database_id` at it, deploy,
   then run the privacy-leak suite. The M1 restore drill (BAK-08) walks
   through this on staging; follow `docs/runbooks/restore-drill.md` once it
   exists.

## Checks after any restore

- `npm run leak:staging` passes (nothing private on public pages).
- The admin item list and a few item pages look right; photos load.
- `npm run backup:verify` passes the next day.
