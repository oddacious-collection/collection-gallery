/**
 * Captions for a video (MED-12, D-65). One caption file per video:
 *
 * - the file **as uploaded** is kept in media-private (`media.captions_key`),
 *   so nothing the owner wrote is lost and they can download it again;
 * - the **rebuilt** public WebVTT (media/vtt.ts: no comments, styles or
 *   unknown tags) is a `captions` variant in media-public, served like every
 *   other public file: only while the item is publicly visible (MED-10).
 *
 * Replacing or removing captions deletes the old files once the database
 * points at the new state. Earlier versions of the private file stay in the
 * off-site backup for 365 days (BAK-03).
 */
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { items, media, mediaVariants } from '../db/schema.ts';
import { logEvent } from '../errors.ts';
import { ULID_PATTERN, randomKey } from '../ids.ts';
import { CaptionsError, parseCaptions } from '../media/vtt.ts';
import { audit, run, type Db } from './db-util.ts';
import { DomainError } from './domain-error.ts';
import type { MediaBuckets } from './media.ts';

export { CAPTIONS_MAX_BYTES } from '../media/vtt.ts';

async function videoRow(db: Db, mediaId: string) {
  if (!ULID_PATTERN.test(mediaId)) throw new DomainError('not_found');
  const [row] = await db
    .select({
      id: media.id,
      itemId: media.itemId,
      kind: media.kind,
      durationS: media.durationS,
      captionsKey: media.captionsKey,
      deletedAt: media.deletedAt,
    })
    .from(media)
    .where(eq(media.id, mediaId))
    .limit(1);
  if (!row) throw new DomainError('not_found');
  if (row.kind !== 'video') throw new DomainError('invalid', { reason: 'not_a_video' });
  if (row.deletedAt !== null) throw new DomainError('conflict', { reasons: ['media_removed'] });
  return row;
}

async function captionVariantKeys(db: Db, mediaId: string): Promise<string[]> {
  const rows = await db
    .select({ key: mediaVariants.key })
    .from(mediaVariants)
    .where(and(eq(mediaVariants.mediaId, mediaId), eq(mediaVariants.role, 'captions')));
  return rows.map((r) => r.key);
}

async function deleteQuietly(bucket: R2Bucket, keys: string[], which: string): Promise<void> {
  if (keys.length === 0) return;
  try {
    await bucket.delete(keys);
  } catch {
    logEvent('error', 'captions_storage_delete_failed', { bucket: which, count: keys.length });
  }
}

/** Adds or replaces a video's captions. Returns the number of captions published. */
export async function setVideoCaptions(
  d1: D1Database,
  buckets: MediaBuckets,
  mediaId: string,
  bytes: Uint8Array,
  actor: string,
  now: Date = new Date(),
): Promise<{ cues: number }> {
  const db = drizzle(d1);
  const row = await videoRow(db, mediaId);
  let vtt: string;
  let cues: number;
  try {
    ({ vtt, cues } = parseCaptions(bytes, row.durationS ?? 0));
  } catch (err) {
    if (err instanceof CaptionsError) {
      throw new DomainError('invalid', {
        reason: `captions_${err.reason}`,
        ...(err.cue === null ? {} : { block: err.cue }),
      });
    }
    throw err;
  }
  const publicBytes = new TextEncoder().encode(vtt);
  const privateKey = randomKey();
  const publicKey = randomKey();
  await buckets.MEDIA_PRIVATE.put(privateKey, bytes, {
    httpMetadata: { contentType: 'text/plain; charset=utf-8' },
  });
  await buckets.MEDIA_PUBLIC.put(publicKey, publicBytes, {
    httpMetadata: { contentType: 'text/vtt; charset=utf-8' },
  });
  const oldPublic = await captionVariantKeys(db, mediaId);
  const at = now.toISOString();
  try {
    await run(db, [
      db
        .delete(mediaVariants)
        .where(and(eq(mediaVariants.mediaId, mediaId), eq(mediaVariants.role, 'captions'))),
      db.insert(mediaVariants).values({
        key: publicKey,
        mediaId,
        role: 'captions',
        width: 0,
        height: 0,
        format: 'text/vtt',
        bytes: publicBytes.length,
      }),
      db.update(media).set({ captionsKey: privateKey }).where(eq(media.id, mediaId)),
      db.update(items).set({ updatedAt: at }).where(eq(items.id, row.itemId)),
      audit(
        db,
        'media',
        actor,
        row.captionsKey ? 'media.captions_replace' : 'media.captions_add',
        mediaId,
        { itemId: row.itemId, cues },
        at,
      ),
    ]);
  } catch (err) {
    await deleteQuietly(buckets.MEDIA_PRIVATE, [privateKey], 'private');
    await deleteQuietly(buckets.MEDIA_PUBLIC, [publicKey], 'public');
    throw err;
  }
  await deleteQuietly(buckets.MEDIA_PUBLIC, oldPublic, 'public');
  if (row.captionsKey) await deleteQuietly(buckets.MEDIA_PRIVATE, [row.captionsKey], 'private');
  return { cues };
}

/** Removes a video's captions (the public file at once; see the module note on backups). */
export async function removeVideoCaptions(
  d1: D1Database,
  buckets: MediaBuckets,
  mediaId: string,
  actor: string,
  now: Date = new Date(),
): Promise<void> {
  const db = drizzle(d1);
  const row = await videoRow(db, mediaId);
  const oldPublic = await captionVariantKeys(db, mediaId);
  if (!row.captionsKey && oldPublic.length === 0) return;
  const at = now.toISOString();
  await run(db, [
    db
      .delete(mediaVariants)
      .where(and(eq(mediaVariants.mediaId, mediaId), eq(mediaVariants.role, 'captions'))),
    db.update(media).set({ captionsKey: null }).where(eq(media.id, mediaId)),
    db.update(items).set({ updatedAt: at }).where(eq(items.id, row.itemId)),
    audit(db, 'media', actor, 'media.captions_remove', mediaId, { itemId: row.itemId }, at),
  ]);
  await deleteQuietly(buckets.MEDIA_PUBLIC, oldPublic, 'public');
  if (row.captionsKey) await deleteQuietly(buckets.MEDIA_PRIVATE, [row.captionsKey], 'private');
}

/** The caption file as uploaded, for the owner to download. */
export async function getCaptionsSource(
  d1: D1Database,
  buckets: MediaBuckets,
  mediaId: string,
): Promise<R2ObjectBody | null> {
  if (!ULID_PATTERN.test(mediaId)) return null;
  const db = drizzle(d1);
  const [row] = await db
    .select({ key: media.captionsKey })
    .from(media)
    .where(eq(media.id, mediaId))
    .limit(1);
  if (!row?.key) return null;
  return buckets.MEDIA_PRIVATE.get(row.key);
}
