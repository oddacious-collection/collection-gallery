/**
 * The spreadsheet export and import (IMP-06, D-71).
 *
 * Export: every item not in the trash, all fields (admin ones included), as
 * records the admin app turns into CSV or JSON. Categories are written as
 * their slug path from the top level (`meteorites/pallasites`), tags by name.
 *
 * Import, a batch of rows at a time (the browser reads the file):
 * - a row with an `id` updates that item; otherwise one with a known `slug`
 *   updates it; otherwise a new item is created (it needs a `title`);
 * - **only the columns present in the file are applied**; an empty cell in a
 *   present column clears that field (a required one is an error);
 * - categories must already exist (an unknown path is an error), tags are
 *   created as needed; items in the trash are never edited; read-only
 *   columns (dates, import keys) are ignored;
 * - "preview" says exactly what would change, row by row; "apply" makes those
 *   changes through the normal item functions (revisions, audit log, search
 *   index, publish rules), each row succeeding or failing on its own.
 */
import { eq, inArray, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { z } from 'zod';
import {
  ITEM_KINDS,
  ITEM_STATUSES,
  LICENSES,
  WATERMARK_OVERRIDES,
  categories,
  itemCategories,
  items,
  tags,
  itemTags,
} from '../db/schema.ts';
import { ULID_PATTERN } from '../ids.ts';
import {
  LIST_SEPARATOR,
  READ_ONLY_COLUMNS,
  SHEET_APPLY_BATCH,
  SHEET_BATCH,
  SHEET_COLUMNS,
  type SheetColumn,
} from '../import/sheet-columns.ts';
import { SLUG_MAX_LENGTH, SLUG_PATTERN, slugify } from '../slug.ts';
import { DomainError } from './domain-error.ts';
import {
  createItem,
  getItem,
  setItemCategories,
  setItemStatus,
  setItemTags,
  updateItem,
} from './items.ts';
import {
  DESCRIPTION_MAX,
  TAG_NAME_MAX,
  TITLE_MAX,
  type ItemCreateInput,
  type ItemUpdateInput,
} from './validation.ts';

export {
  LIST_COLUMNS,
  LIST_SEPARATOR,
  READ_ONLY_COLUMNS,
  SHEET_APPLY_BATCH,
  SHEET_BATCH,
  SHEET_COLUMNS,
  type SheetColumn,
} from '../import/sheet-columns.ts';

export type SheetRecord = Partial<Record<SheetColumn, string | string[]>>;

// ------------------------------------------------------------------ helpers

async function categoryPaths(db: ReturnType<typeof drizzle>): Promise<{
  pathOf: Map<string, string>;
  idOf: Map<string, string>;
}> {
  const rows = await db
    .select({ id: categories.id, parentId: categories.parentId, slug: categories.slug })
    .from(categories);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pathOf = new Map<string, string>();
  for (const r of rows) {
    const parts: string[] = [];
    let cur: (typeof rows)[number] | undefined = r;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      parts.unshift(cur.slug);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    pathOf.set(r.id, parts.join('/'));
  }
  const idOf = new Map([...pathOf].map(([id, path]) => [path.toLowerCase(), id]));
  return { pathOf, idOf };
}

const cents = (c: number | null) => (c === null ? '' : (c / 100).toFixed(2));

// ------------------------------------------------------------------ export

/** Every item not in the trash, oldest first, as sheet records. */
export async function exportSheet(d1: D1Database): Promise<SheetRecord[]> {
  const db = drizzle(d1);
  const [rows, cats, tagRows, { pathOf }] = await Promise.all([
    db.select().from(items).where(isNull(items.deletedAt)).orderBy(items.createdAt, items.id),
    db
      .select({ itemId: itemCategories.itemId, categoryId: itemCategories.categoryId })
      .from(itemCategories),
    db
      .select({ itemId: itemTags.itemId, name: tags.name })
      .from(itemTags)
      .innerJoin(tags, eq(tags.id, itemTags.tagId)),
    categoryPaths(db),
  ]);
  const catsOf = new Map<string, string[]>();
  for (const c of cats) {
    const path = pathOf.get(c.categoryId);
    if (path) catsOf.set(c.itemId, [...(catsOf.get(c.itemId) ?? []), path]);
  }
  const tagsOf = new Map<string, string[]>();
  for (const t of tagRows) tagsOf.set(t.itemId, [...(tagsOf.get(t.itemId) ?? []), t.name]);
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    description: r.description,
    kind: r.kind,
    status: r.status,
    posted_at: r.postedAt ?? '',
    license: r.licenseOverride ?? '',
    watermark: r.watermarkOverride,
    purchase_price_usd: cents(r.purchasePriceCents),
    purchase_date: r.purchaseDate ?? '',
    open_to_parting: r.openToParting ? 'yes' : 'no',
    categories: (catsOf.get(r.id) ?? []).sort(),
    tags: (tagsOf.get(r.id) ?? []).sort((a, b) => a.localeCompare(b)),
    source_caption: r.sourceCaption ?? '',
    suggested_tags: r.suggestedTags ? (JSON.parse(r.suggestedTags) as string[]) : [],
    import_key: r.importKey ?? '',
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  }));
}

// ------------------------------------------------------------------ import

export const SheetRows = z
  .strictObject({
    mode: z.enum(['preview', 'apply']),
    /** The columns the file has (only these are applied). */
    columns: z.array(z.enum(SHEET_COLUMNS)).min(1).max(SHEET_COLUMNS.length),
    rows: z
      .array(
        z.strictObject({
          /** The row's line in the file, for messages. */
          line: z.int().min(1).max(1_000_000),
          cells: z.partialRecord(
            z.enum(SHEET_COLUMNS),
            z.union([z.string().max(DESCRIPTION_MAX), z.array(z.string().max(500)).max(200)]),
          ),
        }),
      )
      .min(1)
      .max(SHEET_BATCH),
  })
  .refine((v) => v.mode === 'preview' || v.rows.length <= SHEET_APPLY_BATCH, {
    path: ['rows'],
    message: `at most ${SHEET_APPLY_BATCH} rows per apply request`,
  });
export type SheetRowsInput = z.input<typeof SheetRows>;

export interface SheetChange {
  field: string;
  from: string;
  to: string;
}

export interface SheetRowResult {
  line: number;
  action: 'create' | 'update' | 'unchanged' | 'error';
  itemId?: string;
  title: string;
  changes: SheetChange[];
  errors: string[];
  /** Apply only: whether it was done. */
  applied?: boolean;
}

interface Wanted {
  patch: ItemUpdateInput;
  categoryIds?: string[];
  tagNames?: string[];
  status?: (typeof ITEM_STATUSES)[number];
}

const cellText = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v.join(LIST_SEPARATOR) : (v ?? '')).replace(/\r\n?/g, '\n');
const cellList = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v : (v ?? '').split(';')).map((s) => s.trim()).filter(Boolean);
const showList = (l: readonly string[]) => l.join(LIST_SEPARATOR);

function parseBool(s: string): boolean | null {
  const t = s.trim().toLowerCase();
  if (['yes', 'true', '1', 'y'].includes(t)) return true;
  if (['', 'no', 'false', '0', 'n'].includes(t)) return false;
  return null;
}

function parseDateTime(s: string): string | null | 'bad' {
  const t = s.trim();
  if (t === '') return null;
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T00:00:00Z` : t);
  return Number.isNaN(ms) ? 'bad' : new Date(ms).toISOString();
}

function parseDate(s: string): string | null | 'bad' {
  const t = s.trim();
  if (t === '') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t) && !Number.isNaN(Date.parse(`${t}T00:00:00Z`))) return t;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? 'bad' : new Date(ms).toISOString().slice(0, 10);
}

function parsePrice(s: string): number | null | 'bad' {
  const t = s.trim().replace(/[$,\s]/g, '');
  if (t === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return 'bad';
  return Math.round(Number(t) * 100);
}

const isoOrEmpty = (v: string | null) => (v ? new Date(v).toISOString() : '');

type CurrentItem = Awaited<ReturnType<typeof getItem>>;

/** What a row asks for, compared with the item as it is (or a new item). */
function planCells(
  columns: ReadonlySet<SheetColumn>,
  cells: SheetRecord,
  current: CurrentItem | null,
  idOf: Map<string, string>,
  pathOf: Map<string, string>,
): { wanted: Wanted; changes: SheetChange[]; errors: string[] } {
  const errors: string[] = [];
  const changes: SheetChange[] = [];
  const wanted: Wanted = { patch: {} };
  // A column applies when the file has it and this row carries the cell (a
  // CSV row always does; a JSON record may leave a field out = no change).
  const has = (c: SheetColumn) =>
    columns.has(c) && cells[c] !== undefined && !READ_ONLY_COLUMNS.includes(c);
  const text = (c: SheetColumn) => cellText(cells[c]);
  const change = (field: string, from: string, to: string) => {
    if (from !== to) changes.push({ field, from, to });
    return from !== to;
  };

  if (has('title')) {
    const v = text('title').trim();
    if (!v) errors.push('title is empty');
    else if (v.length > TITLE_MAX) errors.push(`title is longer than ${TITLE_MAX} characters`);
    else if (change('title', current?.title ?? '', v)) wanted.patch.title = v;
  } else if (!current) {
    errors.push('a new item needs a title');
  }
  if (has('description')) {
    const v = text('description');
    if (change('description', current?.description ?? '', v)) wanted.patch.description = v;
  }
  if (has('slug')) {
    const v = text('slug').trim();
    if (!v) {
      if (current) errors.push('slug (URL name) is empty');
    } else if (v.length > SLUG_MAX_LENGTH || !SLUG_PATTERN.test(v)) {
      errors.push('slug must be lowercase letters, digits and single hyphens');
    } else if (change('slug', current?.slug ?? '', v)) {
      wanted.patch.slug = v;
    }
  }
  if (has('kind')) {
    const v = text('kind').trim().toLowerCase() || 'owned';
    if (!(ITEM_KINDS as readonly string[]).includes(v))
      errors.push(`kind must be ${ITEM_KINDS.join(' or ')}`);
    else if (change('kind', current?.kind ?? 'owned', v)) {
      wanted.patch.kind = v as (typeof ITEM_KINDS)[number];
    }
  }
  if (has('posted_at')) {
    const v = parseDateTime(text('posted_at'));
    if (v === 'bad') errors.push('posted_at is not a date');
    else if (change('posted_at', isoOrEmpty(current?.postedAt ?? null), v ?? ''))
      wanted.patch.postedAt = v;
  }
  if (has('license')) {
    const v = text('license').trim().toLowerCase();
    if (v && !(LICENSES as readonly string[]).includes(v))
      errors.push(`license must be blank or one of ${LICENSES.join(', ')}`);
    else if (change('license', current?.licenseOverride ?? '', v)) {
      wanted.patch.licenseOverride = (v || null) as (typeof LICENSES)[number] | null;
    }
  }
  if (has('watermark')) {
    const v = text('watermark').trim().toLowerCase() || 'inherit';
    if (!(WATERMARK_OVERRIDES as readonly string[]).includes(v)) {
      errors.push(`watermark must be ${WATERMARK_OVERRIDES.join(', ')}`);
    } else if (change('watermark', current?.watermarkOverride ?? 'inherit', v)) {
      wanted.patch.watermarkOverride = v as (typeof WATERMARK_OVERRIDES)[number];
    }
  }
  if (has('purchase_price_usd')) {
    const v = parsePrice(text('purchase_price_usd'));
    if (v === 'bad') errors.push('purchase_price_usd is not an amount (like 12.50)');
    else if (change('purchase_price_usd', cents(current?.purchasePriceCents ?? null), cents(v))) {
      wanted.patch.purchasePriceCents = v;
      wanted.patch.purchaseCurrency = v === null ? null : 'USD';
    }
  }
  if (has('purchase_date')) {
    const v = parseDate(text('purchase_date'));
    if (v === 'bad') errors.push('purchase_date is not a date (like 2024-05-31)');
    else if (change('purchase_date', current?.purchaseDate ?? '', v ?? ''))
      wanted.patch.purchaseDate = v;
  }
  if (has('open_to_parting')) {
    const v = parseBool(text('open_to_parting'));
    if (v === null) errors.push('open_to_parting must be yes or no');
    else if (change('open_to_parting', current?.openToParting ? 'yes' : 'no', v ? 'yes' : 'no')) {
      wanted.patch.openToParting = v;
    }
  }
  if (has('source_caption')) {
    const v = text('source_caption');
    if (change('source_caption', current?.sourceCaption ?? '', v))
      wanted.patch.sourceCaption = v || null;
  }
  if (has('suggested_tags')) {
    const v = cellList(cells.suggested_tags);
    const was: string[] = current?.suggestedTags
      ? (JSON.parse(current.suggestedTags) as string[])
      : [];
    if (v.some((t) => t.length > TAG_NAME_MAX))
      errors.push(`a suggested tag is longer than ${TAG_NAME_MAX} characters`);
    else if (change('suggested_tags', showList(was), showList(v)))
      wanted.patch.suggestedTags = v.length ? v : null;
  }
  if (has('categories')) {
    const paths = cellList(cells.categories).map((p) => p.replace(/^\/+|\/+$/g, ''));
    const ids: string[] = [];
    for (const p of paths) {
      const id = idOf.get(p.toLowerCase());
      if (id) ids.push(id);
      else errors.push(`no category "${p}" (use its path, like meteorites/pallasites)`);
    }
    const was = (current?.categoryIds ?? []).map((id) => pathOf.get(id) ?? id).sort();
    const now = [...new Set(ids)].map((id) => pathOf.get(id) ?? id).sort();
    if (change('categories', showList(was), showList(now))) wanted.categoryIds = [...new Set(ids)];
  }
  if (has('tags')) {
    const v = cellList(cells.tags);
    if (v.some((t) => t.length > TAG_NAME_MAX))
      errors.push(`a tag is longer than ${TAG_NAME_MAX} characters`);
    // Compared the way tags are stored: one per URL name (setItemTags).
    const norm = (l: readonly string[]) =>
      [...new Set(l.map((t) => slugify(t, '')).filter(Boolean))].sort().join(' ');
    if (norm(current?.tagNames ?? []) !== norm(v)) {
      changes.push({
        field: 'tags',
        from: showList([...(current?.tagNames ?? [])].sort((a, b) => a.localeCompare(b))),
        to: showList([...v].sort((a, b) => a.localeCompare(b))),
      });
      wanted.tagNames = v;
    }
  }
  if (has('status')) {
    const v = text('status').trim().toLowerCase() || 'draft';
    if (!(ITEM_STATUSES as readonly string[]).includes(v))
      errors.push(`status must be ${ITEM_STATUSES.join(', ')}`);
    else if (change('status', current?.status ?? 'draft', v))
      wanted.status = v as (typeof ITEM_STATUSES)[number];
  }
  return { wanted, changes, errors };
}

/** Previews or applies one batch of rows (see the module note). */
export async function processSheetRows(
  d1: D1Database,
  input: SheetRowsInput,
  actor: string,
  now: Date = new Date(),
): Promise<SheetRowResult[]> {
  const data = SheetRows.parse(input);
  const db = drizzle(d1);
  const columns = new Set(data.columns);
  const { idOf, pathOf } = await categoryPaths(db);

  // The items the batch names, by ID and by URL name (≤ 50 of each: within D1's limits).
  const ids = data.rows.map((r) => cellText(r.cells.id).trim()).filter((v) => ULID_PATTERN.test(v));
  const slugs = data.rows.map((r) => cellText(r.cells.slug).trim()).filter(Boolean);
  const [byIdRows, bySlugRows] = await Promise.all([
    ids.length ? db.select({ id: items.id }).from(items).where(inArray(items.id, ids)) : [],
    slugs.length
      ? db.select({ id: items.id, slug: items.slug }).from(items).where(inArray(items.slug, slugs))
      : [],
  ]);
  const knownIds = new Set(byIdRows.map((r) => r.id));
  const idBySlug = new Map(bySlugRows.map((r) => [r.slug, r.id]));

  const results: SheetRowResult[] = [];
  for (const row of data.rows) {
    const idCell = cellText(row.cells.id).trim();
    const slugCell = cellText(row.cells.slug).trim();
    const errors: string[] = [];
    let itemId: string | undefined;
    if (idCell) {
      if (!ULID_PATTERN.test(idCell) || !knownIds.has(idCell))
        errors.push(`no item with the ID ${idCell}`);
      else itemId = idCell;
    } else if (slugCell && idBySlug.has(slugCell)) {
      itemId = idBySlug.get(slugCell);
    }
    let current: CurrentItem | null = null;
    if (itemId) {
      current = await getItem(d1, itemId);
      if (current.deletedAt !== null) errors.push('this item is in the trash (restore it first)');
    }
    const planned = planCells(columns, row.cells, current, idOf, pathOf);
    errors.push(...planned.errors);
    const newSlug = planned.wanted.patch.slug;
    if (newSlug !== undefined && idBySlug.has(newSlug) && idBySlug.get(newSlug) !== current?.id) {
      errors.push('that URL name is used by another item');
    }
    // Publish rules (§4.1), as they will be once the row is applied.
    if ((planned.wanted.status ?? current?.status) === 'public') {
      const kind = planned.wanted.patch.kind ?? current?.kind ?? 'owned';
      const cats = planned.wanted.categoryIds ?? current?.categoryIds ?? [];
      if (kind === 'wishlist') errors.push('a wishlist item can’t be public');
      if (cats.length === 0) errors.push('a public item needs a category');
      if (!current || current.mediaCount === 0) {
        errors.push('a public item needs a photo (add it in the editor first)');
      }
    }
    const title =
      (planned.wanted.patch.title ?? current?.title ?? cellText(row.cells.title).trim()) ||
      '(no title)';
    const action: SheetRowResult['action'] = errors.length
      ? 'error'
      : !current
        ? 'create'
        : planned.changes.length
          ? 'update'
          : 'unchanged';
    const result: SheetRowResult = {
      line: row.line,
      action,
      ...(current ? { itemId: current.id } : {}),
      title,
      changes: planned.changes,
      errors,
    };
    if (data.mode === 'apply' && (action === 'create' || action === 'update')) {
      try {
        const { patch, categoryIds, tagNames, status } = planned.wanted;
        let id = current?.id;
        // Leaving "public" happens first (so removing the last category or
        // making it a wishlist item is allowed); becoming public happens last,
        // once the categories are in place.
        const statusFirst = status !== undefined && status !== 'public';
        if (id && statusFirst) await setItemStatus(d1, id, status, actor, now);
        if (!id) {
          const input: ItemCreateInput = { ...patch, title };
          const created = await createItem(d1, input, actor, now);
          id = created.id;
          result.itemId = id;
          if (statusFirst && status !== 'draft') await setItemStatus(d1, id, status, actor, now);
        } else if (Object.keys(patch).length) {
          await updateItem(d1, id, patch, actor, now);
        }
        if (categoryIds) await setItemCategories(d1, id, categoryIds, actor, now);
        if (tagNames) await setItemTags(d1, id, tagNames, actor, now);
        if (status === 'public') await setItemStatus(d1, id, status, actor, now);
        result.applied = true;
      } catch (err) {
        if (!(err instanceof DomainError) && !(err instanceof z.ZodError)) throw err;
        result.applied = false;
        result.errors.push(
          err instanceof DomainError
            ? err.code === 'slug_taken'
              ? 'that URL name is used by another item'
              : `${err.code.replace(/_/g, ' ')}${Array.isArray(err.details['reasons']) ? `: ${(err.details['reasons'] as string[]).join(', ')}` : ''}`
            : 'a value is not valid',
        );
      }
    }
    results.push(result);
  }
  return results;
}

/** Item count for the page (not in the trash). */
export async function countSheetItems(d1: D1Database): Promise<number> {
  const db = drizzle(d1);
  const row = await db.get<{ n: number }>(
    sql`SELECT count(*) AS n FROM items WHERE deleted_at IS NULL`,
  );
  return row?.n ?? 0;
}
