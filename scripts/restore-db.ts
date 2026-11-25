/**
 * Restore a database export into an EMPTY database (BAK-07, BAK-08).
 *
 *   node scripts/restore-db.ts --from <file.json.gz | b2:daily/2026-12-01.json.gz | b2:latest>
 *                              --to-local <directory>
 *
 * The target is a fresh local database directory (for drills and for
 * inspecting a backup), created with the full schema by the migrations, then
 * loaded with the export, then the search index is rebuilt. Restoring onto a
 * deployed database is a manual, reviewed step (docs/runbooks/restore-db.md):
 * this script refuses any target that already holds items.
 *
 * Reading from B2 uses the read-only verify key (B2_VERIFY_KEY_ID,
 * B2_VERIFY_APP_KEY; optional B2_DB_BUCKET).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  authorize,
  downloadFile,
  exportedMigrations,
  gunzip,
  listFileNames,
  bucketId,
  parseExport,
  restoreStatements,
} from '../packages/core/src/backup/index.ts';
import { d1File, d1Migrate, d1Query, type D1Target } from './lib/d1.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`Missing ${name}.`);
    process.exit(2);
  }
  return v;
}

const from = arg('--from');
const toLocal = arg('--to-local');
if (!from || !toLocal) {
  console.error(
    'usage: restore-db.ts --from <file.json.gz | b2:<name> | b2:latest> --to-local <directory>',
  );
  process.exit(2);
}

async function load(source: string): Promise<Uint8Array> {
  if (!source.startsWith('b2:')) return new Uint8Array(readFileSync(source));
  const bucketName = process.env['B2_DB_BUCKET'] ?? 'oddacioustreasures-com-staging-db-backups';
  const s = await authorize(need('B2_VERIFY_KEY_ID'), need('B2_VERIFY_APP_KEY'));
  let name = source.slice(3);
  if (name === 'latest') {
    const files = await listFileNames(s, await bucketId(s, bucketName), 'daily/');
    const newest = files
      .map((f) => f.fileName)
      .sort()
      .at(-1);
    if (!newest) throw new Error('no daily export in the bucket');
    name = newest;
  }
  console.log(`Downloading ${name}...`);
  return downloadFile(s, bucketName, name);
}

const data = parseExport(await gunzip(await load(from)));
const rows = Object.values(data.tables).reduce((n, t) => n + t.rows.length, 0);
console.log(
  `Export from ${data.exportedAt}: ${Object.keys(data.tables).length} tables, ${rows} rows.`,
);

const persistTo = path.resolve(toLocal);
mkdirSync(persistTo, { recursive: true });
const target: D1Target = { kind: 'local', persistTo };

d1Migrate(target);
const items = d1Query<{ n: number }>(target, 'SELECT count(*) AS n FROM items')[0]?.n ?? 0;
if (items > 0) {
  console.error(
    `Refusing: the target already holds ${items} items. Restore only into an empty database.`,
  );
  process.exit(1);
}
const applied = d1Query<{ name: string }>(
  target,
  'SELECT name FROM d1_migrations ORDER BY name',
).map((r) => r.name);
const exported = exportedMigrations(data);
if (JSON.stringify(applied) !== JSON.stringify(exported)) {
  console.error(
    `Refusing: schema versions differ (export has ${exported.length} migrations, target ${applied.length}). ` +
      'Restore with the code version the export was made with, then migrate forward.',
  );
  process.exit(1);
}

const dir = mkdtempSync(path.join(tmpdir(), 'cg-restore-'));
try {
  const file = path.join(dir, 'restore.sql');
  writeFileSync(file, `${restoreStatements(data).join('\n')}\n`);
  d1File(target, file);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// Compare row counts table by table.
let mismatches = 0;
for (const [name, t] of Object.entries(data.tables)) {
  if (name === 'd1_migrations') continue;
  const n =
    d1Query<{ n: number }>(target, `SELECT count(*) AS n FROM "${name.replace(/"/g, '""')}"`)[0]
      ?.n ?? -1;
  if (n !== t.rows.length) {
    mismatches++;
    console.error(`  ${name}: ${n} rows restored, ${t.rows.length} expected`);
  }
}
if (mismatches > 0) {
  console.error(`Restore FAILED: ${mismatches} table(s) differ.`);
  process.exit(1);
}
console.log(`Restored into ${persistTo}: every table's row count matches the export.`);
