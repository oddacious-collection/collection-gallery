/**
 * Permanent deletion from the trash (ADM-04): automatically after 30 days,
 * or at once with "Delete permanently". Removes the database rows (cascading
 * to media, revisions, categories/tags links and collector records) and the
 * stored files in both buckets. Backups keep their copies per §9 (D-07).
 *
 * Order: database first, then storage. If deleting a file fails, the result is
 * an orphaned object (wasted bytes, reported in the log), never a database row
 * pointing at a file that no longer exists.
 */
import { and, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { documents, items, media, mediaVariants } from '../db/schema.ts';
import { logEvent } from '../errors.ts';
import { audit, run, type Db } from './db-util.ts';
import { DomainError } from './domain-error.ts';
import { uploadKeysForItems } from './media.ts';

export const TRASH_RETENTION_DAYS = 30;
export const PURGE_ACTOR = 'system:trash-purge';

export interface PurgeBuckets {
  MEDIA_PUBLIC: R2Bucket;
  MEDIA_PRIVATE: R2Bucket;
}

async function storageKeys(db: Db, itemIds: string[]) {
  if (itemIds.length === 0) return { publicKeys: [], privateKeys: [] };
  const [mediaRows, variantRows, docRows] = await db.batch([
    db
      .select({ originalKey: media.originalKey, captionsKey: media.captionsKey })
      .from(media)
      .where(inArray(media.itemId, itemIds)),
    db
      .select({ key: mediaVariants.key })
      .from(mediaVariants)
      .innerJoin(media, eq(media.id, mediaVariants.mediaId))
      .where(inArray(media.itemId, itemIds)),
    db.select({ key: documents.key }).from(documents).where(inArray(documents.itemId, itemIds)),
  ]);
  // Unfinished uploads go with the item too (their rows cascade).
  const pending = await uploadKeysForItems(db, itemIds);
  return {
    publicKeys: [...variantRows.map((v) => v.key), ...pending.publicKeys],
    privateKeys: [
      ...mediaRows.flatMap((m) => [m.originalKey, ...(m.captionsKey ? [m.captionsKey] : [])]),
      ...docRows.map((d) => d.key),
      ...pending.privateKeys,
    ],
  };
}

async function deleteObjects(bucket: R2Bucket, keys: string[], which: string): Promise<number> {
  let failed = 0;
  // R2 deletes up to 1000 keys per call.
  for (let i = 0; i < keys.length; i += 1000) {
    try {
      await bucket.delete(keys.slice(i, i + 1000));
    } catch {
      failed += Math.min(1000, keys.length - i);
    }
  }
  if (failed > 0) logEvent('error', 'purge_storage_failed', { bucket: which, failed });
  return failed;
}

async function purge(
  d1: D1Database,
  buckets: PurgeBuckets,
  itemIds: string[],
  actor: string,
  now: Date,
): Promise<number> {
  if (itemIds.length === 0) return 0;
  const db = drizzle(d1);
  const at = now.toISOString();
  const { publicKeys, privateKeys } = await storageKeys(db, itemIds);
  await run(db, [
    ...itemIds.map((id) => audit(db, 'item', actor, 'item.purge', id, {}, at)),
    db.delete(items).where(inArray(items.id, itemIds)),
  ]);
  await deleteObjects(buckets.MEDIA_PUBLIC, publicKeys, 'public');
  await deleteObjects(buckets.MEDIA_PRIVATE, privateKeys, 'private');
  return itemIds.length;
}

/** "Delete permanently" (ADM-04). Only items already in the trash can be purged. */
export async function purgeItemNow(
  d1: D1Database,
  buckets: PurgeBuckets,
  itemId: string,
  actor: string,
  now: Date = new Date(),
): Promise<void> {
  const db = drizzle(d1);
  const [row] = await db
    .select({ deletedAt: items.deletedAt })
    .from(items)
    .where(eq(items.id, itemId))
    .limit(1);
  if (!row) throw new DomainError('not_found');
  if (row.deletedAt === null) throw new DomainError('conflict', { reasons: ['not_in_trash'] });
  await purge(d1, buckets, [itemId], actor, now);
}

/** Scheduled job: purge items that have been in the trash longer than 30 days. */
export async function purgeExpiredTrash(
  d1: D1Database,
  buckets: PurgeBuckets,
  now: Date = new Date(),
): Promise<number> {
  const db = drizzle(d1);
  const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * 24 * 3600 * 1000).toISOString();
  let total = 0;
  for (;;) {
    const batch = await db
      .select({ id: items.id })
      .from(items)
      .where(and(isNotNull(items.deletedAt), lt(items.deletedAt, cutoff)))
      .limit(50);
    if (batch.length === 0) break;
    total += await purge(
      d1,
      buckets,
      batch.map((b) => b.id),
      PURGE_ACTOR,
      now,
    );
  }
  if (total > 0) logEvent('info', 'trash_purged', { items: total });
  return total;
}
