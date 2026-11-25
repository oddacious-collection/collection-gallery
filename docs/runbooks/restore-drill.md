# Restore drill (BAK-08)

A restore drill proves that the backups can actually be restored, not just
that they exist. It runs at the end of M1 and then **quarterly** (2 January,
April, July, October), and whenever the backup code or schema changes a lot.

## Running it

GitHub → **Actions → Restore drill → Run workflow** (branch `main`). It takes
a few minutes. The quarterly run starts by itself; GitHub emails you if it
fails.

The drill (`npm run restore:drill`, `scripts/restore-drill.ts`):

1. downloads the newest daily database export from Backblaze (read-only
   verify key);
2. creates a **scratch** D1 database on the staging account,
   `cg-restore-drill-<date and time>`, and builds the schema with the
   migrations; the export must be from the same schema version;
3. loads the export with the same SQL a real restore uses, checks that every
   link between tables is intact (`PRAGMA foreign_key_check`), and compares
   **every table row for row** with the export; the search index is rebuilt;
4. for every private file the restored database points to (photo originals,
   documents, inbox originals), downloads the backup copy and checks its
   size and SHA-1 against what Backblaze recorded on upload, and that each
   photo's width and height match the database;
5. deletes the scratch database.

The live staging database and photo store are never touched. The log shows
only labels and counts.

**Trial run of the database half without Backblaze keys** (owner's machine,
signed in with `wrangler login`):

```powershell
node scripts/export-db.ts --staging --out C:\temp\drill\staging.json.gz
node scripts/restore-drill.ts --export C:\temp\drill\staging.json.gz
```

Delete `C:\temp\drill` afterwards (it holds a copy of the staging data).

## If it fails

- `schema versions differ`: the export was made before a new migration.
  Normal right after a schema change; re-run the next day.
- `table …: … rows restored` or `broken links`: a restore bug. Don't rely on
  B2 restores until it is fixed; Time Travel (restore-db.md §1) still works
  for the last 30 days.
- `files … not in the backup` or `failed the integrity check`: run
  **Backup verify**; check the backup Worker's alerts and logs.
- `could not delete the scratch database`: delete `cg-restore-drill-…` in
  the Cloudflare dashboard (Storage & databases → D1).

## Using the same steps for a real restore

To rebuild a lost database from Backblaze: **Actions → Restore drill → Run
workflow** with **Keep the restored database** ticked. It leaves a fully
checked database and prints its name (`cg-restore-drill-…`). Then put that
database's name and ID (Cloudflare dashboard → D1) into the Workers'
`apps/*/wrangler.jsonc` in a reviewed PR, deploy, and run the checks in
restore-db.md ("Checks after any restore"). Photos: restore-media.md.

## Record

| Date       | Result                          | Notes                                                                                                                                                                   |
| ---------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-25 | Pass (database half, trial run) | Found and fixed: D1's remote import doesn't keep deferred foreign keys across a file, so the restore SQL now loads parents first and fills forward links in afterwards. |
