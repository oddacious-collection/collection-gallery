/**
 * Restoring a database export (BAK-07, BAK-08): the export becomes plain SQL
 * that loads into an EMPTY database whose schema was created by the
 * migrations (`npm run db:migrate:*`), then the search index is rebuilt.
 *
 * - `d1_migrations` is not restored: the migrations create it. The export's
 *   copy is used only to check that the target schema is the same version.
 * - The SQL must work however it is run, statement by statement included:
 *   D1's remote import does not keep `defer_foreign_keys` across the file
 *   (found in the first restore drill, 2026-11-25). So tables load parents
 *   first, and a foreign key that can't be satisfied yet (a category's
 *   parent, an item's cover photo, which points back at a table loaded
 *   later) is inserted as NULL and filled in by an UPDATE at the end.
 *   The target's foreign keys come from the migrated schema (`tableKeys`).
 * - Values are written as SQL literals (text quoted, numbers as numbers).
 */
import type { DbExport } from './export.ts';

/** Derived tables, rebuilt rather than restored. */
const SKIP = new Set(['d1_migrations']);

function literal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('non-finite number in export');
    return String(v);
  }
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
  throw new Error(`unsupported value type in export: ${typeof v}`);
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** The migrations recorded in an export, in order (to compare with the target). */
export function exportedMigrations(data: DbExport): string[] {
  const t = data.tables['d1_migrations'];
  if (!t) return [];
  const nameCol = t.columns.indexOf('name');
  return t.rows.map((r) => String(r[nameCol])).sort();
}

/** SQL that rebuilds the public search index from restored data (as migration 0003 does). */
export const REBUILD_SEARCH_INDEX = `DELETE FROM search_index;
INSERT INTO search_index (item_id, title, body, tags, categories)
SELECT i.id, i.title, i.description,
  coalesce((SELECT group_concat(t.name, ' ') FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = i.id), ''),
  coalesce((SELECT group_concat(c.name, ' ') FROM categories c WHERE c.id IN (
    SELECT cc.ancestor_id FROM item_categories ic JOIN category_closure cc ON cc.descendant_id = ic.category_id
    WHERE ic.item_id = i.id)), '')
FROM items i
WHERE i.status = 'public' AND i.kind = 'owned' AND i.deleted_at IS NULL;`;

const USER_TABLES = `(SELECT name FROM sqlite_master WHERE type = 'table'
  AND substr(name, 1, 7) <> 'sqlite_' AND substr(name, 1, 4) <> '_cf_'
  AND substr(name, 1, 12) <> 'search_index' AND name <> 'd1_migrations')`;

/** Run on the migrated target: one row per foreign-key column. */
export const FOREIGN_KEYS_SQL = `SELECT m.name AS tbl, f."from" AS col, f."table" AS ref, c."notnull" AS nn
FROM ${USER_TABLES} m
JOIN pragma_foreign_key_list(m.name) f
JOIN pragma_table_info(m.name) c ON c.name = f."from"`;

/** Run on the migrated target: primary-key columns, in key order. */
export const PRIMARY_KEYS_SQL = `SELECT m.name AS tbl, c.name AS col
FROM ${USER_TABLES} m
JOIN pragma_table_info(m.name) c
WHERE c.pk > 0
ORDER BY m.name, c.pk`;

export interface ForeignKey {
  table: string;
  column: string;
  refTable: string;
  notNull: boolean;
}
export interface TableKeys {
  foreignKeys: ForeignKey[];
  primaryKeys: Record<string, string[]>;
}

/** Builds `TableKeys` from the rows of FOREIGN_KEYS_SQL and PRIMARY_KEYS_SQL. */
export function tableKeys(
  fkRows: Array<{ tbl: string; col: string; ref: string; nn: number }>,
  pkRows: Array<{ tbl: string; col: string }>,
): TableKeys {
  const primaryKeys: Record<string, string[]> = {};
  for (const r of pkRows) (primaryKeys[r.tbl] ??= []).push(r.col);
  return {
    foreignKeys: fkRows.map((r) => ({
      table: r.tbl,
      column: r.col,
      refTable: r.ref,
      notNull: Number(r.nn) === 1,
    })),
    primaryKeys,
  };
}

/**
 * Parents before children. When tables point at each other, the one whose
 * remaining links are all nullable goes first (those links are deferred).
 */
function loadOrder(tables: string[], fks: ForeignKey[]): string[] {
  const inSet = new Set(tables);
  const edges = fks.filter(
    (fk) => inSet.has(fk.table) && inSet.has(fk.refTable) && fk.refTable !== fk.table,
  );
  const order: string[] = [];
  const done = new Set<string>();
  while (order.length < tables.length) {
    const left = tables.filter((t) => !done.has(t));
    const waitingOn = (t: string) => edges.filter((e) => e.table === t && !done.has(e.refTable));
    const next =
      left.find((t) => waitingOn(t).length === 0) ??
      left.find((t) => waitingOn(t).every((e) => !e.notNull));
    if (!next) throw new Error(`cannot order tables for restore (required links form a cycle)`);
    order.push(next);
    done.add(next);
  }
  return order;
}

/** The statements that load an export into an empty, migrated database. */
export function restoreStatements(data: DbExport, keys: TableKeys, rowsPerInsert = 50): string[] {
  const tables = Object.keys(data.tables).filter((n) => !SKIP.has(n));
  const order = loadOrder(tables, keys.foreignKeys);
  const pos = new Map(order.map((t, i) => [t, i]));
  const out: string[] = [];
  const updates: string[] = [];
  for (const name of order) {
    const t = data.tables[name];
    if (!t || t.rows.length === 0) continue;
    // Links to this table itself or to a table loaded later: filled in afterwards.
    const deferred = keys.foreignKeys
      .filter(
        (fk) =>
          fk.table === name &&
          pos.has(fk.refTable) &&
          (pos.get(fk.refTable) ?? 0) >= (pos.get(name) ?? 0),
      )
      .map((fk) => {
        if (fk.notNull)
          throw new Error(`cannot restore ${name}.${fk.column}: required link to a later table`);
        return t.columns.indexOf(fk.column);
      })
      .filter((i) => i >= 0);
    const pk = (keys.primaryKeys[name] ?? []).map((c) => t.columns.indexOf(c));
    if (deferred.length > 0 && (pk.length === 0 || pk.includes(-1)))
      throw new Error(`cannot restore ${name}: no primary key to fill in its links`);

    const cols = t.columns.map(ident).join(', ');
    for (let i = 0; i < t.rows.length; i += rowsPerInsert) {
      const values = t.rows
        .slice(i, i + rowsPerInsert)
        .map((r) => `(${r.map((v, c) => (deferred.includes(c) ? 'NULL' : literal(v))).join(', ')})`)
        .join(',\n  ');
      out.push(`INSERT INTO ${ident(name)} (${cols}) VALUES\n  ${values};`);
    }
    for (const r of t.rows) {
      const sets = deferred
        .filter((c) => r[c] !== null && r[c] !== undefined)
        .map((c) => `${ident(t.columns[c] ?? '')} = ${literal(r[c])}`);
      if (sets.length === 0) continue;
      const where = pk.map((c) => `${ident(t.columns[c] ?? '')} = ${literal(r[c])}`).join(' AND ');
      updates.push(`UPDATE ${ident(name)} SET ${sets.join(', ')} WHERE ${where};`);
    }
  }
  out.push(...updates, REBUILD_SEARCH_INDEX);
  return out;
}
