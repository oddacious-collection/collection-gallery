/**
 * Export a database to a `.json.gz` file in the same format as the nightly
 * backups (D-47), straight from D1: for drills, for inspection, and as the
 * basis of the full archive export (IMP-07).
 *
 *   node scripts/export-db.ts --local --out backup.json.gz
 *   node scripts/export-db.ts --staging --out backup.json.gz   (needs CLOUDFLARE_* env)
 *
 * The output contains admin-only data: keep it private (never commit it).
 */
import { writeFileSync } from 'node:fs';
import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  gzip,
  type DbExport,
} from '../packages/core/src/backup/index.ts';
import { d1Query, type D1Target } from './lib/d1.ts';

const out = process.argv[process.argv.indexOf('--out') + 1];
if (!process.argv.includes('--out') || !out) {
  console.error('usage: export-db.ts --local|--staging --out <file.json.gz>');
  process.exit(2);
}
const target: D1Target = process.argv.includes('--staging')
  ? { kind: 'remote', env: 'staging' }
  : { kind: 'local' };

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
const all = d1Query<{ name: string; sql: string | null }>(
  target,
  "SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name",
);
const virtual = all
  .filter((t) => (t.sql ?? '').toUpperCase().startsWith('CREATE VIRTUAL TABLE'))
  .map((t) => t.name);
const names = all
  .map((t) => t.name)
  .filter(
    (n) =>
      !n.startsWith('sqlite_') &&
      !n.startsWith('_cf_') &&
      !virtual.includes(n) &&
      !virtual.some((v) => n.startsWith(`${v}_`)),
  );

const data: DbExport = {
  format: EXPORT_FORMAT,
  version: EXPORT_VERSION,
  exportedAt: new Date().toISOString(),
  tables: {},
};
for (const name of names) {
  const columns = d1Query<{ name: string }>(target, `PRAGMA table_info(${q(name)})`).map(
    (c) => c.name,
  );
  const rows: unknown[][] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = d1Query<Record<string, unknown>>(
      target,
      `SELECT * FROM ${q(name)} ORDER BY rowid LIMIT 1000 OFFSET ${offset}`,
    );
    for (const r of page) rows.push(columns.map((c) => r[c] ?? null));
    if (page.length < 1000) break;
  }
  data.tables[name] = { columns, rows };
}
writeFileSync(out, await gzip(JSON.stringify(data)));
const total = Object.values(data.tables).reduce((n, t) => n + t.rows.length, 0);
console.log(`Exported ${names.length} tables, ${total} rows to ${out}.`);
