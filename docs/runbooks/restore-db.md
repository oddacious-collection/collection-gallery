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
   manual step: build a new, checked database with the restore drill script
   (`--keep`), point the Workers' `database_id` at it, deploy, then run the
   checks below. Steps: `docs/runbooks/restore-drill.md`, "Using the same
   steps for a real restore".

## Checks after any restore

- `npm run leak:staging` passes (nothing private on public pages).
- The admin item list and a few item pages look right; photos load.
- `npm run backup:verify` passes the next day.

## Troubleshooting: a backup-failure email arrived

The backup Worker emails the alert address when an hourly run fails
(sender `backups@oddacioustreasures.com`, subject "backup FAILED"). The time
in the email is when the run started. The email itself can arrive late: the
first one (2026-11-25) took about two hours. So first check whether the
problem is still there: in GitHub, **Actions → Backup verify → Run
workflow**. If that passes, a later run has already caught up.

| Error in the email                                         | What it means                                                                                                          | What to do                                                                                                                                                  |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `photo upload(s) failed after retries` or `B2 5xx` / `524` | Backblaze was slow or busy. Each call is retried 4 times; other photos still copied.                                   | Nothing, unless it repeats for a day: the next hourly run tries again. If it repeats, check <https://status.backblaze.com>.                                 |
| `B2 401` (`unauthorized`, `bad_auth_token`)                | The job key was deleted or replaced.                                                                                   | Make new keys: `docs/runbooks/rotate-secrets.md`.                                                                                                           |
| `no access to bucket …`                                    | A bucket was renamed or deleted, or the key doesn't cover it.                                                          | Check the bucket names in `apps/backup/wrangler.jsonc` against Backblaze.                                                                                   |
| `refusing to hide …`                                       | The private photo store suddenly listed far fewer files than the backup holds. The job stopped instead of hiding them. | Don't work around it. Check the photo store (R2 `cg-media-private-staging`) and the Worker's bucket binding; restore photos if needed (`restore-media.md`). |
| a configuration error (`B2_KEY_ID`, `ALERT_TO`, …)         | A Worker secret is missing.                                                                                            | Re-run `scripts/b2-setup-keys.ps1` (part B of `backup-setup.md`).                                                                                           |

The backup job can never delete or overwrite a locked copy, so a failed run
never damages existing backups.
