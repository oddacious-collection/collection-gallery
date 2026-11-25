# Restore photos and documents (BAK-07)

What is backed up: every object in **`media-private`** (photo masters,
documents, inbox originals), hourly, into the B2 bucket
`oddacioustreasures-com-staging-media-backups` under `media-private/<key>`.
Deleted originals stay as hidden prior versions for 365 days.

Public photo sizes (`media-public`) are **not** backed up: they are made
from the masters (BAK-03).

## One file

1. Find the key: the admin's **Download original** link shows the photo; the
   key is `media.original_key` in the database.
2. In Backblaze, open the media bucket, browse to `media-private/<key>`
   (tick **Show hidden files** if it was deleted), download it.
3. Put it back:

   ```powershell
   npx.cmd wrangler r2 object put cg-media-private-staging/<key> --file <downloaded file> --remote
   ```

## Many files or the whole bucket

Use the B2 web console's bulk download or the `b2` CLI with the **verify**
key (read-only), then upload each file back with the command above (a small
loop over the downloaded folder). Keys are the file names after
`media-private/`.

## If `media-public` is lost

The masters are safe, but until the derivative regeneration job arrives
(MED-06, M5) the public sizes can't be rebuilt automatically. Interim: for
each affected item, download the original from the admin and add it again as
a photo (the pipeline makes new sizes), then remove the broken photo. Track
this gap in docs/PROGRESS.md until M5 closes it.
