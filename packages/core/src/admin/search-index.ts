/**
 * Keeps the public search index (db/search.ts, PUB-08) in step with admin
 * changes. Each function returns batch operations to append at the END of a
 * mutation's batch: they read the database state inside the same transaction,
 * after the mutation's own writes, so the index never lags behind a change in
 * visibility, text, tags or categories.
 *
 * What is indexed, for publicly visible items only (status = public, kind =
 * owned, not in the trash): title, description, tag names, and the names of
 * the item's categories and all their ancestors (so "meteorites" finds an
 * item filed under Meteorites › Pallasites). Nothing admin-only.
 */
import { sql, type SQL } from 'drizzle-orm';
import { searchIndex } from '../db/search.ts';
import type { Db, Op } from './db-util.ts';

/** Rewrites the index rows of the items matched by `itemIdsSql` (a subquery or list). */
function reindexOps(db: Db, itemIdsSql: SQL): Op[] {
  return [
    db.delete(searchIndex).where(sql`item_id IN (${itemIdsSql})`),
    db.insert(searchIndex).select(sql`
      SELECT
        i.id,
        i.title,
        i.description,
        coalesce((
          SELECT group_concat(t.name, ' ')
          FROM item_tags it JOIN tags t ON t.id = it.tag_id
          WHERE it.item_id = i.id
        ), ''),
        coalesce((
          SELECT group_concat(c.name, ' ')
          FROM categories c
          WHERE c.id IN (
            SELECT cc.ancestor_id
            FROM item_categories ic
            JOIN category_closure cc ON cc.descendant_id = ic.category_id
            WHERE ic.item_id = i.id
          )
        ), '')
      FROM items i
      WHERE i.id IN (${itemIdsSql})
        AND i.status = 'public' AND i.kind = 'owned' AND i.deleted_at IS NULL`),
  ];
}

/** After any change to one item (text, status, trash, tags, categories). */
export function reindexItemOps(db: Db, itemId: string): Op[] {
  return reindexOps(db, sql`${itemId}`);
}

/** After renaming or moving a category: every item filed anywhere under it. */
export function reindexCategoryOps(db: Db, categoryId: string): Op[] {
  return reindexOps(
    db,
    sql`SELECT ic.item_id FROM item_categories ic
        JOIN category_closure cc ON cc.descendant_id = ic.category_id
        WHERE cc.ancestor_id = ${categoryId}`,
  );
}

/** When items are deleted for good (FTS tables have no foreign keys). */
export function unindexItemsOps(db: Db, itemIds: string[]): Op[] {
  if (itemIds.length === 0) return [];
  return [
    db.delete(searchIndex).where(
      sql`item_id IN (${sql.join(
        itemIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    ),
  ];
}
