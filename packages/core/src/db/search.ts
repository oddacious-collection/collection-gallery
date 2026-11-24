/**
 * The public search index (PUB-08): an SQLite FTS5 virtual table, created by
 * the hand-written migration `0003_search_index.sql` (Drizzle can't generate
 * virtual tables, so it is deliberately not in schema.ts).
 *
 * INV-1: it holds ONLY public text of ONLY publicly visible items. Rows are
 * rewritten in the same D1 batch as every change that can affect them
 * (admin/search-index.ts), and public search also re-checks visibility by
 * joining `items`, so a row can never surface a non-public item.
 *
 * `item_id` is used only for that join and is never returned publicly.
 */
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const searchIndex = sqliteTable('search_index', {
  itemId: text('item_id').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  tags: text('tags').notNull(),
  categories: text('categories').notNull(),
});
