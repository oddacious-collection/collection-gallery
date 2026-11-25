/**
 * Whole-database export to JSON (BAK-02, D-47). Table by table, because
 * `wrangler d1 export` and the REST export refuse databases with virtual
 * tables (the FTS5 search index). The search index and its shadow tables are
 * skipped: they are derived data, rebuilt on restore. `d1_migrations` is
 * included, so a restore knows the schema version.
 *
 * Also the basis of the full archive export (IMP-07, M2).
 */

export const EXPORT_FORMAT = 'cg-db-export';
export const EXPORT_VERSION = 1;
const PAGE = 1000;

export interface TableExport {
  columns: string[];
  rows: unknown[][];
}

export interface DbExport {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  tables: Record<string, TableExport>;
}

function quoteId(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Tables to export, in name order: real tables only, minus D1 internals and FTS data. */
export async function exportableTables(d1: D1Database): Promise<string[]> {
  const { results } = await d1
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all<{ name: string; sql: string | null }>();
  const virtual = results
    .filter((t) => (t.sql ?? '').toUpperCase().startsWith('CREATE VIRTUAL TABLE'))
    .map((t) => t.name);
  return results
    .map((t) => t.name)
    .filter(
      (n) =>
        !n.startsWith('sqlite_') &&
        !n.startsWith('_cf_') &&
        !virtual.includes(n) &&
        !virtual.some((v) => n.startsWith(`${v}_`)),
    );
}

export async function exportDatabase(d1: D1Database, now: Date = new Date()): Promise<DbExport> {
  const tables: Record<string, TableExport> = {};
  for (const name of await exportableTables(d1)) {
    const { results: info } = await d1
      .prepare(`PRAGMA table_info(${quoteId(name)})`)
      .all<{ name: string }>();
    const columns = info.map((c) => c.name);
    const rows: unknown[][] = [];
    for (let offset = 0; ; offset += PAGE) {
      const { results } = await d1
        .prepare(`SELECT * FROM ${quoteId(name)} ORDER BY rowid LIMIT ? OFFSET ?`)
        .bind(PAGE, offset)
        .all<Record<string, unknown>>();
      for (const r of results) {
        rows.push(
          columns.map((c) => {
            const v = r[c];
            if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
              throw new Error(
                `table ${name} has binary data; the export format doesn't support it`,
              );
            }
            return v ?? null;
          }),
        );
      }
      if (results.length < PAGE) break;
    }
    tables[name] = { columns, rows };
  }
  return { format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: now.toISOString(), tables };
}

export async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/** Checks the shape of an export (used by backup:verify and restores). */
export function parseExport(text: string): DbExport {
  const data = JSON.parse(text) as Partial<DbExport>;
  if (data.format !== EXPORT_FORMAT || data.version !== EXPORT_VERSION) {
    throw new Error('not a collection-gallery database export (or an unknown version)');
  }
  if (typeof data.exportedAt !== 'string' || !data.tables || typeof data.tables !== 'object') {
    throw new Error('database export is missing its timestamp or tables');
  }
  for (const [name, t] of Object.entries(data.tables)) {
    if (!Array.isArray(t.columns) || !Array.isArray(t.rows))
      throw new Error(`table ${name} is malformed`);
    for (const row of t.rows) {
      if (!Array.isArray(row) || row.length !== t.columns.length)
        throw new Error(`table ${name} has a bad row`);
    }
  }
  return data as DbExport;
}
