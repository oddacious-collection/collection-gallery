/**
 * Drizzle schema (D1 / SQLite). M0 holds only the `settings` table to prove the
 * migration pipeline end to end; the full data model (§4) arrives in M1.
 *
 * Visibility rule (INV-1): public code never imports this module directly. It
 * goes through `@cg/core/public`, which selects allowlisted public fields only.
 */
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});
