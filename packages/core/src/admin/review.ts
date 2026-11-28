/**
 * Reviewing imported drafts (IMP-04; D-62 (3) and (7); M2 step 5):
 *
 * - the **queue**: imported drafts not reviewed yet, newest first, with
 *   "needs a look" (flagged by the plan or the importer) and "repeats" views;
 * - **save and next**: title, description, categories and tags in one go,
 *   then save, publish or trash; a reviewed draft leaves the queue;
 * - **hashtag rules**: the owner maps a hashtag once to a category and/or a
 *   tag, and applying the rules adds them to every imported draft with that
 *   hashtag (an explicit owner choice, so D-42's "no automatic tags" stands);
 * - **bulk actions** on any items: publish, trash, add a category.
 *
 * Everything goes through the normal item functions, so revisions, the audit
 * log, the search index and the publish rules all apply as usual.
 */
import { eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { z } from 'zod';
import { categories, hashtagRules, items } from '../db/schema.ts';
import { ULID_PATTERN } from '../ids.ts';
import { importReviewOf, type ImportReview } from './import.ts';
import { audit, run } from './db-util.ts';
import { DomainError } from './domain-error.ts';
import {
  getItem,
  setItemCategories,
  setItemStatus,
  setItemTags,
  trashItem,
  updateItem,
} from './items.ts';
import {
  DESCRIPTION_MAX,
  MAX_CATEGORIES_PER_ITEM,
  TAG_NAME_MAX,
  TITLE_MAX,
  TagNames,
} from './validation.ts';

// ------------------------------------------------------------------ the queue

export const QUEUE_FILTERS = ['all', 'flagged', 'repeats'] as const;
export type QueueFilter = (typeof QUEUE_FILTERS)[number];

const UNREVIEWED = sql`items.import_key IS NOT NULL AND items.deleted_at IS NULL
  AND items.status = 'draft'
  AND coalesce(json_extract(items.import_review, '$.reviewed'), 0) = 0`;
const FLAGGED = sql`(json_extract(items.import_review, '$.action') = 'maybe-skip'
  OR json_extract(items.import_review, '$.titleConfidence') IN ('low', 'medium')
  OR json_extract(items.import_review, '$.duplicateGroup') IS NOT NULL
  OR json_extract(items.import_review, '$.mentionsRemoved') > 0
  OR json_extract(items.import_review, '$.notInPlan') = 1)`;
const REPEATS = sql`json_extract(items.import_review, '$.duplicateGroup') IS NOT NULL`;

function filterSql(filter: QueueFilter) {
  return filter === 'flagged' ? FLAGGED : filter === 'repeats' ? REPEATS : sql`1`;
}

export interface QueueState {
  /** The draft to show, or null at the end of this view. */
  nextId: string | null;
  counts: Record<QueueFilter, number>;
}

/** The next unreviewed imported draft (newest first), after `afterId` when skipping. */
export async function reviewQueue(
  d1: D1Database,
  filter: QueueFilter = 'all',
  afterId?: string,
): Promise<QueueState> {
  const db = drizzle(d1);
  const counts = await db.get<{ all: number; flagged: number; repeats: number }>(sql`
    SELECT count(*) AS "all",
      coalesce(sum(CASE WHEN ${FLAGGED} THEN 1 ELSE 0 END), 0) AS flagged,
      coalesce(sum(CASE WHEN ${REPEATS} THEN 1 ELSE 0 END), 0) AS repeats
    FROM items WHERE ${UNREVIEWED}`);
  let after = sql`1`;
  if (afterId && ULID_PATTERN.test(afterId)) {
    const [cur] = await db
      .select({ postedAt: items.postedAt })
      .from(items)
      .where(eq(items.id, afterId))
      .limit(1);
    if (cur) {
      const p = cur.postedAt ?? '';
      after = sql`(coalesce(items.posted_at, '') < ${p}
        OR (coalesce(items.posted_at, '') = ${p} AND items.id < ${afterId}))`;
    }
  }
  const next = await db.get<{ id: string }>(sql`
    SELECT items.id AS id FROM items
    WHERE ${UNREVIEWED} AND ${filterSql(filter)} AND ${after}
    ORDER BY coalesce(items.posted_at, '') DESC, items.id DESC LIMIT 1`);
  return {
    nextId: next?.id ?? null,
    counts: {
      all: counts?.all ?? 0,
      flagged: counts?.flagged ?? 0,
      repeats: counts?.repeats ?? 0,
    },
  };
}

export interface RepeatSibling {
  id: string;
  title: string;
  status: string;
  trashed: boolean;
}

/** The other imported items in the same repeat group (D-62 (6)). */
export async function repeatSiblings(
  d1: D1Database,
  itemId: string,
  group: string,
): Promise<RepeatSibling[]> {
  const db = drizzle(d1);
  const rows = await db.all<{
    id: string;
    title: string;
    status: string;
    deletedAt: string | null;
  }>(
    sql`SELECT id, title, status, deleted_at AS deletedAt FROM items
        WHERE import_key IS NOT NULL AND id <> ${itemId}
          AND json_extract(import_review, '$.duplicateGroup') = ${group}
        ORDER BY coalesce(posted_at, '') DESC`,
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    trashed: r.deletedAt !== null,
  }));
}

/** An imported draft's review flags (null for items not imported). */
export async function reviewFlags(d1: D1Database, itemId: string): Promise<ImportReview | null> {
  const db = drizzle(d1);
  const [row] = await db
    .select({ importReview: items.importReview })
    .from(items)
    .where(eq(items.id, itemId))
    .limit(1);
  return row ? importReviewOf(row) : null;
}

// ------------------------------------------------------------------ save and next

export const ReviewSave = z.strictObject({
  title: z.string().trim().min(1).max(TITLE_MAX),
  description: z.string().max(DESCRIPTION_MAX),
  categoryIds: z.array(z.string().regex(ULID_PATTERN)).max(MAX_CATEGORIES_PER_ITEM),
  tags: TagNames,
  then: z.enum(['save', 'publish', 'trash']),
});
export type ReviewSaveInput = z.input<typeof ReviewSave>;

async function markReviewed(d1: D1Database, id: string, actor: string, at: string) {
  const db = drizzle(d1);
  await run(db, [
    db
      .update(items)
      .set({ importReview: sql`json_set(${items.importReview}, '$.reviewed', 1)` })
      .where(eq(items.id, id)),
    audit(db, 'item', actor, 'item.review', id, {}, at),
  ]);
}

/**
 * Saves one reviewed draft. "publish" that the publish rules block (no
 * category, no photo) is saved but not marked reviewed, and returns why.
 */
export async function saveReview(
  d1: D1Database,
  id: string,
  input: ReviewSaveInput,
  actor: string,
  now: Date = new Date(),
): Promise<{ published: boolean; reasons?: string[] }> {
  const data = ReviewSave.parse(input);
  if (!ULID_PATTERN.test(id)) throw new DomainError('not_found');
  const item = await getItem(d1, id);
  if (item.importKey === null) throw new DomainError('not_found');
  const at = now.toISOString();
  if (data.then === 'trash') {
    await trashItem(d1, id, actor, now);
    await markReviewed(d1, id, actor, at);
    return { published: false };
  }
  await updateItem(d1, id, { title: data.title, description: data.description }, actor, now);
  await setItemCategories(d1, id, data.categoryIds, actor, now);
  await setItemTags(d1, id, data.tags, actor, now);
  if (data.then === 'publish') {
    try {
      await setItemStatus(d1, id, 'public', actor, now);
    } catch (err) {
      if (err instanceof DomainError && err.code === 'cannot_publish') {
        const reasons = err.details['reasons'];
        return { published: false, reasons: Array.isArray(reasons) ? (reasons as string[]) : [] };
      }
      throw err;
    }
  }
  await markReviewed(d1, id, actor, at);
  return { published: data.then === 'publish' };
}

// ------------------------------------------------------------------ hashtag rules

export interface HashtagRow {
  hashtag: string;
  /** Imported items (not in the trash) whose original caption has it. */
  items: number;
  categoryId: string | null;
  categoryName: string | null;
  tagName: string | null;
}

/** Hashtags from imported posts, most used first, with any rule set for them. */
export async function hashtagOverview(
  d1: D1Database,
  opts: { q?: string; limit?: number; offset?: number } = {},
): Promise<{ rows: HashtagRow[]; total: number }> {
  const db = drizzle(d1);
  const q = (opts.q ?? '').trim().toLowerCase().replace(/^#/, '').slice(0, 50);
  const like = q
    ? sql`AND lower(j.value) LIKE ${`${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`} ESCAPE '\\'`
    : sql``;
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 500);
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
  const base = sql`FROM items, json_each(items.suggested_tags) AS j
    WHERE items.import_key IS NOT NULL AND items.deleted_at IS NULL
      AND json_valid(items.suggested_tags) ${like}`;
  const [rows, total] = await Promise.all([
    db.all<HashtagRow>(sql`
      SELECT t.hashtag AS hashtag, t.n AS items, r.category_id AS categoryId,
             c.name AS categoryName, r.tag_name AS tagName
      FROM (SELECT lower(j.value) AS hashtag, count(DISTINCT items.id) AS n ${base}
            GROUP BY lower(j.value)) AS t
      LEFT JOIN hashtag_rules r ON r.hashtag = t.hashtag
      LEFT JOIN categories c ON c.id = r.category_id
      ORDER BY t.n DESC, t.hashtag LIMIT ${limit} OFFSET ${offset}`),
    db.get<{ n: number }>(sql`SELECT count(DISTINCT lower(j.value)) AS n ${base}`),
  ]);
  return { rows, total: total?.n ?? 0 };
}

export const HashtagRule = z.strictObject({
  hashtag: z
    .string()
    .trim()
    .transform((s) => s.replace(/^#/, '').toLowerCase())
    .pipe(z.string().min(1).max(100)),
  categoryId: z.string().regex(ULID_PATTERN).nullable(),
  tagName: z
    .string()
    .trim()
    .max(TAG_NAME_MAX)
    .nullable()
    .transform((s) => (s ? s : null)),
});
export type HashtagRuleInput = z.input<typeof HashtagRule>;

/** Sets (or, with neither a category nor a tag, removes) the rule for a hashtag. */
export async function setHashtagRule(
  d1: D1Database,
  input: HashtagRuleInput,
  actor: string,
  now: Date = new Date(),
): Promise<void> {
  const data = HashtagRule.parse(input);
  const db = drizzle(d1);
  const at = now.toISOString();
  if (data.categoryId) {
    const [cat] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.id, data.categoryId))
      .limit(1);
    if (!cat) throw new DomainError('invalid', { reason: 'unknown_category' });
  }
  if (!data.categoryId && !data.tagName) {
    await run(db, [
      db.delete(hashtagRules).where(eq(hashtagRules.hashtag, data.hashtag)),
      audit(db, 'hashtag_rule', actor, 'hashtag_rule.remove', data.hashtag, {}, at),
    ]);
    return;
  }
  await run(db, [
    db
      .insert(hashtagRules)
      .values({
        hashtag: data.hashtag,
        categoryId: data.categoryId,
        tagName: data.tagName,
        createdAt: at,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: hashtagRules.hashtag,
        set: { categoryId: data.categoryId, tagName: data.tagName, updatedAt: at },
      }),
    audit(
      db,
      'hashtag_rule',
      actor,
      'hashtag_rule.set',
      data.hashtag,
      { categoryId: data.categoryId, tagName: data.tagName },
      at,
    ),
  ]);
}

export const APPLY_BATCH = 25;

/**
 * Applies every hashtag rule to imported drafts, a batch at a time (Worker
 * limits): adds the rules' categories and tags, never removes anything.
 * Call again with `nextCursor` until it is null.
 */
export async function applyHashtagRules(
  d1: D1Database,
  actor: string,
  cursor: string | null = null,
  now: Date = new Date(),
): Promise<{ processed: number; changed: number; nextCursor: string | null }> {
  const db = drizzle(d1);
  const rules = await db.select().from(hashtagRules);
  if (rules.length === 0) return { processed: 0, changed: 0, nextCursor: null };
  const byTag = new Map(rules.map((r) => [r.hashtag, r]));
  const batch = await db.all<{ id: string; suggested: string | null }>(sql`
    SELECT id, suggested_tags AS suggested FROM items
    WHERE import_key IS NOT NULL AND deleted_at IS NULL AND status = 'draft'
      ${cursor && ULID_PATTERN.test(cursor) ? sql`AND id > ${cursor}` : sql``}
    ORDER BY id LIMIT ${APPLY_BATCH}`);
  let changed = 0;
  for (const row of batch) {
    let words: string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.suggested ?? '[]');
      if (Array.isArray(parsed)) words = parsed.filter((w): w is string => typeof w === 'string');
    } catch {
      continue;
    }
    const matched = words.map((w) => byTag.get(w.toLowerCase())).filter((r) => r !== undefined);
    if (matched.length === 0) continue;
    const item = await getItem(d1, row.id);
    const cats = new Set(item.categoryIds);
    const tagNames = [...item.tagNames];
    let dirtyCats = false;
    let dirtyTags = false;
    for (const r of matched) {
      if (r.categoryId && !cats.has(r.categoryId)) {
        cats.add(r.categoryId);
        dirtyCats = true;
      }
      if (r.tagName && !tagNames.some((t) => t.toLowerCase() === r.tagName?.toLowerCase())) {
        tagNames.push(r.tagName);
        dirtyTags = true;
      }
    }
    if (dirtyCats) await setItemCategories(d1, row.id, [...cats], actor, now);
    if (dirtyTags) await setItemTags(d1, row.id, tagNames, actor, now);
    if (dirtyCats || dirtyTags) changed++;
  }
  const last = batch[batch.length - 1];
  return {
    processed: batch.length,
    changed,
    nextCursor: batch.length === APPLY_BATCH && last ? last.id : null,
  };
}

// ------------------------------------------------------------------ bulk actions

export const BULK_MAX = 50;

export const BulkAction = z
  .strictObject({
    ids: z.array(z.string().regex(ULID_PATTERN)).min(1).max(BULK_MAX),
    action: z.enum(['publish', 'trash', 'add-category']),
    categoryId: z.string().regex(ULID_PATTERN).optional(),
  })
  .refine((b) => b.action !== 'add-category' || b.categoryId !== undefined, {
    message: 'choose a category',
    path: ['categoryId'],
  });
export type BulkActionInput = z.input<typeof BulkAction>;

export interface BulkResult {
  id: string;
  ok: boolean;
  /** Why it didn't work (publish rules, not found). */
  reasons?: string[];
}

/** One action on several items; each succeeds or fails on its own. */
export async function bulkItems(
  d1: D1Database,
  input: BulkActionInput,
  actor: string,
  now: Date = new Date(),
): Promise<BulkResult[]> {
  const data = BulkAction.parse(input);
  if (data.action === 'add-category') {
    const db = drizzle(d1);
    const found = await db
      .select({ id: categories.id })
      .from(categories)
      .where(inArray(categories.id, [data.categoryId ?? '']));
    if (found.length === 0) throw new DomainError('invalid', { reason: 'unknown_category' });
  }
  const results: BulkResult[] = [];
  for (const id of [...new Set(data.ids)]) {
    try {
      if (data.action === 'publish') {
        await setItemStatus(d1, id, 'public', actor, now);
      } else if (data.action === 'trash') {
        await trashItem(d1, id, actor, now);
      } else {
        const item = await getItem(d1, id);
        if (!item.categoryIds.includes(data.categoryId ?? '')) {
          await setItemCategories(d1, id, [...item.categoryIds, data.categoryId ?? ''], actor, now);
        }
      }
      results.push({ id, ok: true });
    } catch (err) {
      if (err instanceof DomainError) {
        const reasons = err.details['reasons'];
        results.push({
          id,
          ok: false,
          reasons: Array.isArray(reasons) ? (reasons as string[]) : [err.code],
        });
      } else {
        throw err;
      }
    }
  }
  return results;
}

/** How many imported drafts wait for review (for the menu). */
export async function countReviewQueue(d1: D1Database): Promise<number> {
  const db = drizzle(d1);
  const row = await db.get<{ n: number }>(sql`SELECT count(*) AS n FROM items WHERE ${UNREVIEWED}`);
  return row?.n ?? 0;
}
