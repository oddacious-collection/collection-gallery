/**
 * `npm run backup:verify` (BAK-08): checks that the latest backups exist and
 * are readable, with the read-only verify key. Runs weekly in GitHub Actions
 * (a second alarm, independent of the backup Worker's own email, D-47) and
 * by hand during restore drills.
 *
 * Checks:
 * - the newest daily database export is at most 36 hours old, downloads,
 *   decompresses and parses as a complete export (core tables present);
 * - this month's monthly copy exists (from the 2nd of the month on);
 * - every private original the database knows about (photo masters,
 *   documents, inbox originals) that is older than 2 hours is in the media
 *   backup. Needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID for D1;
 *   without them this check is skipped (and says so).
 *
 * Prints counts only: never keys, names or data (CI logs are public).
 *
 * Env: B2_VERIFY_KEY_ID, B2_VERIFY_APP_KEY; optional B2_DB_BUCKET,
 * B2_MEDIA_BUCKET (default: the staging bucket names).
 */
import {
  authorize,
  bucketId,
  downloadFile,
  gunzip,
  listFileNames,
  parseExport,
  MEDIA_PREFIX,
} from '../packages/core/src/backup/index.ts';
import { d1Query } from './lib/d1.ts';

const HOUR = 3600 * 1000;
const REQUIRED_TABLES = [
  'items',
  'media',
  'media_variants',
  'categories',
  'item_categories',
  'tags',
  'inbox_photos',
  'd1_migrations',
];

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`Missing ${name}.`);
    process.exit(2);
  }
  return v;
}

const dbBucketName = process.env['B2_DB_BUCKET'] ?? 'oddacioustreasures-com-staging-db-backups';
const mediaBucketName =
  process.env['B2_MEDIA_BUCKET'] ?? 'oddacioustreasures-com-staging-media-backups';
const problems: string[] = [];
const ok = (msg: string) => console.log(`ok   ${msg}`);
const bad = (msg: string) => {
  problems.push(msg);
  console.log(`FAIL ${msg}`);
};

const s = await authorize(need('B2_VERIFY_KEY_ID'), need('B2_VERIFY_APP_KEY'));
const [dbBucket, mediaBucket] = await Promise.all([
  bucketId(s, dbBucketName),
  bucketId(s, mediaBucketName),
]);
const now = Date.now();

// ---- database exports
const dailies = (await listFileNames(s, dbBucket, 'daily/')).sort((a, b) =>
  a.fileName.localeCompare(b.fileName),
);
const latest = dailies.at(-1);
if (!latest) {
  bad('no daily database export found');
} else {
  const ageH = (now - latest.uploadTimestamp) / HOUR;
  if (ageH > 36) bad(`newest daily export is ${ageH.toFixed(1)} hours old (limit 36)`);
  else
    ok(`newest daily export is ${ageH.toFixed(1)} hours old (${dailies.length} daily copies kept)`);
  try {
    const data = parseExport(await gunzip(await downloadFile(s, dbBucketName, latest.fileName)));
    const missing = REQUIRED_TABLES.filter((t) => !data.tables[t]);
    if (missing.length > 0) bad(`export lacks ${missing.length} core table(s)`);
    const rows = Object.values(data.tables).reduce((n, t) => n + t.rows.length, 0);
    ok(`export parses: ${Object.keys(data.tables).length} tables, ${rows} rows`);
  } catch (err) {
    bad(`newest export can't be read: ${err instanceof Error ? err.message : 'unknown error'}`);
  }
}
const monthlies = await listFileNames(s, dbBucket, 'monthly/');
const thisMonth = `monthly/${new Date(now).toISOString().slice(0, 7)}.json.gz`;
if (monthlies.some((f) => f.fileName === thisMonth))
  ok(`this month's copy exists (${monthlies.length} monthly copies kept)`);
else if (new Date(now).getUTCDate() >= 2) bad("this month's monthly copy is missing");
else ok("this month's monthly copy is due today");

// ---- media
const backedUp = new Set(
  (await listFileNames(s, mediaBucket, MEDIA_PREFIX)).map((f) =>
    f.fileName.slice(MEDIA_PREFIX.length),
  ),
);
ok(`media backup holds ${backedUp.size} files`);
if (process.env['CLOUDFLARE_API_TOKEN'] && process.env['CLOUDFLARE_ACCOUNT_ID']) {
  const cutoff = new Date(now - 2 * HOUR).toISOString();
  const target = { kind: 'remote', env: 'staging' } as const;
  const expected = [
    ...d1Query<{ k: string }>(
      target,
      `SELECT original_key AS k FROM media WHERE created_at < '${cutoff}'`,
    ),
    ...d1Query<{ k: string }>(
      target,
      `SELECT key AS k FROM documents WHERE created_at < '${cutoff}'`,
    ),
    ...d1Query<{ k: string }>(
      target,
      `SELECT json_extract(p.value, '$.key') AS k FROM inbox_photos, json_each(inbox_photos.parts) AS p
       WHERE json_extract(p.value, '$.role') = 'original' AND inbox_photos.created_at < '${cutoff}'`,
    ),
  ]
    .map((r) => r.k)
    // The privacy-leak suite's sentinel rows have no files by design (D-56).
    .filter((k) => !k.startsWith('0sentkey'));
  const missing = expected.filter((k) => !backedUp.has(k));
  if (missing.length > 0)
    bad(`${missing.length} of ${expected.length} private originals are not in the media backup`);
  else ok(`all ${expected.length} private originals older than 2 hours are in the media backup`);
} else {
  console.log('skip media cross-check (no Cloudflare credentials for D1)');
}

if (problems.length > 0) {
  console.error(`\nbackup:verify FAILED: ${problems.length} problem(s).`);
  process.exit(1);
}
console.log('\nbackup:verify passed.');
