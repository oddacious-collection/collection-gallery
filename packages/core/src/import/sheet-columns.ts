/**
 * The columns of the spreadsheet export and import (IMP-06, D-71), shared by
 * the admin Worker and the browser that reads the file.
 */
export const SHEET_COLUMNS = [
  'id',
  'slug',
  'title',
  'description',
  'kind',
  'status',
  'posted_at',
  'license',
  'watermark',
  'purchase_price_usd',
  'purchase_date',
  'open_to_parting',
  'categories',
  'tags',
  'source_caption',
  'suggested_tags',
  'import_key',
  'created_at',
  'updated_at',
] as const;
export type SheetColumn = (typeof SHEET_COLUMNS)[number];
/** Shown in exports, never changed by an import. */
export const READ_ONLY_COLUMNS: readonly SheetColumn[] = ['import_key', 'created_at', 'updated_at'];
/** Columns holding several values: arrays in JSON, "; "-separated in CSV. */
export const LIST_COLUMNS: readonly SheetColumn[] = ['categories', 'tags', 'suggested_tags'];
export const LIST_SEPARATOR = '; ';
/** Rows per preview request (the browser also keeps each request under 1 MB). */
export const SHEET_BATCH = 50;
/**
 * Rows per apply request. Saving a row through the item functions takes about
 * 18 D1 queries, and a Worker request may make at most 1,000 (Workers Paid;
 * a batch counts as one): 50 rows came to 902, too close. 10 rows ≈ 180.
 */
export const SHEET_APPLY_BATCH = 10;
