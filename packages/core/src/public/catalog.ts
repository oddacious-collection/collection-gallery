/**
 * Public catalog queries: categories, item cards, item pages, list contexts
 * (for paging and the vertical feed, PUB-05) and search (PUB-08).
 * Exported through `@cg/core/public`.
 *
 * INV-1 rules for this file:
 * - every query that touches items filters with `publiclyVisible`, the single
 *   definition of "public" (items.ts);
 * - only allowlisted public values leave: slugs, titles, descriptions, posted
 *   dates, category and tag names, alt text and public media keys. Internal
 *   IDs are used inside queries only and never returned.
 * - a category is shown only if at least one public item is filed under it
 *   or its subcategories, so unused or work-in-progress categories stay hidden.
 */
import { sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { SLUG_MAX_LENGTH, SLUG_PATTERN } from '../slug.ts';
import { publiclyVisible } from './items.ts';

type Db = ReturnType<typeof drizzle>;

// ------------------------------------------------------------------ types

export interface PublicImageSource {
  key: string;
  width: number;
  height: number;
}

export interface PublicImage {
  /** The photo's alt text, or the item title when blank (ADM-03). */
  alt: string;
  width: number;
  height: number;
  /** Public WebP sizes, smallest first (MED-05). */
  sources: PublicImageSource[];
  /** The 1200 px JPEG for link previews. */
  og: PublicImageSource | null;
}

export interface PublicCard {
  slug: string;
  title: string;
  postedAt: string | null;
  cover: PublicImage | null;
}

export interface PublicCategory {
  slug: string;
  name: string;
  description: string;
  parentSlug: string | null;
  /** Public items filed here or in any subcategory. Always ≥ 1. */
  itemCount: number;
}

export interface PublicItemDetail {
  slug: string;
  title: string;
  description: string;
  postedAt: string | null;
  media: PublicImage[];
  /** Each category the item is filed in, with its path from the top level. */
  categories: Array<{ trail: Array<{ slug: string; name: string }> }>;
  tags: string[];
}

/** Which list an item page or feed belongs to (PUB-05). */
export type ListContext =
  | { kind: 'all' }
  | { kind: 'category'; slug: string; descendants: boolean }
  | { kind: 'search'; q: string; category?: string };

export const SEARCH_MAX_RESULTS = 1000;
export const SEARCH_MAX_QUERY = 100;

// ------------------------------------------------------------------ helpers

function validSlug(s: string): boolean {
  return s.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(s);
}

function idList(ids: string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}

/**
 * The FTS5 query for visitor input: words only, each matched as a prefix,
 * all required. No FTS syntax from the visitor ever reaches the engine.
 */
export function toFtsQuery(q: string): string | null {
  const words = (
    q
      .slice(0, SEARCH_MAX_QUERY)
      .normalize('NFKC')
      .match(/[\p{L}\p{N}]+/gu) ?? []
  )
    .map((w) => w.slice(0, 40))
    .slice(0, 8);
  if (words.length === 0) return null;
  return words.map((w) => `"${w}"*`).join(' ');
}

/** SQL condition: the item (table `items`) belongs to the context. */
function contextCondition(ctx: ListContext): SQL | null {
  if (ctx.kind === 'all') return sql`1`;
  if (ctx.kind === 'category') {
    if (!validSlug(ctx.slug)) return null;
    return ctx.descendants
      ? sql`items.id IN (
          SELECT ic.item_id FROM item_categories ic
          JOIN category_closure cc ON cc.descendant_id = ic.category_id
          JOIN categories c ON c.id = cc.ancestor_id
          WHERE c.slug = ${ctx.slug})`
      : sql`items.id IN (
          SELECT ic.item_id FROM item_categories ic
          JOIN categories c ON c.id = ic.category_id
          WHERE c.slug = ${ctx.slug})`;
  }
  if (ctx.category !== undefined && !validSlug(ctx.category)) return null;
  return ctx.category === undefined
    ? sql`1`
    : contextCondition({ kind: 'category', slug: ctx.category, descendants: true });
}

/** Internal ids of a context's items, in display order. */
async function contextIds(
  db: Db,
  ctx: ListContext,
  offset: number,
  limit: number,
): Promise<{ ids: string[]; total: number }> {
  const cond = contextCondition(ctx);
  if (!cond) return { ids: [], total: 0 };
  const lim = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const off = Math.min(Math.max(Math.trunc(offset), 0), SEARCH_MAX_RESULTS);

  if (ctx.kind === 'search') {
    const match = toFtsQuery(ctx.q);
    if (!match) return { ids: [], total: 0 };
    const from = sql`FROM search_index JOIN items ON items.id = search_index.item_id
      WHERE search_index MATCH ${match} AND ${publiclyVisible} AND ${cond}`;
    const [rows, count] = await Promise.all([
      db.all<{ id: string }>(sql`SELECT items.id AS id ${from}
        ORDER BY bm25(search_index, 0.0, 10.0, 3.0, 4.0, 2.0), items.posted_at DESC, items.slug DESC
        LIMIT ${lim} OFFSET ${off}`),
      db.get<{ n: number }>(sql`SELECT count(*) AS n ${from}`),
    ]);
    return { ids: rows.map((r) => r.id), total: Math.min(count?.n ?? 0, SEARCH_MAX_RESULTS) };
  }
  const where = sql`WHERE ${publiclyVisible} AND ${cond}`;
  const [rows, count] = await Promise.all([
    db.all<{ id: string }>(sql`SELECT items.id AS id FROM items ${where}
      ORDER BY items.posted_at DESC, items.slug DESC LIMIT ${lim} OFFSET ${off}`),
    db.get<{ n: number }>(sql`SELECT count(*) AS n FROM items ${where}`),
  ]);
  return { ids: rows.map((r) => r.id), total: count?.n ?? 0 };
}

interface ItemRowLite {
  id: string;
  slug: string;
  title: string;
  description: string;
  postedAt: string | null;
}

async function itemRows(db: Db, ids: string[]): Promise<ItemRowLite[]> {
  if (ids.length === 0) return [];
  const rows = await db.all<ItemRowLite>(sql`
    SELECT items.id AS id, items.slug AS slug, items.title AS title,
           items.description AS description, items.posted_at AS postedAt
    FROM items WHERE items.id IN (${idList(ids)}) AND ${publiclyVisible}`);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/** Public photos of the given (public) items, in order. Alt falls back to the title. */
async function mediaFor(db: Db, rows: ItemRowLite[]): Promise<Map<string, PublicImage[]>> {
  const out = new Map<string, PublicImage[]>();
  if (rows.length === 0) return out;
  const variants = await db.all<{
    mediaId: string;
    itemId: string;
    alt: string;
    width: number;
    height: number;
    key: string;
    role: string;
    vw: number;
    vh: number;
  }>(sql`
    SELECT m.id AS mediaId, m.item_id AS itemId, m.alt_text AS alt, m.width AS width,
           m.height AS height, v.key AS key, v.role AS role, v.width AS vw, v.height AS vh
    FROM media m
    JOIN media_variants v ON v.media_id = m.id
    JOIN items ON items.id = m.item_id
    WHERE m.item_id IN (${idList(rows.map((r) => r.id))})
      AND m.deleted_at IS NULL AND m.kind = 'image' AND ${publiclyVisible}
    ORDER BY m.item_id, m.position, m.id, v.width`);
  const title = new Map(rows.map((r) => [r.id, r.title]));
  const images = new Map<string, PublicImage & { itemId: string }>();
  for (const v of variants) {
    let img = images.get(v.mediaId);
    if (!img) {
      img = {
        itemId: v.itemId,
        alt: v.alt.trim() || (title.get(v.itemId) ?? ''),
        width: v.width,
        height: v.height,
        sources: [],
        og: null,
      };
      images.set(v.mediaId, img);
    }
    const source = { key: v.key, width: v.vw, height: v.vh };
    if (v.role === 'image') img.sources.push(source);
    else if (v.role === 'og') img.og = source;
  }
  for (const { itemId, ...img } of images.values()) {
    if (img.sources.length === 0) continue;
    const list = out.get(itemId) ?? [];
    list.push(img);
    out.set(itemId, list);
  }
  return out;
}

function cardsOf(rows: ItemRowLite[], media: Map<string, PublicImage[]>): PublicCard[] {
  return rows.map((r) => ({
    slug: r.slug,
    title: r.title,
    postedAt: r.postedAt,
    cover: media.get(r.id)?.[0] ?? null,
  }));
}

// ------------------------------------------------------------------ categories

/** Categories that have public items (in themselves or below), in tree order. */
export async function listPublicCategories(d1: D1Database): Promise<PublicCategory[]> {
  const db = drizzle(d1);
  const rows = await db.all<{
    id: string;
    parentId: string | null;
    slug: string;
    name: string;
    description: string;
    n: number;
  }>(sql`
    SELECT c.id AS id, c.parent_id AS parentId, c.slug AS slug, c.name AS name,
           c.description AS description,
           (SELECT count(DISTINCT ic.item_id)
              FROM category_closure cc
              JOIN item_categories ic ON ic.category_id = cc.descendant_id
              JOIN items ON items.id = ic.item_id
             WHERE cc.ancestor_id = c.id AND ${publiclyVisible}) AS n
    FROM categories c
    ORDER BY c.position, c.name`);
  const slugOf = new Map(rows.map((r) => [r.id, r.slug]));
  return rows
    .filter((r) => r.n > 0)
    .map((r) => ({
      slug: r.slug,
      name: r.name,
      description: r.description,
      parentSlug: r.parentId ? (slugOf.get(r.parentId) ?? null) : null,
      itemCount: r.n,
    }));
}

/** The path from the top level down to `slug` (inclusive), or [] if not public. */
export function categoryTrail(
  all: PublicCategory[],
  slug: string,
): Array<{ slug: string; name: string }> {
  const bySlug = new Map(all.map((c) => [c.slug, c]));
  const trail: Array<{ slug: string; name: string }> = [];
  let current = bySlug.get(slug);
  const seen = new Set<string>();
  while (current && !seen.has(current.slug)) {
    seen.add(current.slug);
    trail.unshift({ slug: current.slug, name: current.name });
    current = current.parentSlug ? bySlug.get(current.parentSlug) : undefined;
  }
  return trail;
}

/** A cover photo per category: the cover of its newest public item. */
export async function categoryCovers(
  d1: D1Database,
  slugs: string[],
): Promise<Map<string, PublicImage>> {
  const out = new Map<string, PublicImage>();
  const valid = slugs.filter(validSlug);
  if (valid.length === 0) return out;
  const db = drizzle(d1);
  const picks = await db.all<{ slug: string; itemId: string }>(sql`
    SELECT slug, itemId FROM (
      SELECT c.slug AS slug, items.id AS itemId,
             row_number() OVER (PARTITION BY c.id ORDER BY items.posted_at DESC, items.slug DESC) AS rn
      FROM categories c
      JOIN category_closure cc ON cc.ancestor_id = c.id
      JOIN item_categories ic ON ic.category_id = cc.descendant_id
      JOIN items ON items.id = ic.item_id
      WHERE c.slug IN (${idList(valid)}) AND ${publiclyVisible}
        AND EXISTS (SELECT 1 FROM media m WHERE m.item_id = items.id AND m.deleted_at IS NULL)
    ) WHERE rn = 1`);
  const rows = await itemRows(
    db,
    picks.map((p) => p.itemId),
  );
  const media = await mediaFor(db, rows);
  for (const p of picks) {
    const cover = media.get(p.itemId)?.[0];
    if (cover) out.set(p.slug, cover);
  }
  return out;
}

// ------------------------------------------------------------------ lists

export interface CardPage {
  cards: PublicCard[];
  total: number;
}

/** One page of a list (home, category, search), as cards. */
export async function listContextCards(
  d1: D1Database,
  ctx: ListContext,
  offset: number,
  limit: number,
): Promise<CardPage> {
  const db = drizzle(d1);
  const { ids, total } = await contextIds(db, ctx, offset, limit);
  const rows = await itemRows(db, ids);
  return { cards: cardsOf(rows, await mediaFor(db, rows)), total };
}

/** Full public items of a context, for the feed (PUB-05). */
export async function listContextItems(
  d1: D1Database,
  ctx: ListContext,
  offset: number,
  limit: number,
): Promise<{ items: PublicItemDetail[]; total: number }> {
  const db = drizzle(d1);
  const { ids, total } = await contextIds(db, ctx, offset, limit);
  return { items: await details(d1, db, await itemRows(db, ids)), total };
}

/** Where an item sits in a context (0-based), or null if it isn't in it. */
export async function contextPosition(
  d1: D1Database,
  ctx: ListContext,
  slug: string,
): Promise<number | null> {
  if (!validSlug(slug)) return null;
  const db = drizzle(d1);
  if (ctx.kind === 'search') {
    const { ids } = await contextIds(db, ctx, 0, 100);
    // Search contexts are short; walk them in pages.
    const all = [...ids];
    for (let off = 100; all.length === off && off < SEARCH_MAX_RESULTS; off += 100) {
      all.push(...(await contextIds(db, ctx, off, 100)).ids);
    }
    const rows = await db.all<{ id: string }>(
      sql`SELECT items.id AS id FROM items WHERE items.slug = ${slug} AND ${publiclyVisible}`,
    );
    const index = rows[0] ? all.indexOf(rows[0].id) : -1;
    return index === -1 ? null : index;
  }
  const cond = contextCondition(ctx);
  if (!cond) return null;
  const row = await db.get<{ inside: number; before: number }>(sql`
    SELECT
      (SELECT count(*) FROM items WHERE items.slug = ${slug} AND ${publiclyVisible} AND ${cond}) AS inside,
      (SELECT count(*) FROM items, (SELECT posted_at AS p, slug AS s FROM items WHERE slug = ${slug}) me
        WHERE ${publiclyVisible} AND ${cond}
          AND (items.posted_at > me.p OR (items.posted_at = me.p AND items.slug > me.s))) AS before`);
  return row && row.inside > 0 ? row.before : null;
}

// ------------------------------------------------------------------ items

async function details(d1: D1Database, db: Db, rows: ItemRowLite[]): Promise<PublicItemDetail[]> {
  if (rows.length === 0) return [];
  const ids = idList(rows.map((r) => r.id));
  const [media, cats, tagRows, allCats] = await Promise.all([
    mediaFor(db, rows),
    db.all<{ itemId: string; slug: string }>(sql`
      SELECT ic.item_id AS itemId, c.slug AS slug
      FROM item_categories ic JOIN categories c ON c.id = ic.category_id
      WHERE ic.item_id IN (${ids}) ORDER BY c.name`),
    db.all<{ itemId: string; name: string }>(sql`
      SELECT it.item_id AS itemId, t.name AS name
      FROM item_tags it JOIN tags t ON t.id = it.tag_id
      WHERE it.item_id IN (${ids}) ORDER BY t.name`),
    listPublicCategories(d1),
  ]);
  return rows.map((r) => ({
    slug: r.slug,
    title: r.title,
    description: r.description,
    postedAt: r.postedAt,
    media: media.get(r.id) ?? [],
    categories: cats
      .filter((c) => c.itemId === r.id)
      .map((c) => ({ trail: categoryTrail(allCats, c.slug) }))
      .filter((c) => c.trail.length > 0),
    tags: tagRows.filter((t) => t.itemId === r.id).map((t) => t.name),
  }));
}

/** One public item's page data, or null (PUB-15: callers answer 404 or redirect). */
export async function getPublicItemDetail(
  d1: D1Database,
  slug: string,
): Promise<PublicItemDetail | null> {
  if (!validSlug(slug)) return null;
  const db = drizzle(d1);
  const found = await db.all<{ id: string }>(
    sql`SELECT items.id AS id FROM items WHERE items.slug = ${slug} AND ${publiclyVisible}`,
  );
  const [first] = found;
  if (!first) return null;
  const [detail] = await details(d1, db, await itemRows(db, [first.id]));
  return detail ?? null;
}
