/**
 * `npm run restore:drill` (BAK-08): a full restore from Backblaze into
 * staging, without touching the live staging database.
 *
 * 1. Downloads the newest daily database export with the read-only verify key.
 * 2. Creates a scratch D1 database on the staging account
 *    (`cg-restore-drill-<time>`), builds the schema with the migrations,
 *    checks the export's schema version matches, and loads the export with
 *    the same SQL a real restore uses (search index rebuilt).
 * 3. Reads every table back and compares it row for row with the export.
 * 4. For every private file the restored database points to (photo
 *    originals, documents, inbox originals), downloads the backup copy and
 *    checks its SHA-1 against the one B2 checked on upload, and for photos
 *    that the JPEG's width and height match the database.
 * 5. Deletes the scratch database (unless `--keep`).
 *
 * Prints labels and counts only: never keys, IDs, file names or data (CI
 * logs are public). Runs in GitHub Actions (restore-drill.yml), quarterly
 * and on demand; see docs/runbooks/restore-drill.md.
 *
 * Env: B2_VERIFY_KEY_ID, B2_VERIFY_APP_KEY, CLOUDFLARE_API_TOKEN (D1 edit),
 * CLOUDFLARE_ACCOUNT_ID; optional B2_DB_BUCKET, B2_MEDIA_BUCKET.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  MEDIA_PREFIX,
  authorize,
  bucketId,
  downloadFile,
  exportedMigrations,
  gunzip,
  listFileNames,
  parseExport,
  restoreStatements,
  tableKeys,
  FOREIGN_KEYS_SQL,
  PRIMARY_KEYS_SQL,
  type B2Session,
} from '../packages/core/src/backup/index.ts';
import { isJpeg, parseJpeg } from '../packages/core/src/media/jpeg.ts';
import { ROOT, d1File, d1Migrate, d1Query, wrangler, type D1Target } from './lib/d1.ts';

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`Missing ${name}.`);
    process.exit(2);
  }
  return v;
}

const keep = process.argv.includes('--keep') || process.env['DRILL_KEEP'] === 'true';
const dbBucketName = process.env['B2_DB_BUCKET'] ?? 'oddacioustreasures-com-staging-db-backups';
const mediaBucketName =
  process.env['B2_MEDIA_BUCKET'] ?? 'oddacioustreasures-com-staging-media-backups';

const problems: string[] = [];
const ok = (msg: string) => console.log(`ok   ${msg}`);
const bad = (msg: string) => {
  problems.push(msg);
  console.log(`FAIL ${msg}`);
};
const quoteId = (name: string) => `"${name.replace(/"/g, '""')}"`;

// 1. The newest daily export (or, for a trial run of the database half
// without B2 keys, a local export file: `--export <file.json.gz>`).
const exportFile = process.argv.includes('--export')
  ? process.argv[process.argv.indexOf('--export') + 1]
  : undefined;
const s = exportFile ? null : await authorize(need('B2_VERIFY_KEY_ID'), need('B2_VERIFY_APP_KEY'));
async function loadExport(): Promise<Uint8Array> {
  if (!s) return new Uint8Array(readFileSync(exportFile ?? ''));
  const newest = (await listFileNames(s, await bucketId(s, dbBucketName), 'daily/'))
    .map((f) => f.fileName)
    .sort()
    .at(-1);
  if (!newest) throw new Error('no daily export in the backup bucket');
  return downloadFile(s, dbBucketName, newest);
}
const data = parseExport(await gunzip(await loadExport()));
const totalRows = Object.values(data.tables).reduce((n, t) => n + t.rows.length, 0);
ok(
  `${s ? 'downloaded the newest export' : 'read the local export'} (${data.exportedAt.slice(0, 16)}Z): ${Object.keys(data.tables).length} tables, ${totalRows} rows`,
);

// 2. A scratch database with its own config file.
const name = `cg-restore-drill-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}`;
const dir = mkdtempSync(path.join(tmpdir(), 'cg-drill-'));
let created = false;
try {
  wrangler(['d1', 'create', name]);
  created = true;
  const info = JSON.parse(wrangler(['d1', 'info', name, '--json'])) as { uuid?: string };
  if (!info.uuid) throw new Error('could not read the scratch database ID');
  const config = path.join(dir, 'wrangler.jsonc');
  writeFileSync(
    config,
    JSON.stringify({
      name: 'cg-restore-drill',
      compatibility_date: '2026-11-01',
      d1_databases: [
        {
          binding: 'DB',
          database_name: name,
          database_id: info.uuid,
          migrations_dir: path.join(ROOT, 'packages/core/migrations'),
        },
      ],
    }),
  );
  const target: D1Target = { kind: 'remote-config', config };
  ok('created a scratch database on the staging account (the live one is not touched)');

  d1Migrate(target);
  const applied = d1Query<{ name: string }>(
    target,
    'SELECT name FROM d1_migrations ORDER BY name',
  ).map((r) => r.name);
  const exported = exportedMigrations(data);
  if (JSON.stringify(applied) !== JSON.stringify(exported)) {
    bad(
      `schema versions differ (export: ${exported.length} migrations, code: ${applied.length}); ` +
        'restore with the code version the export was made with',
    );
    throw new Error('schema mismatch');
  }
  ok(`schema built by the migrations (${applied.length}), same version as the export`);

  const sql = path.join(dir, 'restore.sql');
  const keys = tableKeys(
    d1Query<{ tbl: string; col: string; ref: string; nn: number }>(target, FOREIGN_KEYS_SQL),
    d1Query<{ tbl: string; col: string }>(target, PRIMARY_KEYS_SQL),
  );
  writeFileSync(sql, `${restoreStatements(data, keys).join('\n')}\n`);
  d1File(target, sql);
  const broken = d1Query(target, 'PRAGMA foreign_key_check').length;
  if (broken > 0) bad(`${broken} broken links between tables after loading`);
  else ok('export loaded with the restore SQL; every link between tables is intact');

  // 3. Every table, row for row.
  let tablesSame = 0;
  for (const [table, t] of Object.entries(data.tables)) {
    if (table === 'd1_migrations') continue;
    const restored: string[] = [];
    for (let offset = 0; ; offset += 500) {
      const rows = d1Query<Record<string, unknown>>(
        target,
        `SELECT * FROM ${quoteId(table)} ORDER BY rowid LIMIT 500 OFFSET ${offset}`,
      );
      for (const r of rows) restored.push(JSON.stringify(t.columns.map((c) => r[c] ?? null)));
      if (rows.length < 500) break;
    }
    const expected = t.rows.map((r) => JSON.stringify(r));
    const same =
      restored.length === expected.length &&
      JSON.stringify([...restored].sort()) === JSON.stringify([...expected].sort());
    if (same) tablesSame++;
    else
      bad(
        `table ${table}: ${restored.length} rows restored, ${expected.length} in the export, or contents differ`,
      );
  }
  const dataTables = Object.keys(data.tables).filter((x) => x !== 'd1_migrations').length;
  if (tablesSame === dataTables) ok(`all ${dataTables} tables match the export row for row`);
  const indexed =
    d1Query<{ n: number }>(target, 'SELECT count(*) AS n FROM search_index')[0]?.n ?? 0;
  const visible =
    d1Query<{ n: number }>(
      target,
      "SELECT count(*) AS n FROM items WHERE status = 'public' AND kind = 'owned' AND deleted_at IS NULL",
    )[0]?.n ?? 0;
  if (visible > 0 && indexed === 0) bad('search index is empty after the rebuild');
  else ok(`search index rebuilt (${indexed} entries for ${visible} public items)`);

  // 4. Every private file the restored database points to.
  const files: Array<{ k: string; w?: number | null; h?: number | null; image: boolean }> = [
    ...d1Query<{ k: string; w: number | null; h: number | null; kind: string }>(
      target,
      'SELECT original_key AS k, width AS w, height AS h, kind FROM media',
    ).map((r) => ({ k: r.k, w: r.w, h: r.h, image: r.kind === 'image' })),
    ...d1Query<{ k: string }>(target, 'SELECT key AS k FROM documents').map((r) => ({
      k: r.k,
      image: false,
    })),
    ...d1Query<{ k: string }>(
      target,
      `SELECT json_extract(p.value, '$.key') AS k FROM inbox_photos, json_each(inbox_photos.parts) AS p
       WHERE json_extract(p.value, '$.role') = 'original'`,
    ).map((r) => ({ k: r.k, image: true })),
    // The privacy-leak suite's sentinel rows have no files by design (D-56).
  ].filter((f) => !f.k.startsWith('0sentkey'));
  if (s) await checkFiles(s, files);
  else console.log(`skip files check (local export, no B2 keys): ${files.length} files referenced`);
} catch (err) {
  if (problems.length === 0) {
    // Wrangler's own error line says what went wrong (it names no secrets).
    const stderr = String((err as { stderr?: unknown }).stderr ?? '');
    const why =
      stderr
        .split('\n')
        .find((l) => /error/i.test(l))
        ?.trim()
        .slice(0, 300) ?? (err instanceof Error ? err.message.split('\n')[0] : 'unknown error');
    bad(`drill stopped: ${why}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
  if (created && !keep) {
    try {
      wrangler(['d1', 'delete', name, '-y']);
      ok('scratch database deleted');
    } catch {
      bad(`could not delete the scratch database ${name}; delete it in the dashboard`);
    }
  } else if (created) {
    console.log(`kept the scratch database ${name} (--keep); delete it when done`);
  }
}

if (problems.length > 0) {
  console.log(`\nrestore drill FAILED: ${problems.length} problem(s).`);
  process.exit(1);
}
console.log('\nrestore drill passed.');

/** Step 4: each file is in the backup, downloads, and matches its checksum and photo size. */
async function checkFiles(
  s: B2Session,
  files: Array<{ k: string; w?: number | null; h?: number | null; image: boolean }>,
): Promise<void> {
  const mediaBucket = await bucketId(s, mediaBucketName);
  const inB2 = new Map(
    (await listFileNames(s, mediaBucket, MEDIA_PREFIX)).map((f) => [
      f.fileName.slice(MEDIA_PREFIX.length),
      f,
    ]),
  );
  let intact = 0;
  let missing = 0;
  let corrupt = 0;
  let bytes = 0;
  for (const f of files) {
    const b2 = inB2.get(f.k);
    if (!b2) {
      missing++;
      continue;
    }
    const body = await downloadFile(s, mediaBucketName, `${MEDIA_PREFIX}${f.k}`);
    bytes += body.length;
    const sha1 = createHash('sha1').update(body).digest('hex');
    let good = body.length === b2.contentLength && sha1 === b2.contentSha1;
    if (good && f.image && isJpeg(body) && f.w && f.h) {
      const jpeg = parseJpeg(body);
      good = jpeg.width === f.w && jpeg.height === f.h;
    }
    if (good) intact++;
    else corrupt++;
  }
  if (missing > 0)
    bad(`${missing} of ${files.length} files the database points to are not in the backup`);
  if (corrupt > 0) bad(`${corrupt} of ${files.length} backed-up files failed the integrity check`);
  if (missing === 0 && corrupt === 0)
    ok(
      `all ${intact} private files downloaded intact (${(bytes / 1e6).toFixed(1)} MB; checksums and photo sizes match)`,
    );
}
