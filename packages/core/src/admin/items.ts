/**
 * Admin data access for items (ADM-02, ADM-04, ADM-05, SEC-13).
 *
 * Every mutation is one D1 batch (a transaction) that also writes:
 * - a revision snapshot of the item's new state (ADM-05, INV-2), and
 * - an audit-log entry naming the acting owner (SEC-13).
 *
 * Only the admin Worker may import this module.
 */
import { and, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { z } from 'zod';
import {
  ITEM_KINDS,
  ITEM_STATUSES,
  LICENSES,
  WATERMARK_OVERRIDES,
  categories,
  itemCategories,
  itemRevisions,
  itemTags,
  items,
  media,
  slugRedirects,
  tags,
} from '../db/schema.ts';
import { ulid } from '../ids.ts';
import { slugify, uniqueSlug } from '../slug.ts';
import { audit, run, type Db, type Op } from './db-util.ts';
import { DomainError } from './domain-error.ts';
import { reindexItemOps } from './search-index.ts';
import {
  IdList,
  ItemCreate,
  ItemStatus,
  ItemUpdate,
  MAX_CATEGORIES_PER_ITEM,
  TagNames,
  type ItemCreateInput,
  type ItemUpdateInput,
} from './validation.ts';

export type ItemRow = typeof items.$inferSelect;

// ------------------------------------------------------------------ helpers

function nowIso(now: Date): string {
  return now.toISOString();
}

/** The given keys removed (a shallow copy). */
function omit<T extends object, K extends keyof T>(obj: T, ...keys: K[]): Omit<T, K> {
  const drop = new Set<PropertyKey>(keys);
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !drop.has(k))) as Omit<T, K>;
}

/** The entries whose value is not `undefined` (Zod partials may contain them). */
function defined<T extends object>(obj: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

async function getRow(db: Db, id: string): Promise<ItemRow> {
  const [row] = await db.select().from(items).where(eq(items.id, id)).limit(1);
  if (!row) throw new DomainError('not_found');
  return row;
}

/** A slug is taken if any item uses it, or it redirects to a different item. */
async function slugTaken(db: Db, candidate: string, exceptItemId?: string): Promise<boolean> {
  const [owner] = await db
    .select({ id: items.id })
    .from(items)
    .where(eq(items.slug, candidate))
    .limit(1);
  if (owner && owner.id !== exceptItemId) return true;
  const [redirect] = await db
    .select({ itemId: slugRedirects.itemId })
    .from(slugRedirects)
    .where(eq(slugRedirects.oldSlug, candidate))
    .limit(1);
  return redirect !== undefined && redirect.itemId !== exceptItemId;
}

interface Relations {
  categoryIds: string[];
  tagIds: string[];
  mediaIds: string[];
}

async function readRelations(db: Db, itemId: string): Promise<Relations> {
  const [cats, tagRows, mediaRows] = await db.batch([
    db
      .select({ id: itemCategories.categoryId })
      .from(itemCategories)
      .where(eq(itemCategories.itemId, itemId)),
    db.select({ id: itemTags.tagId }).from(itemTags).where(eq(itemTags.itemId, itemId)),
    db
      .select({ id: media.id })
      .from(media)
      .where(and(eq(media.itemId, itemId), isNull(media.deletedAt)))
      .orderBy(media.position),
  ]);
  return {
    categoryIds: cats.map((r) => r.id).sort(),
    tagIds: tagRows.map((r) => r.id).sort(),
    mediaIds: mediaRows.map((r) => r.id),
  };
}

// ------------------------------------------------------------------ revisions

/** Revision snapshot format (version 1). Stored as JSON in item_revisions. */
export const RevisionSnapshot = z.object({
  v: z.literal(1),
  item: z.object({
    slug: z.string(),
    kind: z.enum(ITEM_KINDS),
    status: z.enum(ITEM_STATUSES),
    title: z.string(),
    description: z.string(),
    postedAt: z.string().nullable(),
    licenseOverride: z.enum(LICENSES).nullable(),
    watermarkOverride: z.enum(WATERMARK_OVERRIDES),
    purchasePriceCents: z.number().nullable(),
    purchaseCurrency: z.string().nullable(),
    purchaseDate: z.string().nullable(),
    openToParting: z.boolean(),
    sourceCaption: z.string().nullable(),
    suggestedTags: z.string().nullable(),
    deletedAt: z.string().nullable(),
  }),
  categoryIds: z.array(z.string()),
  tagIds: z.array(z.string()),
  mediaIds: z.array(z.string()),
});
export type RevisionSnapshot = z.infer<typeof RevisionSnapshot>;

function snapshotOf(row: ItemRow, rel: Relations): RevisionSnapshot {
  return {
    v: 1,
    item: {
      slug: row.slug,
      kind: row.kind,
      status: row.status,
      title: row.title,
      description: row.description,
      postedAt: row.postedAt,
      licenseOverride: row.licenseOverride,
      watermarkOverride: row.watermarkOverride,
      purchasePriceCents: row.purchasePriceCents,
      purchaseCurrency: row.purchaseCurrency,
      purchaseDate: row.purchaseDate,
      openToParting: row.openToParting,
      sourceCaption: row.sourceCaption,
      suggestedTags: row.suggestedTags,
      deletedAt: row.deletedAt,
    },
    categoryIds: rel.categoryIds,
    tagIds: rel.tagIds,
    mediaIds: rel.mediaIds,
  };
}

function revisionOp(db: Db, row: ItemRow, rel: Relations, at: string): Op {
  return db.insert(itemRevisions).values({
    id: ulid(),
    itemId: row.id,
    snapshot: JSON.stringify(snapshotOf(row, rel)),
    createdAt: at,
  });
}

/**
 * For changes to an item's photos (admin/media.ts): the item row, plus the ops
 * that bump its `updated_at` and snapshot it with the new photo order.
 * Throws not_found for an unknown item.
 */
export async function itemMediaChange(
  db: Db,
  itemId: string,
  at: string,
): Promise<{ item: ItemRow; ops: (mediaIds: string[]) => Op[] }> {
  const item = await getRow(db, itemId);
  const rel = await readRelations(db, itemId);
  return {
    item,
    ops: (mediaIds) => [
      db.update(items).set({ updatedAt: at }).where(eq(items.id, itemId)),
      revisionOp(db, { ...item, updatedAt: at }, { ...rel, mediaIds }, at),
    ],
  };
}

function auditOp(
  db: Db,
  actor: string,
  action: string,
  targetId: string,
  details: Record<string, unknown>,
  at: string,
): Op {
  return audit(db, 'item', actor, action, targetId, details, at);
}

// ------------------------------------------------------------------ reads

export interface AdminItem extends ItemRow {
  categoryIds: string[];
  tagNames: string[];
  mediaCount: number;
}

export async function getItem(d1: D1Database, id: string): Promise<AdminItem> {
  const db = drizzle(d1);
  const row = await getRow(db, id);
  const rel = await readRelations(db, id);
  const tagRows = rel.tagIds.length
    ? await db
        .select({ name: tags.name })
        .from(tags)
        .where(inArray(tags.id, rel.tagIds))
        .orderBy(tags.name)
    : [];
  return {
    ...row,
    categoryIds: rel.categoryIds,
    tagNames: tagRows.map((t) => t.name),
    mediaCount: rel.mediaIds.length,
  };
}

export interface ListItemsOptions {
  status?: (typeof ITEM_STATUSES)[number];
  kind?: (typeof ITEM_KINDS)[number];
  /** true: only the trash; false (default): exclude the trash. */
  trashed?: boolean;
  limit?: number;
  offset?: number;
}

export async function listItems(d1: D1Database, opts: ListItemsOptions = {}): Promise<ItemRow[]> {
  const db = drizzle(d1);
  const where: SQL[] = [opts.trashed ? isNotNull(items.deletedAt) : isNull(items.deletedAt)];
  if (opts.status) where.push(eq(items.status, opts.status));
  if (opts.kind) where.push(eq(items.kind, opts.kind));
  return db
    .select()
    .from(items)
    .where(and(...where))
    .orderBy(desc(items.updatedAt))
    .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200))
    .offset(Math.max(opts.offset ?? 0, 0));
}

export async function listRevisions(
  d1: D1Database,
  itemId: string,
): Promise<Array<{ id: string; createdAt: string; snapshot: RevisionSnapshot }>> {
  const db = drizzle(d1);
  const rows = await db
    .select()
    .from(itemRevisions)
    .where(eq(itemRevisions.itemId, itemId))
    .orderBy(desc(itemRevisions.createdAt), desc(itemRevisions.id));
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    snapshot: RevisionSnapshot.parse(JSON.parse(r.snapshot)),
  }));
}

// ------------------------------------------------------------------ writes

export async function createItem(
  d1: D1Database,
  input: ItemCreateInput,
  actor: string,
  now: Date = new Date(),
): Promise<ItemRow> {
  const data = ItemCreate.parse(input);
  const db = drizzle(d1);
  const at = nowIso(now);

  let slug: string;
  if (data.slug !== undefined) {
    if (await slugTaken(db, data.slug)) throw new DomainError('slug_taken', { slug: data.slug });
    slug = data.slug;
  } else {
    slug = await uniqueSlug(slugify(data.title), (c) => slugTaken(db, c));
  }

  const row: ItemRow = {
    id: ulid(now.getTime()),
    slug,
    kind: data.kind,
    status: 'draft',
    title: data.title,
    description: data.description,
    postedAt: data.postedAt,
    licenseOverride: data.licenseOverride,
    watermarkOverride: data.watermarkOverride,
    purchasePriceCents: data.purchasePriceCents,
    purchaseCurrency: data.purchaseCurrency,
    purchaseDate: data.purchaseDate,
    openToParting: data.openToParting,
    sourceCaption: data.sourceCaption,
    suggestedTags: data.suggestedTags ? JSON.stringify(data.suggestedTags) : null,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
  };
  const empty: Relations = { categoryIds: [], tagIds: [], mediaIds: [] };
  await run(db, [
    db.insert(items).values(row),
    revisionOp(db, row, empty, at),
    auditOp(db, actor, 'item.create', row.id, { slug }, at),
  ]);
  return row;
}

export async function updateItem(
  d1: D1Database,
  id: string,
  patch: ItemUpdateInput,
  actor: string,
  now: Date = new Date(),
): Promise<ItemRow> {
  const data = ItemUpdate.parse(patch);
  const db = drizzle(d1);
  const at = nowIso(now);
  const current = await getRow(db, id);
  const ops: Op[] = [];

  const { suggestedTags, ...plain } = data;
  const next: ItemRow = {
    ...current,
    ...defined(plain),
    ...(suggestedTags !== undefined
      ? { suggestedTags: suggestedTags ? JSON.stringify(suggestedTags) : null }
      : {}),
    updatedAt: at,
  };

  if (next.slug !== current.slug) {
    if (await slugTaken(db, next.slug, id))
      throw new DomainError('slug_taken', { slug: next.slug });
    // Reclaiming one of this item's own old slugs removes that redirect.
    ops.push(db.delete(slugRedirects).where(eq(slugRedirects.oldSlug, next.slug)));
    ops.push(
      db
        .insert(slugRedirects)
        .values({ oldSlug: current.slug, itemId: id, createdAt: at })
        .onConflictDoNothing(),
    );
  }
  if (next.kind === 'wishlist' && next.status === 'public') {
    throw new DomainError('cannot_publish', { reasons: ['wishlist'] });
  }

  ops.push(
    db
      .update(items)
      .set(omit(next, 'id', 'createdAt'))
      .where(eq(items.id, id)),
  );
  ops.push(revisionOp(db, next, await readRelations(db, id), at));
  const changed = Object.keys(data).filter(
    (k) => JSON.stringify(current[k as keyof ItemRow]) !== JSON.stringify(next[k as keyof ItemRow]),
  );
  ops.push(auditOp(db, actor, 'item.update', id, { changed }, at));
  ops.push(...reindexItemOps(db, id));
  await run(db, ops);
  return next;
}

/** Why an item can't be public right now (§4.1); empty = can publish. */
export async function publishBlockers(d1: D1Database, id: string): Promise<string[]> {
  const db = drizzle(d1);
  const row = await getRow(db, id);
  const rel = await readRelations(db, id);
  const reasons: string[] = [];
  if (row.kind === 'wishlist') reasons.push('wishlist');
  if (row.deletedAt !== null) reasons.push('in_trash');
  if (rel.categoryIds.length === 0) reasons.push('needs_category');
  if (rel.mediaIds.length === 0) reasons.push('needs_media');
  return reasons;
}

/** The Public/Private toggle and Save-draft (ADM-02). */
export async function setItemStatus(
  d1: D1Database,
  id: string,
  status: (typeof ITEM_STATUSES)[number],
  actor: string,
  now: Date = new Date(),
): Promise<ItemRow> {
  const target = ItemStatus.parse(status);
  const db = drizzle(d1);
  const at = nowIso(now);
  const current = await getRow(db, id);
  if (target === 'public') {
    const reasons = await publishBlockers(d1, id);
    if (reasons.length > 0) throw new DomainError('cannot_publish', { reasons });
  }
  const next: ItemRow = {
    ...current,
    status: target,
    // posted_at is set automatically on first publish, and editable after (§4.1).
    postedAt: target === 'public' && current.postedAt === null ? at : current.postedAt,
    updatedAt: at,
  };
  await run(db, [
    db
      .update(items)
      .set({ status: next.status, postedAt: next.postedAt, updatedAt: at })
      .where(eq(items.id, id)),
    revisionOp(db, next, await readRelations(db, id), at),
    auditOp(db, actor, 'item.status', id, { from: current.status, to: target }, at),
    ...reindexItemOps(db, id),
  ]);
  return next;
}

/** Move to the trash (ADM-04): disappears from every public surface at once. */
export async function trashItem(
  d1: D1Database,
  id: string,
  actor: string,
  now: Date = new Date(),
): Promise<ItemRow> {
  return setTrashed(d1, id, true, actor, now);
}

export async function restoreItem(
  d1: D1Database,
  id: string,
  actor: string,
  now: Date = new Date(),
): Promise<ItemRow> {
  return setTrashed(d1, id, false, actor, now);
}

async function setTrashed(
  d1: D1Database,
  id: string,
  trashed: boolean,
  actor: string,
  now: Date,
): Promise<ItemRow> {
  const db = drizzle(d1);
  const at = nowIso(now);
  const current = await getRow(db, id);
  if (trashed === (current.deletedAt !== null)) return current;
  const next: ItemRow = { ...current, deletedAt: trashed ? at : null, updatedAt: at };
  await run(db, [
    db.update(items).set({ deletedAt: next.deletedAt, updatedAt: at }).where(eq(items.id, id)),
    revisionOp(db, next, await readRelations(db, id), at),
    auditOp(db, actor, trashed ? 'item.trash' : 'item.restore', id, {}, at),
    ...reindexItemOps(db, id),
  ]);
  return next;
}

/** Replace the item's categories (CNT-02). A public item keeps at least one. */
export async function setItemCategories(
  d1: D1Database,
  id: string,
  categoryIds: string[],
  actor: string,
  now: Date = new Date(),
): Promise<void> {
  const ids = [...new Set(IdList(MAX_CATEGORIES_PER_ITEM).parse(categoryIds))].sort();
  const db = drizzle(d1);
  const at = nowIso(now);
  const current = await getRow(db, id);
  if (ids.length > 0) {
    const found = await db
      .select({ id: categories.id })
      .from(categories)
      .where(inArray(categories.id, ids));
    if (found.length !== ids.length) throw new DomainError('invalid', { field: 'categories' });
  }
  if (current.status === 'public' && ids.length === 0) {
    throw new DomainError('cannot_publish', { reasons: ['needs_category'] });
  }
  const rel = await readRelations(db, id);
  const next = { ...current, updatedAt: at };
  await run(db, [
    db.delete(itemCategories).where(eq(itemCategories.itemId, id)),
    ...ids.map((categoryId) => db.insert(itemCategories).values({ itemId: id, categoryId })),
    db.update(items).set({ updatedAt: at }).where(eq(items.id, id)),
    revisionOp(db, next, { ...rel, categoryIds: ids }, at),
    auditOp(db, actor, 'item.categories', id, { from: rel.categoryIds, to: ids }, at),
    ...reindexItemOps(db, id),
  ]);
}

/** Replace the item's tags by name, creating any new tags (tag manager: M3). */
export async function setItemTags(
  d1: D1Database,
  id: string,
  names: string[],
  actor: string,
  now: Date = new Date(),
): Promise<void> {
  const cleaned = TagNames.parse(names);
  const db = drizzle(d1);
  const at = nowIso(now);
  const current = await getRow(db, id);

  const bySlug = new Map<string, string>();
  for (const name of cleaned) {
    const slug = slugify(name, '');
    if (slug && !bySlug.has(slug)) bySlug.set(slug, name);
  }
  const slugs = [...bySlug.keys()];
  const existing = slugs.length
    ? await db.select().from(tags).where(inArray(tags.slug, slugs))
    : [];
  const existingBySlug = new Map(existing.map((t) => [t.slug, t.id]));
  const created = slugs
    .filter((s) => !existingBySlug.has(s))
    .map((s) => ({ id: ulid(now.getTime()), name: bySlug.get(s) ?? s, slug: s, createdAt: at }));
  const tagIds = [...existing.map((t) => t.id), ...created.map((t) => t.id)].sort();

  const rel = await readRelations(db, id);
  await run(db, [
    ...created.map((t) => db.insert(tags).values(t)),
    db.delete(itemTags).where(eq(itemTags.itemId, id)),
    ...tagIds.map((tagId) => db.insert(itemTags).values({ itemId: id, tagId })),
    db.update(items).set({ updatedAt: at }).where(eq(items.id, id)),
    revisionOp(db, { ...current, updatedAt: at }, { ...rel, tagIds }, at),
    auditOp(db, actor, 'item.tags', id, { tags: slugs }, at),
    ...reindexItemOps(db, id),
  ]);
}

/**
 * Restore an item's content from a revision (ADM-05). Restores fields,
 * categories and tags that still exist. Status and trash state stay as they
 * are now (restoring old content must never silently publish or unpublish);
 * media order is not restored in M1.
 */
export async function restoreRevision(
  d1: D1Database,
  revisionId: string,
  actor: string,
  now: Date = new Date(),
): Promise<ItemRow> {
  const db = drizzle(d1);
  const [rev] = await db
    .select()
    .from(itemRevisions)
    .where(eq(itemRevisions.id, revisionId))
    .limit(1);
  if (!rev) throw new DomainError('not_found');
  const snap = RevisionSnapshot.parse(JSON.parse(rev.snapshot));
  const itemId = rev.itemId;
  const current = await getRow(db, itemId);

  const slugFree = !(await slugTaken(db, snap.item.slug, itemId));
  const patch: ItemUpdateInput = {
    title: snap.item.title,
    description: snap.item.description,
    ...(slugFree ? { slug: snap.item.slug } : {}),
    kind: current.status === 'public' ? current.kind : snap.item.kind,
    postedAt: snap.item.postedAt,
    licenseOverride: snap.item.licenseOverride,
    watermarkOverride: snap.item.watermarkOverride,
    purchasePriceCents: snap.item.purchasePriceCents,
    purchaseCurrency: snap.item.purchaseCurrency,
    purchaseDate: snap.item.purchaseDate,
    openToParting: snap.item.openToParting,
    sourceCaption: snap.item.sourceCaption,
  };
  const restored = await updateItem(d1, itemId, patch, actor, now);

  const [liveCats, liveTags] = await db.batch([
    snap.categoryIds.length
      ? db
          .select({ id: categories.id })
          .from(categories)
          .where(inArray(categories.id, snap.categoryIds))
      : db
          .select({ id: categories.id })
          .from(categories)
          .where(sql`0`),
    snap.tagIds.length
      ? db.select({ name: tags.name }).from(tags).where(inArray(tags.id, snap.tagIds))
      : db
          .select({ name: tags.name })
          .from(tags)
          .where(sql`0`),
  ]);
  const catIds = liveCats.map((c) => c.id);
  if (!(current.status === 'public' && catIds.length === 0)) {
    await setItemCategories(d1, itemId, catIds, actor, now);
  }
  await setItemTags(
    d1,
    itemId,
    liveTags.map((t) => t.name),
    actor,
    now,
  );
  const auditAt = nowIso(now);
  await run(db, [auditOp(db, actor, 'item.revision_restore', itemId, { revisionId }, auditAt)]);
  return restored;
}
