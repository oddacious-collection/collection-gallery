/**
 * Public item queries (INV-1, PUB-15). Exported through `@cg/core/public`.
 *
 * Every query here:
 * - filters with `publiclyVisible` (status = public, kind = owned, not in the
 *   trash), the single definition of "public" used anywhere; and
 * - selects only the allowlisted columns in `PUBLIC_ITEM_COLUMNS`. Internal IDs
 *   are never returned: a ULID encodes its creation time, which is admin data.
 */
import { and, desc, eq, isNull, lt, or, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { items, slugRedirects } from '../db/schema.ts';
import { SLUG_MAX_LENGTH, SLUG_PATTERN } from '../slug.ts';

/** The only definition of a publicly visible item. */
export const publiclyVisible: SQL = and(
  eq(items.status, 'public'),
  eq(items.kind, 'owned'),
  isNull(items.deletedAt),
) as SQL;

/** Columns that may leave the public Worker. Adding one here is a privacy decision. */
const PUBLIC_ITEM_COLUMNS = {
  slug: items.slug,
  title: items.title,
  description: items.description,
  postedAt: items.postedAt,
  licenseOverride: items.licenseOverride,
};

export interface PublicItem {
  slug: string;
  title: string;
  description: string;
  postedAt: string | null;
  licenseOverride: string | null;
}

export type PublicItemLookup =
  { kind: 'item'; item: PublicItem } | { kind: 'redirect'; slug: string } | { kind: 'not_found' };

function isValidSlug(slug: string): boolean {
  return slug.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(slug);
}

/**
 * An item page lookup. Draft, private, wishlist, trashed and nonexistent items
 * all give the same `not_found` (PUB-15); an old slug redirects only if the
 * item is public now.
 */
export async function getPublicItemBySlug(d1: D1Database, slug: string): Promise<PublicItemLookup> {
  if (!isValidSlug(slug)) return { kind: 'not_found' };
  const db = drizzle(d1);
  const [item] = await db
    .select(PUBLIC_ITEM_COLUMNS)
    .from(items)
    .where(and(eq(items.slug, slug), publiclyVisible))
    .limit(1);
  if (item) return { kind: 'item', item };

  const [redirect] = await db
    .select({ slug: items.slug })
    .from(slugRedirects)
    .innerJoin(items, eq(items.id, slugRedirects.itemId))
    .where(and(eq(slugRedirects.oldSlug, slug), publiclyVisible))
    .limit(1);
  if (redirect) return { kind: 'redirect', slug: redirect.slug };
  return { kind: 'not_found' };
}

export interface PublicItemPage {
  items: PublicItem[];
  /** Pass back as `after` for the next page; null when there are no more. */
  next: { postedAt: string; slug: string } | null;
}

/** Public items, newest first, with keyset paging (stable while items are added). */
export async function listPublicItems(
  d1: D1Database,
  opts: { limit?: number; after?: { postedAt: string; slug: string } } = {},
): Promise<PublicItemPage> {
  const limit = Math.min(Math.max(opts.limit ?? 24, 1), 100);
  const db = drizzle(d1);
  const where: SQL[] = [publiclyVisible];
  if (opts.after) {
    const { postedAt, slug } = opts.after;
    where.push(
      or(
        lt(items.postedAt, postedAt),
        and(eq(items.postedAt, postedAt), lt(items.slug, slug)),
      ) as SQL,
    );
  }
  const rows = await db
    .select(PUBLIC_ITEM_COLUMNS)
    .from(items)
    .where(and(...where))
    .orderBy(desc(items.postedAt), desc(items.slug))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page,
    next:
      rows.length > limit && last?.postedAt ? { postedAt: last.postedAt, slug: last.slug } : null,
  };
}
