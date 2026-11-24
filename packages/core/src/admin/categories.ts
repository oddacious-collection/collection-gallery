/**
 * Admin category tree (CNT-01..03, ADM-06).
 *
 * Categories form a single-parent tree of unlimited depth. Alongside
 * `parent_id`, the `category_closure` table holds every ancestor/descendant
 * pair (including each node with itself at depth 0), so "this category and
 * everything under it" is one indexed query (CNT-02/03). Every change keeps
 * the closure table consistent inside the same D1 batch.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { z } from 'zod';
import { LICENSES, categories, categoryClosure, itemCategories } from '../db/schema.ts';
import { ulid } from '../ids.ts';
import { SLUG_MAX_LENGTH, SLUG_PATTERN, slugify, uniqueSlug } from '../slug.ts';
import { audit, run, type Db, type Op } from './db-util.ts';
import { DomainError } from './domain-error.ts';

export type CategoryRow = typeof categories.$inferSelect;

const id = z.string().min(1).max(32);
const fields = {
  name: z.string().trim().min(1).max(100),
  slug: z.string().max(SLUG_MAX_LENGTH).regex(SLUG_PATTERN),
  description: z.string().max(5_000),
  defaultLicense: z.enum(LICENSES).nullable(),
};
export const CategoryCreate = z.strictObject({
  name: fields.name,
  slug: fields.slug.optional(),
  parentId: id.nullable().default(null),
  description: fields.description.default(''),
  defaultLicense: fields.defaultLicense.default(null),
});
export const CategoryUpdate = z.strictObject(fields).partial();

async function getRow(db: Db, categoryId: string): Promise<CategoryRow> {
  const [row] = await db.select().from(categories).where(eq(categories.id, categoryId)).limit(1);
  if (!row) throw new DomainError('not_found');
  return row;
}

async function slugTaken(db: Db, slug: string, exceptId?: string): Promise<boolean> {
  const [row] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.slug, slug))
    .limit(1);
  return row !== undefined && row.id !== exceptId;
}

async function nextPosition(db: Db, parentId: string | null): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${categories.position})` })
    .from(categories)
    .where(parentId === null ? isNull(categories.parentId) : eq(categories.parentId, parentId));
  return (row?.max ?? -1) + 1;
}

// ------------------------------------------------------------------ reads

export interface CategoryNode extends CategoryRow {
  depth: number;
  /** Items directly in this category (not counting descendants). */
  itemCount: number;
}

/** The whole tree in display order (depth-first, siblings by position). */
export async function listCategoryTree(d1: D1Database): Promise<CategoryNode[]> {
  const db = drizzle(d1);
  const [rows, counts] = await db.batch([
    db.select().from(categories).orderBy(asc(categories.position), asc(categories.name)),
    db
      .select({ categoryId: itemCategories.categoryId, n: sql<number>`count(*)` })
      .from(itemCategories)
      .groupBy(itemCategories.categoryId),
  ]);
  const countBy = new Map(counts.map((c) => [c.categoryId, c.n]));
  const children = new Map<string | null, CategoryRow[]>();
  for (const row of rows) {
    const list = children.get(row.parentId) ?? [];
    list.push(row);
    children.set(row.parentId, list);
  }
  const out: CategoryNode[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const row of children.get(parentId) ?? []) {
      out.push({ ...row, depth, itemCount: countBy.get(row.id) ?? 0 });
      walk(row.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** IDs of the category and all its descendants (CNT-02). */
export async function descendantIds(d1: D1Database, categoryId: string): Promise<string[]> {
  const rows = await drizzle(d1)
    .select({ id: categoryClosure.descendantId })
    .from(categoryClosure)
    .where(eq(categoryClosure.ancestorId, categoryId));
  return rows.map((r) => r.id);
}

// ------------------------------------------------------------------ writes

export async function createCategory(
  d1: D1Database,
  input: z.input<typeof CategoryCreate>,
  actor: string,
  now: Date = new Date(),
): Promise<CategoryRow> {
  const data = CategoryCreate.parse(input);
  const db = drizzle(d1);
  const at = now.toISOString();
  if (data.parentId !== null) await getRow(db, data.parentId);

  let slug: string;
  if (data.slug !== undefined) {
    if (await slugTaken(db, data.slug)) throw new DomainError('slug_taken', { slug: data.slug });
    slug = data.slug;
  } else {
    slug = await uniqueSlug(slugify(data.name, 'category'), (c) => slugTaken(db, c));
  }

  const row: CategoryRow = {
    id: ulid(now.getTime()),
    parentId: data.parentId,
    name: data.name,
    slug,
    description: data.description,
    position: await nextPosition(db, data.parentId),
    coverMediaId: null,
    defaultLicense: data.defaultLicense,
    createdAt: at,
    updatedAt: at,
  };
  const ops: Op[] = [
    db.insert(categories).values(row),
    db.insert(categoryClosure).values({ ancestorId: row.id, descendantId: row.id, depth: 0 }),
  ];
  if (row.parentId !== null) {
    // Every ancestor of the parent (the parent included) is an ancestor of the new node.
    ops.push(
      db.insert(categoryClosure).select(sql`
        SELECT ancestor_id, ${row.id}, depth + 1 FROM category_closure
        WHERE descendant_id = ${row.parentId}`),
    );
  }
  ops.push(audit(db, 'category', actor, 'category.create', row.id, { slug }, at));
  await run(db, ops);
  return row;
}

export async function updateCategory(
  d1: D1Database,
  categoryId: string,
  patch: z.input<typeof CategoryUpdate>,
  actor: string,
  now: Date = new Date(),
): Promise<CategoryRow> {
  const data = CategoryUpdate.parse(patch);
  const db = drizzle(d1);
  const at = now.toISOString();
  const current = await getRow(db, categoryId);
  if (data.slug !== undefined && data.slug !== current.slug) {
    if (await slugTaken(db, data.slug, categoryId)) {
      throw new DomainError('slug_taken', { slug: data.slug });
    }
  }
  const next: CategoryRow = {
    ...current,
    ...(data.name !== undefined ? { name: data.name } : {}),
    ...(data.slug !== undefined ? { slug: data.slug } : {}),
    ...(data.description !== undefined ? { description: data.description } : {}),
    ...(data.defaultLicense !== undefined ? { defaultLicense: data.defaultLicense } : {}),
    updatedAt: at,
  };
  await run(db, [
    db
      .update(categories)
      .set({
        name: next.name,
        slug: next.slug,
        description: next.description,
        defaultLicense: next.defaultLicense,
        updatedAt: at,
      })
      .where(eq(categories.id, categoryId)),
    audit(db, 'category', actor, 'category.update', categoryId, { changed: Object.keys(data) }, at),
  ]);
  return next;
}

/**
 * Moves a category (and its whole subtree) under a new parent, or to the top
 * level. CNT-01: moving a category under itself or one of its descendants is
 * rejected. The moved category goes last among its new siblings.
 */
export async function moveCategory(
  d1: D1Database,
  categoryId: string,
  newParentId: string | null,
  actor: string,
  now: Date = new Date(),
): Promise<void> {
  const db = drizzle(d1);
  const at = now.toISOString();
  const current = await getRow(db, categoryId);
  if (newParentId === current.parentId) return;
  if (newParentId !== null) {
    await getRow(db, newParentId);
    const [cycle] = await db
      .select({ d: categoryClosure.descendantId })
      .from(categoryClosure)
      .where(
        and(
          eq(categoryClosure.ancestorId, categoryId),
          eq(categoryClosure.descendantId, newParentId),
        ),
      )
      .limit(1);
    if (cycle) throw new DomainError('invalid', { reason: 'cycle' });
  }

  const ops: Op[] = [
    // Detach the subtree from its old ancestors (paths inside the subtree stay).
    db.delete(categoryClosure).where(sql`
      descendant_id IN (SELECT descendant_id FROM category_closure WHERE ancestor_id = ${categoryId})
      AND ancestor_id NOT IN (SELECT descendant_id FROM category_closure WHERE ancestor_id = ${categoryId})`),
  ];
  if (newParentId !== null) {
    // Attach it under every ancestor of the new parent (the parent included).
    ops.push(
      db.insert(categoryClosure).select(sql`
        SELECT p.ancestor_id, c.descendant_id, p.depth + c.depth + 1
        FROM category_closure p, category_closure c
        WHERE p.descendant_id = ${newParentId} AND c.ancestor_id = ${categoryId}`),
    );
  }
  ops.push(
    db
      .update(categories)
      .set({ parentId: newParentId, position: await nextPosition(db, newParentId), updatedAt: at })
      .where(eq(categories.id, categoryId)),
    audit(
      db,
      'category',
      actor,
      'category.move',
      categoryId,
      { from: current.parentId, to: newParentId },
      at,
    ),
  );
  await run(db, ops);
}

/** Sets the order of one parent's children (ADM-06 reorder). Must list exactly those children. */
export async function reorderCategories(
  d1: D1Database,
  parentId: string | null,
  orderedIds: string[],
  actor: string,
  now: Date = new Date(),
): Promise<void> {
  const db = drizzle(d1);
  const at = now.toISOString();
  const siblings = await db
    .select({ id: categories.id })
    .from(categories)
    .where(parentId === null ? isNull(categories.parentId) : eq(categories.parentId, parentId));
  const expected = new Set(siblings.map((s) => s.id));
  if (orderedIds.length !== expected.size || !orderedIds.every((i) => expected.has(i))) {
    throw new DomainError('invalid', { reason: 'not_the_same_siblings' });
  }
  await run(db, [
    ...orderedIds.map((cid, position) =>
      db.update(categories).set({ position, updatedAt: at }).where(eq(categories.id, cid)),
    ),
    audit(db, 'category', actor, 'category.reorder', parentId ?? 'root', { order: orderedIds }, at),
  ]);
}

/** ADM-06: only an empty category (no subcategories, no items) can be deleted. */
export async function deleteCategory(
  d1: D1Database,
  categoryId: string,
  actor: string,
  now: Date = new Date(),
): Promise<void> {
  const db = drizzle(d1);
  const at = now.toISOString();
  await getRow(db, categoryId);
  const [[child], [item]] = await db.batch([
    db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.parentId, categoryId))
      .limit(1),
    db
      .select({ id: itemCategories.itemId })
      .from(itemCategories)
      .where(eq(itemCategories.categoryId, categoryId))
      .limit(1),
  ]);
  const reasons = [...(child ? ['has_children'] : []), ...(item ? ['has_items'] : [])];
  if (reasons.length > 0) throw new DomainError('conflict', { reasons });
  await run(db, [
    db.delete(categoryClosure).where(eq(categoryClosure.descendantId, categoryId)),
    db.delete(categories).where(eq(categories.id, categoryId)),
    audit(db, 'category', actor, 'category.delete', categoryId, {}, at),
  ]);
}
