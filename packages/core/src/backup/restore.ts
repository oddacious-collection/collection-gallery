/**
 * Restoring a database export (BAK-07, BAK-08): the export becomes plain SQL
 * that loads into an EMPTY database whose schema was created by the
 * migrations (`npm run db:migrate:*`), then the search index is rebuilt.
 *
 * - `d1_migrations` is not restored: the migrations create it. The export's
 *   copy is used only to check that the target schema is the same version.
 * - Foreign keys are checked at the end of the import (defer_foreign_keys),
 *   so table order doesn't matter, including categories that point at their
 *   parents or at media.
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

/** The statements that load an export into an empty, migrated database. */
export function restoreStatements(data: DbExport, rowsPerInsert = 50): string[] {
  const out = ['PRAGMA defer_foreign_keys = true;'];
  for (const [name, t] of Object.entries(data.tables)) {
    if (SKIP.has(name) || t.rows.length === 0) continue;
    const cols = t.columns.map(ident).join(', ');
    for (let i = 0; i < t.rows.length; i += rowsPerInsert) {
      const values = t.rows
        .slice(i, i + rowsPerInsert)
        .map((r) => `(${r.map(literal).join(', ')})`)
        .join(',\n  ');
      out.push(`INSERT INTO ${ident(name)} (${cols}) VALUES\n  ${values};`);
    }
  }
  out.push(REBUILD_SEARCH_INDEX);
  return out;
}
