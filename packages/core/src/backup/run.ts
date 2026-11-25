/**
 * One backup run (BAK-02, BAK-03, BAK-06; D-47).
 *
 * - "full" (hourly cron): if today's copy is missing, export the database to `daily/YYYY-MM-DD.json.gz`
 *   (locked 30 days) and, once a month, `monthly/YYYY-MM.json.gz` (locked
 *   365 days); then sync media.
 * - "media": only sync `media-private` into the versioned media bucket,
 *   a bounded number of files per run, so a big first sync spreads out.
 *
 * Media sync uploads originals missing from B2 (locked 365 days) and hides
 * the B2 copy of anything deleted from R2, so it lives on as a prior version
 * for 365 days (bucket lifecycle rule). Storage keys are never reused
 * (MED-13), so a key already in B2 never needs re-uploading.
 *
 * Bucket lifecycle rules (set by the owner, docs/runbooks/backup-setup.md)
 * remove expired daily/monthly copies and old versions; this job can't
 * delete anything itself.
 */
import { z } from 'zod';
import { logEvent } from '../errors.ts';
import {
  authorize,
  bucketId,
  hideFile,
  listFileNames,
  uploadFile,
  type B2Session,
  type Fetch,
} from './b2.ts';
import { exportDatabase, gzip } from './export.ts';

export const DAY_MS = 24 * 3600 * 1000;
export const DAILY_RETAIN_DAYS = 30;
export const MONTHLY_RETAIN_DAYS = 365;
export const MEDIA_RETAIN_DAYS = 365;
export const MEDIA_PREFIX = 'media-private/';
/** Uploads per run: well within one cron invocation's time and subrequests. */
export const MAX_UPLOADS_PER_RUN = 200;

export const BackupConfigSchema = z.object({
  ENVIRONMENT: z.enum(['local', 'staging', 'production']),
  B2_KEY_ID: z.string().min(10),
  B2_APP_KEY: z.string().min(10),
  B2_DB_BUCKET: z.string().min(6).max(63),
  B2_MEDIA_BUCKET: z.string().min(6).max(63),
});
export type BackupConfig = z.infer<typeof BackupConfigSchema>;

export interface BackupBindings {
  DB: D1Database;
  MEDIA_PRIVATE: R2Bucket;
}

export interface BackupReport {
  kind: 'full' | 'media';
  db: {
    daily: string | null;
    monthly: string | null;
    bytes: number;
    tables: number;
    rows: number;
  } | null;
  media: { total: number; uploaded: number; hidden: number; pending: number };
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const month = (d: Date) => d.toISOString().slice(0, 7);

async function r2Keys(bucket: R2Bucket): Promise<Map<string, R2Object>> {
  const out = new Map<string, R2Object>();
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const o of page.objects) out.set(o.key, o);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

export async function syncMedia(
  source: R2Bucket,
  s: B2Session,
  bucket: string,
  now: Date,
  f: Fetch,
  maxUploads = MAX_UPLOADS_PER_RUN,
): Promise<BackupReport['media']> {
  const [inR2, inB2] = await Promise.all([
    r2Keys(source),
    listFileNames(s, bucket, MEDIA_PREFIX, f),
  ]);
  const backedUp = new Set(inB2.map((x) => x.fileName.slice(MEDIA_PREFIX.length)));
  const missing = [...inR2.keys()].filter((k) => !backedUp.has(k));
  const gone = [...backedUp].filter((k) => !inR2.has(k));

  // Safety brake: an empty or truncated listing must never hide the backup.
  if (gone.length > 0 && (inR2.size === 0 || gone.length > Math.max(20, backedUp.size / 4))) {
    throw new Error(
      `refusing to hide ${gone.length} of ${backedUp.size} backed-up files (R2 lists ${inR2.size}); check the bucket binding`,
    );
  }

  let uploaded = 0;
  for (const key of missing.slice(0, maxUploads)) {
    const obj = await source.get(key);
    if (!obj) continue; // deleted since listing
    const bytes = new Uint8Array(await obj.arrayBuffer());
    await uploadFile(
      s,
      bucket,
      `${MEDIA_PREFIX}${key}`,
      bytes,
      {
        contentType: obj.httpMetadata?.contentType ?? 'application/octet-stream',
        retainUntil: new Date(now.getTime() + MEDIA_RETAIN_DAYS * DAY_MS),
      },
      f,
    );
    uploaded++;
  }
  for (const key of gone) await hideFile(s, bucket, `${MEDIA_PREFIX}${key}`, f);
  return {
    total: inR2.size,
    uploaded,
    hidden: gone.length,
    pending: Math.max(0, missing.length - uploaded),
  };
}

export async function runBackup(
  config: BackupConfig,
  bindings: BackupBindings,
  kind: 'full' | 'media',
  now: Date = new Date(),
  f: Fetch = fetch,
): Promise<BackupReport> {
  const s = await authorize(config.B2_KEY_ID, config.B2_APP_KEY, f);
  const [dbBucket, mediaBucket] = await Promise.all([
    bucketId(s, config.B2_DB_BUCKET, f),
    bucketId(s, config.B2_MEDIA_BUCKET, f),
  ]);

  let db: BackupReport['db'] = null;
  const daily = `daily/${day(now)}.json.gz`;
  const monthly = `monthly/${month(now)}.json.gz`;
  const existing =
    kind === 'full'
      ? new Set(
          [
            ...(await listFileNames(s, dbBucket, 'daily/', f)),
            ...(await listFileNames(s, dbBucket, 'monthly/', f)),
          ].map((x) => x.fileName),
        )
      : new Set<string>();
  // Export only when today's (or this month's) copy is still missing: the
  // job runs hourly, so a failed night is retried an hour later.
  if (kind === 'full' && !(existing.has(daily) && existing.has(monthly))) {
    const data = await exportDatabase(bindings.DB, now);
    const bytes = await gzip(JSON.stringify(data));
    const info = { exported: data.exportedAt };
    // One daily copy per day; one monthly copy per month (the first night it runs).
    let wroteDaily: string | null = null;
    if (!existing.has(daily)) {
      await uploadFile(
        s,
        dbBucket,
        daily,
        bytes,
        {
          contentType: 'application/gzip',
          retainUntil: new Date(now.getTime() + DAILY_RETAIN_DAYS * DAY_MS),
          info,
        },
        f,
      );
      wroteDaily = daily;
    }
    let wroteMonthly: string | null = null;
    if (!existing.has(monthly)) {
      await uploadFile(
        s,
        dbBucket,
        monthly,
        bytes,
        {
          contentType: 'application/gzip',
          retainUntil: new Date(now.getTime() + MONTHLY_RETAIN_DAYS * DAY_MS),
          info,
        },
        f,
      );
      wroteMonthly = monthly;
    }
    db = {
      daily: wroteDaily,
      monthly: wroteMonthly,
      bytes: bytes.length,
      tables: Object.keys(data.tables).length,
      rows: Object.values(data.tables).reduce((n, t) => n + t.rows.length, 0),
    };
  }

  const media = await syncMedia(bindings.MEDIA_PRIVATE, s, mediaBucket, now, f);
  logEvent('info', 'backup_done', {
    kind,
    dbBytes: db?.bytes ?? 0,
    dbTables: db?.tables ?? 0,
    mediaTotal: media.total,
    uploaded: media.uploaded,
    hidden: media.hidden,
    pending: media.pending,
  });
  return { kind, db, media };
}

/** Plain-text failure alert (no secrets, no personal data). */
export function alertText(
  environment: string,
  kind: string,
  error: unknown,
  now: Date,
): { subject: string; text: string } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    subject: `[collection-gallery ${environment}] backup FAILED (${kind})`,
    text: [
      `The ${kind} backup run on ${environment} failed at ${now.toISOString()}.`,
      '',
      `Error: ${message.slice(0, 500)}`,
      '',
      'Nothing was deleted: the backup job cannot delete files.',
      'Next steps: docs/runbooks/restore-db.md (troubleshooting) and the Workers logs for cg-backup-' +
        environment +
        '.',
    ].join('\n'),
  };
}
