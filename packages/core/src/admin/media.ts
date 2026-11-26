/**
 * Admin data access for an item's photos (ADM-03, MED-03/04/05/07/13, D-46).
 *
 * Upload flow (the browser has already decoded, rotated, stripped and
 * re-encoded the photo, D-43):
 *
 *   1. beginUpload: the browser announces the master's size; the server
 *      plans the files (media/plan.ts), gives each a new random storage key
 *      (MED-13) and records the upload.
 *   2. storeUploadPart, once per file: the server checks the bytes against the
 *      plan (type, structure, no trailing data, no metadata, exact size, size
 *      limit; MED-03) BEFORE anything is stored, adds the creator/copyright
 *      tags to public files (MED-07), then writes it to R2. The master goes to
 *      the private bucket only (MED-04). Re-sending a file is safe.
 *   3. finalizeUpload: the server confirms every file is stored, then in one
 *      batch adds the media row and its variants, deletes the upload record,
 *      bumps the item, writes a revision snapshot and an audit entry.
 *
 * Unfinished uploads are cleaned up after 24 hours, with their files.
 * Removing a photo is soft (kept 30 days, restorable; INV-2).
 */
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { z } from 'zod';
import {
  auditLog,
  inboxPhotos,
  items,
  media,
  mediaUploadChunks,
  mediaUploads,
  mediaVariants,
} from '../db/schema.ts';
import { logEvent } from '../errors.ts';
import { RANDOM_KEY_PATTERN, ULID_PATTERN, randomKey, ulid } from '../ids.ts';
import {
  MAX_BYTES,
  Mp4Error,
  PlanError,
  VIDEO_MAX_DURATION_S,
  VIDEO_MAX_LONG_EDGE,
  VIDEO_MAX_SHORT_EDGE,
  verifyMp4Header,
  type Mp4Info,
  addJpegRights,
  addWebpRights,
  rightsFor,
  uploadPlan,
  verifyPart,
  type PlannedPart,
} from '../media/index.ts';
import { audit, run, type Db, type Op } from './db-util.ts';
import { DomainError } from './domain-error.ts';
import { createItem, itemMediaChange, setItemCategories } from './items.ts';

export interface MediaBuckets {
  MEDIA_PUBLIC: R2Bucket;
  MEDIA_PRIVATE: R2Bucket;
}

export const UPLOAD_TTL_HOURS = 24;
export const REMOVED_MEDIA_RETENTION_DAYS = 30;
export const MAX_PHOTOS_PER_ITEM = 100;
export const ALT_TEXT_MAX = 1000;
export const MEDIA_PURGE_ACTOR = 'system:media-purge';
/** The most photos the inbox holds at once (D-55). */
export const MAX_INBOX_PHOTOS = 500;
/** The largest single file the upload endpoint reads (the master's limit, MED-03). */
export const MAX_UPLOAD_PART_BYTES = MAX_BYTES.original;

const StoredPart = z.object({
  name: z.string(),
  /** Photos: original, image, og. Videos (D-60): original (the MP4 master), video, poster, og. */
  role: z.enum(['original', 'image', 'og', 'video', 'poster']),
  format: z.enum(['image/jpeg', 'image/webp', 'video/mp4']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  maxBytes: z.number().int().positive(),
  key: z.string().regex(RANDOM_KEY_PATTERN),
  // Video files only: uploaded in chunks into an R2 multipart upload.
  bytes: z.number().int().positive().optional(),
  chunkSize: z.number().int().positive().optional(),
  multipartId: z.string().min(1).optional(),
  durationS: z.number().positive().optional(),
  hasAudio: z.boolean().optional(),
});
type StoredPart = z.infer<typeof StoredPart>;
const StoredParts = z.array(StoredPart);

export const AltText = z.string().trim().max(ALT_TEXT_MAX);

function bucketFor(buckets: MediaBuckets, part: Pick<StoredPart, 'role'>): R2Bucket {
  return part.role === 'original' ? buckets.MEDIA_PRIVATE : buckets.MEDIA_PUBLIC;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Request bodies are plain ArrayBuffers (never shared memory).
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>),
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function activeMediaIds(db: Db, itemId: string): Promise<string[]> {
  const rows = await db
    .select({ id: media.id })
    .from(media)
    .where(and(eq(media.itemId, itemId), isNull(media.deletedAt)))
    .orderBy(asc(media.position), asc(media.id));
  return rows.map((r) => r.id);
}

/** Positions 0..n-1 in the given order; the first photo is the cover. */
function renumberOps(db: Db, ids: string[]): Op[] {
  return ids.map((id, i) =>
    db
      .update(media)
      .set({ position: i, isCover: i === 0 })
      .where(eq(media.id, id)),
  );
}

async function loadUpload(db: Db, uploadId: string, now: Date) {
  if (!RANDOM_KEY_PATTERN.test(uploadId)) throw new DomainError('not_found');
  const [row] = await db.select().from(mediaUploads).where(eq(mediaUploads.id, uploadId)).limit(1);
  if (!row) throw new DomainError('not_found');
  const age = now.getTime() - Date.parse(row.createdAt);
  if (age > UPLOAD_TTL_HOURS * 3600 * 1000)
    throw new DomainError('not_found', { reason: 'expired' });
  return { ...row, parts: StoredParts.parse(JSON.parse(row.parts)) };
}

async function getMediaRow(db: Db, mediaId: string) {
  if (!ULID_PATTERN.test(mediaId)) throw new DomainError('not_found');
  const [row] = await db.select().from(media).where(eq(media.id, mediaId)).limit(1);
  if (!row) throw new DomainError('not_found');
  return row;
}

// ------------------------------------------------------------------ upload

export interface BeganUpload {
  uploadId: string;
  parts: PlannedPart[];
}

/**
 * Starts an upload for an item, or (itemId = null) into the photo inbox
 * (D-55). The files and checks are the same either way.
 */
export async function beginUpload(
  d1: D1Database,
  itemId: string | null,
  size: { width: number; height: number },
  now: Date = new Date(),
): Promise<BeganUpload> {
  const db = drizzle(d1);
  if (itemId === null) {
    const [row] = await db
      .select({ n: count() })
      .from(inboxPhotos)
      .where(isNull(inboxPhotos.deletedAt));
    if ((row?.n ?? 0) >= MAX_INBOX_PHOTOS) {
      throw new DomainError('conflict', { reasons: ['inbox_full'] });
    }
  } else {
    const [item] = await db
      .select({ deletedAt: items.deletedAt })
      .from(items)
      .where(eq(items.id, itemId))
      .limit(1);
    if (!item) throw new DomainError('not_found');
    if (item.deletedAt !== null) throw new DomainError('conflict', { reasons: ['in_trash'] });
    if ((await activeMediaIds(db, itemId)).length >= MAX_PHOTOS_PER_ITEM) {
      throw new DomainError('conflict', { reasons: ['too_many_photos'] });
    }
  }
  let plan: PlannedPart[];
  try {
    plan = uploadPlan(size.width, size.height);
  } catch (err) {
    if (err instanceof PlanError)
      throw new DomainError('invalid', { reason: `photo_${err.reason}` });
    throw err;
  }
  const parts: StoredPart[] = plan.map((p) => ({ ...p, key: randomKey() }));
  const uploadId = randomKey();
  await db.insert(mediaUploads).values({
    id: uploadId,
    itemId,
    parts: JSON.stringify(parts),
    createdAt: now.toISOString(),
  });
  return { uploadId, parts: plan };
}

export async function storeUploadPart(
  d1: D1Database,
  buckets: MediaBuckets,
  uploadId: string,
  partName: string,
  bytes: Uint8Array,
  ownerName: string,
  now: Date = new Date(),
): Promise<{ name: string; bytes: number }> {
  const db = drizzle(d1);
  const upload = await loadUpload(db, uploadId, now);
  const part = upload.parts.find((p) => p.name === partName);
  if (!part) throw new DomainError('not_found');
  if (part.format === 'video/mp4') {
    throw new DomainError('invalid', { reason: 'video_sent_in_chunks', part: part.name });
  }

  // Poster images are checked exactly like photo files (role doesn't matter to the check).
  const check = verifyPart(bytes, {
    ...part,
    format: part.format,
    role: part.role === 'original' ? 'original' : part.role === 'og' ? 'og' : 'image',
  });
  if (!check.ok) {
    logEvent('warn', 'upload_rejected', { part: part.name, reason: check.reason });
    throw new DomainError('invalid', {
      reason: `file_${check.reason}`,
      part: part.name,
      ...(check.detail ? { detail: check.detail } : {}),
    });
  }

  let stored = bytes;
  const custom: Record<string, string> = { upload: uploadId, part: part.name };
  if (part.role === 'original') {
    custom['sha256'] = await sha256Hex(bytes);
  } else {
    const rights = rightsFor(ownerName, now.getUTCFullYear());
    stored =
      part.format === 'image/jpeg' ? addJpegRights(bytes, rights) : addWebpRights(bytes, rights);
  }
  await bucketFor(buckets, part).put(part.key, stored, {
    httpMetadata: {
      contentType: part.format,
      ...(part.role === 'original'
        ? { contentDisposition: 'attachment; filename="original.jpg"' }
        : {}),
    },
    customMetadata: custom,
  });
  return { name: part.name, bytes: stored.length };
}

/** Confirms every planned file of an upload is stored (by this upload). */
async function storedFiles(buckets: MediaBuckets, uploadId: string, parts: StoredPart[]) {
  const heads = await Promise.all(
    parts.map(async (p) => ({ part: p, head: await bucketFor(buckets, p).head(p.key) })),
  );
  const missing = heads
    .filter(({ head }) => !head || head.customMetadata?.['upload'] !== uploadId)
    .map(({ part }) => part.name);
  if (missing.length > 0) {
    throw new DomainError('conflict', { reasons: ['missing_files'], missing });
  }
  const original = heads.find((h) => h.part.role === 'original');
  if (!original?.head) throw new DomainError('conflict', { reasons: ['missing_files'] });
  return { heads, original: { part: original.part, head: original.head } };
}

/** Whether an upload is for an item or for the inbox (null: unknown or expired). */
export async function uploadTarget(
  d1: D1Database,
  uploadId: string,
  now: Date = new Date(),
): Promise<'item' | 'inbox'> {
  const upload = await loadUpload(drizzle(d1), uploadId, now);
  return upload.itemId === null ? 'inbox' : 'item';
}

export async function finalizeUpload(
  d1: D1Database,
  buckets: MediaBuckets,
  uploadId: string,
  altText: string,
  actor: string,
  now: Date = new Date(),
): Promise<{ mediaId: string }> {
  const db = drizzle(d1);
  const alt = AltText.parse(altText);
  const upload = await loadUpload(db, uploadId, now);
  if (upload.itemId === null) throw new DomainError('not_found', { reason: 'inbox_upload' });
  const itemId = upload.itemId;
  const at = now.toISOString();
  if (upload.parts.some((p) => p.format === 'video/mp4')) {
    return finalizeVideo(db, buckets, uploadId, itemId, upload.parts, alt, actor, at);
  }
  const change = await itemMediaChange(db, itemId, at);
  if (change.item.deletedAt !== null) throw new DomainError('conflict', { reasons: ['in_trash'] });

  const { heads, original } = await storedFiles(buckets, uploadId, upload.parts);
  const active = await activeMediaIds(db, itemId);
  const mediaId = ulid(now.getTime());

  await run(db, [
    db.insert(media).values({
      id: mediaId,
      itemId,
      position: active.length,
      isCover: active.length === 0,
      kind: 'image',
      originalKey: original.part.key,
      width: original.part.width,
      height: original.part.height,
      altText: alt,
      contentHash: original.head.customMetadata?.['sha256'] ?? null,
      createdAt: at,
    }),
    ...heads
      .filter(({ part }) => part.role !== 'original')
      .map(({ part, head }) =>
        db.insert(mediaVariants).values({
          key: part.key,
          mediaId,
          role: part.role === 'og' ? 'og' : 'image',
          width: part.width,
          height: part.height,
          format: part.format,
          bytes: head?.size ?? 0,
        }),
      ),
    db.delete(mediaUploads).where(eq(mediaUploads.id, uploadId)),
    ...renumberOps(db, [...active, mediaId]),
    ...change.ops([...active, mediaId]),
    audit(db, 'media', actor, 'media.add', mediaId, { itemId }, at),
  ]);
  return { mediaId };
}

// ------------------------------------------------------------------ reads

export interface MediaView {
  id: string;
  position: number;
  isCover: boolean;
  width: number;
  height: number;
  altText: string;
  /** Smallest public WebP (for thumbnails in admin). */
  thumbKey: string | null;
  /** Largest public WebP. */
  largeKey: string | null;
  createdAt: string;
  deletedAt: string | null;
}

export async function listItemMedia(
  d1: D1Database,
  itemId: string,
): Promise<{ active: MediaView[]; removed: MediaView[] }> {
  const db = drizzle(d1);
  const rows = await db
    .select()
    .from(media)
    .where(eq(media.itemId, itemId))
    .orderBy(asc(media.position), asc(media.id));
  const variants = rows.length
    ? await db
        .select({
          key: mediaVariants.key,
          mediaId: mediaVariants.mediaId,
          width: mediaVariants.width,
          height: mediaVariants.height,
        })
        .from(mediaVariants)
        .where(
          and(
            inArray(
              mediaVariants.mediaId,
              rows.map((r) => r.id),
            ),
            eq(mediaVariants.role, 'image'),
          ),
        )
    : [];
  const views = rows.map((r): MediaView => {
    const own = variants
      .filter((v) => v.mediaId === r.id)
      .sort((a, b) => Math.max(a.width, a.height) - Math.max(b.width, b.height));
    return {
      id: r.id,
      position: r.position,
      isCover: r.isCover,
      width: r.width,
      height: r.height,
      altText: r.altText,
      thumbKey: own[0]?.key ?? null,
      largeKey: own[own.length - 1]?.key ?? null,
      createdAt: r.createdAt,
      deletedAt: r.deletedAt,
    };
  });
  return {
    active: views.filter((v) => v.deletedAt === null),
    removed: views
      .filter((v) => v.deletedAt !== null)
      .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? '')),
  };
}

/** The cover thumbnail key of each item that has one (admin item list). */
export async function coverThumbKeys(
  d1: D1Database,
  itemIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (itemIds.length === 0) return out;
  const db = drizzle(d1);
  const rows = await db
    .select({
      itemId: media.itemId,
      key: mediaVariants.key,
      width: mediaVariants.width,
      height: mediaVariants.height,
    })
    .from(media)
    .innerJoin(mediaVariants, eq(mediaVariants.mediaId, media.id))
    .where(
      and(
        inArray(media.itemId, itemIds),
        eq(media.isCover, true),
        isNull(media.deletedAt),
        eq(mediaVariants.role, 'image'),
      ),
    );
  const best = new Map<string, number>();
  for (const r of rows) {
    const edge = Math.max(r.width, r.height);
    if (!best.has(r.itemId) || edge < (best.get(r.itemId) ?? Infinity)) {
      best.set(r.itemId, edge);
      out.set(r.itemId, r.key);
    }
  }
  return out;
}

/** A public variant, for the admin's own previews (any item status). */
export async function getVariantObject(
  d1: D1Database,
  buckets: MediaBuckets,
  key: string,
): Promise<R2ObjectBody | null> {
  if (!RANDOM_KEY_PATTERN.test(key)) return null;
  const db = drizzle(d1);
  const [row] = await db
    .select({ key: mediaVariants.key })
    .from(mediaVariants)
    .where(eq(mediaVariants.key, key))
    .limit(1);
  if (row) return buckets.MEDIA_PUBLIC.get(key);
  // Or a public-size file of an inbox photo (never its master).
  const inbox = await db.get<{ n: number }>(sql`
    SELECT count(*) AS n FROM inbox_photos, json_each(inbox_photos.parts) AS p
    WHERE json_extract(p.value, '$.key') = ${key}
      AND json_extract(p.value, '$.role') != 'original'`);
  return (inbox?.n ?? 0) > 0 ? buckets.MEDIA_PUBLIC.get(key) : null;
}

/** The private master, for download by the owner only (MED-04). */
export async function getOriginalObject(
  d1: D1Database,
  buckets: MediaBuckets,
  mediaId: string,
): Promise<R2ObjectBody | null> {
  if (!ULID_PATTERN.test(mediaId)) return null;
  const db = drizzle(d1);
  const [row] = await db
    .select({ key: media.originalKey })
    .from(media)
    .where(eq(media.id, mediaId))
    .limit(1);
  if (!row) return null;
  return buckets.MEDIA_PRIVATE.get(row.key);
}

// ------------------------------------------------------------------ edits

export async function setMediaAlt(
  d1: D1Database,
  mediaId: string,
  altText: string,
  actor: string,
  now: Date = new Date(),
): Promise<void> {
  const alt = AltText.parse(altText);
  const db = drizzle(d1);
  const row = await getMediaRow(db, mediaId);
  const at = now.toISOString();
  await run(db, [
    db.update(media).set({ altText: alt }).where(eq(media.id, mediaId)),
    db.update(items).set({ updatedAt: at }).where(eq(items.id, row.itemId)),
    audit(db, 'media', actor, 'media.alt', mediaId, { from: row.altText, to: alt }, at),
  ]);
}

/** New photo order for an item; the first is the cover. Must list every active photo once. */
export async function reorderMedia(
  d1: D1Database,
  itemId: string,
  order: string[],
  actor: string,
  now: Date = new Date(),
): Promise<void> {
  const ids = z.array(z.string().regex(ULID_PATTERN)).max(MAX_PHOTOS_PER_ITEM).parse(order);
  const db = drizzle(d1);
  const at = now.toISOString();
  const change = await itemMediaChange(db, itemId, at);
  const active = await activeMediaIds(db, itemId);
  if (
    ids.length !== active.length ||
    new Set(ids).size !== ids.length ||
    !ids.every((id) => active.includes(id))
  ) {
    throw new DomainError('invalid', { reason: 'order_mismatch' });
  }
  await run(db, [
    ...renumberOps(db, ids),
    ...change.ops(ids),
    audit(db, 'media', actor, 'media.reorder', itemId, { order: ids }, at),
  ]);
}

/** Remove a photo (soft, restorable for 30 days). A public item keeps at least one. */
export async function removeMedia(
  d1: D1Database,
  mediaId: string,
  actor: string,
  now: Date = new Date(),
): Promise<void> {
  const db = drizzle(d1);
  const row = await getMediaRow(db, mediaId);
  if (row.deletedAt !== null) return;
  const at = now.toISOString();
  const change = await itemMediaChange(db, row.itemId, at);
  const remaining = (await activeMediaIds(db, row.itemId)).filter((id) => id !== mediaId);
  if (change.item.status === 'public' && change.item.deletedAt === null && remaining.length === 0) {
    throw new DomainError('cannot_publish', { reasons: ['needs_media'] });
  }
  await run(db, [
    db.update(media).set({ deletedAt: at, isCover: false }).where(eq(media.id, mediaId)),
    ...renumberOps(db, remaining),
    ...change.ops(remaining),
    audit(db, 'media', actor, 'media.remove', mediaId, { itemId: row.itemId }, at),
  ]);
}

export async function restoreMedia(
  d1: D1Database,
  mediaId: string,
  actor: string,
  now: Date = new Date(),
): Promise<void> {
  const db = drizzle(d1);
  const row = await getMediaRow(db, mediaId);
  if (row.deletedAt === null) return;
  const at = now.toISOString();
  const change = await itemMediaChange(db, row.itemId, at);
  const order = [...(await activeMediaIds(db, row.itemId)), mediaId];
  await run(db, [
    db.update(media).set({ deletedAt: null }).where(eq(media.id, mediaId)),
    ...renumberOps(db, order),
    ...change.ops(order),
    audit(db, 'media', actor, 'media.restore', mediaId, { itemId: row.itemId }, at),
  ]);
}

// ------------------------------------------------------------------ cleanup (cron)

async function deleteKeys(bucket: R2Bucket, keys: string[], which: string): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    try {
      await bucket.delete(keys.slice(i, i + 1000));
    } catch {
      logEvent('error', 'media_storage_delete_failed', { bucket: which, count: keys.length });
    }
  }
}

/** Delete uploads never finalized within 24 hours, and their files. */
export async function cleanupStaleUploads(
  d1: D1Database,
  buckets: MediaBuckets,
  now: Date = new Date(),
): Promise<number> {
  const db = drizzle(d1);
  const cutoff = new Date(now.getTime() - UPLOAD_TTL_HOURS * 3600 * 1000).toISOString();
  const rows = await db
    .select()
    .from(mediaUploads)
    .where(lt(mediaUploads.createdAt, cutoff))
    .limit(200);
  if (rows.length === 0) return 0;
  const parts = rows.flatMap((r) => StoredParts.parse(JSON.parse(r.parts)));
  // Rows first: a crash in between leaves only unreferenced files, never a
  // record pointing at deleted files.
  await db.delete(mediaUploads).where(
    inArray(
      mediaUploads.id,
      rows.map((r) => r.id),
    ),
  );
  // Unfinished video files: drop their stored chunks (D-60).
  for (const p of parts) {
    if (!p.multipartId) continue;
    try {
      await bucketFor(buckets, p).resumeMultipartUpload(p.key, p.multipartId).abort();
    } catch {
      // Already completed or aborted: deleteKeys below removes a completed file.
    }
  }
  await deleteKeys(
    buckets.MEDIA_PRIVATE,
    parts.filter((p) => p.role === 'original').map((p) => p.key),
    'private',
  );
  await deleteKeys(
    buckets.MEDIA_PUBLIC,
    parts.filter((p) => p.role !== 'original').map((p) => p.key),
    'public',
  );
  logEvent('info', 'stale_uploads_removed', { uploads: rows.length });
  return rows.length;
}

/** Permanently delete photos removed more than 30 days ago (database, then storage). */
export async function purgeRemovedMedia(
  d1: D1Database,
  buckets: MediaBuckets,
  now: Date = new Date(),
): Promise<number> {
  const db = drizzle(d1);
  const cutoff = new Date(
    now.getTime() - REMOVED_MEDIA_RETENTION_DAYS * 24 * 3600 * 1000,
  ).toISOString();
  const rows = await db
    .select({
      id: media.id,
      itemId: media.itemId,
      originalKey: media.originalKey,
      captionsKey: media.captionsKey,
    })
    .from(media)
    .where(and(isNotNull(media.deletedAt), lt(media.deletedAt, cutoff)))
    .limit(200);
  if (rows.length === 0) return 0;
  const ids = rows.map((r) => r.id);
  const variantKeys = (
    await db
      .select({ key: mediaVariants.key })
      .from(mediaVariants)
      .where(inArray(mediaVariants.mediaId, ids))
  ).map((v) => v.key);
  const at = now.toISOString();
  await run(db, [
    ...rows.map((r) =>
      audit(db, 'media', MEDIA_PURGE_ACTOR, 'media.purge', r.id, { itemId: r.itemId }, at),
    ),
    db.delete(media).where(inArray(media.id, ids)),
  ]);
  await deleteKeys(buckets.MEDIA_PUBLIC, variantKeys, 'public');
  await deleteKeys(
    buckets.MEDIA_PRIVATE,
    rows.flatMap((r) => [r.originalKey, ...(r.captionsKey ? [r.captionsKey] : [])]),
    'private',
  );
  logEvent('info', 'removed_media_purged', { media: rows.length });
  return rows.length;
}

/** Storage keys of unfinished uploads for the given items (used by item purge). */
export async function uploadKeysForItems(
  db: Db,
  itemIds: string[],
): Promise<{ publicKeys: string[]; privateKeys: string[] }> {
  if (itemIds.length === 0) return { publicKeys: [], privateKeys: [] };
  const rows = await db
    .select({ parts: mediaUploads.parts })
    .from(mediaUploads)
    .where(inArray(mediaUploads.itemId, itemIds));
  const parts = rows.flatMap((r) => StoredParts.parse(JSON.parse(r.parts)));
  return {
    publicKeys: parts.filter((p) => p.role !== 'original').map((p) => p.key),
    privateKeys: parts.filter((p) => p.role === 'original').map((p) => p.key),
  };
}

// ------------------------------------------------------------------ photo inbox (D-55)
//
// Photos uploaded without an item wait in `inbox_photos` (admin-only; the
// public site never reads that table). Assigning moves them into `media` for
// an item, keeping their storage keys: nothing is copied or re-uploaded.

export const INBOX_RETENTION_DAYS = 30;
export const INBOX_PURGE_ACTOR = 'system:inbox-purge';
/** Photos per assignment: keeps one D1 batch well inside its limits. */
export const MAX_ASSIGN = 50;

const InboxPart = StoredPart.extend({ bytes: z.number().int().nonnegative() });
type InboxPart = z.infer<typeof InboxPart>;
const InboxParts = z.array(InboxPart);

export interface InboxPhotoView {
  id: string;
  width: number;
  height: number;
  thumbKey: string | null;
  largeKey: string | null;
  createdAt: string;
  deletedAt: string | null;
}

function inboxView(row: typeof inboxPhotos.$inferSelect): InboxPhotoView {
  const images = InboxParts.parse(JSON.parse(row.parts))
    .filter((p) => p.role === 'image')
    .sort((a, b) => Math.max(a.width, a.height) - Math.max(b.width, b.height));
  return {
    id: row.id,
    width: row.width,
    height: row.height,
    thumbKey: images[0]?.key ?? null,
    largeKey: images[images.length - 1]?.key ?? null,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}

/** Finalize an inbox upload: its stored files become one inbox photo. */
export async function finalizeInboxUpload(
  d1: D1Database,
  buckets: MediaBuckets,
  uploadId: string,
  actor: string,
  now: Date = new Date(),
): Promise<{ inboxId: string }> {
  const db = drizzle(d1);
  const upload = await loadUpload(db, uploadId, now);
  if (upload.itemId !== null) throw new DomainError('not_found', { reason: 'item_upload' });
  const { heads, original } = await storedFiles(buckets, uploadId, upload.parts);
  const parts: InboxPart[] = heads.map(({ part, head }) => ({ ...part, bytes: head?.size ?? 0 }));
  const at = now.toISOString();
  const id = ulid(now.getTime());
  await run(db, [
    db.insert(inboxPhotos).values({
      id,
      parts: JSON.stringify(parts),
      width: original.part.width,
      height: original.part.height,
      contentHash: original.head.customMetadata?.['sha256'] ?? null,
      createdAt: at,
    }),
    db.delete(mediaUploads).where(eq(mediaUploads.id, uploadId)),
    audit(db, 'media', actor, 'inbox.add', id, {}, at),
  ]);
  return { inboxId: id };
}

/** The inbox, oldest upload first (the order photos were taken), and what was removed. */
export async function listInbox(
  d1: D1Database,
): Promise<{ photos: InboxPhotoView[]; removed: InboxPhotoView[] }> {
  const db = drizzle(d1);
  const rows = await db
    .select()
    .from(inboxPhotos)
    .orderBy(asc(inboxPhotos.createdAt), asc(inboxPhotos.id));
  const views = rows.map(inboxView);
  return {
    photos: views.filter((v) => v.deletedAt === null),
    removed: views
      .filter((v) => v.deletedAt !== null)
      .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? '')),
  };
}

export const AssignInbox = z
  .strictObject({
    photoIds: z.array(z.string().regex(ULID_PATTERN)).min(1).max(MAX_ASSIGN),
    /** Add to this existing item... */
    itemId: z.string().regex(ULID_PATTERN).optional(),
    /** ...or create a new draft with this title (and optional category). */
    title: z.string().trim().min(1).max(200).optional(),
    categoryId: z.string().min(1).max(32).nullable().optional(),
  })
  .refine((x) => (x.itemId === undefined) !== (x.title === undefined), {
    message: 'Give either an item or a title for a new draft.',
  });

/**
 * Moves inbox photos onto an item, in the order given (the first of a new
 * draft becomes its cover). One batch: media rows and variants added, inbox
 * rows removed, positions renumbered, revision and audit entries written.
 * A new draft (with its category) is created first, in its own batches.
 */
export async function assignInboxPhotos(
  d1: D1Database,
  input: z.input<typeof AssignInbox>,
  actor: string,
  now: Date = new Date(),
): Promise<{ itemId: string; created: boolean }> {
  const data = AssignInbox.parse(input);
  const ids = [...new Set(data.photoIds)];
  const db = drizzle(d1);
  const rows = await db
    .select()
    .from(inboxPhotos)
    .where(and(inArray(inboxPhotos.id, ids), isNull(inboxPhotos.deletedAt)));
  if (rows.length !== ids.length) throw new DomainError('not_found', { reason: 'inbox_photo' });
  const byId = new Map(rows.map((r) => [r.id, r]));

  let itemId = data.itemId;
  let created = false;
  if (itemId === undefined) {
    itemId = (await createItem(d1, { title: data.title ?? '' }, actor, now)).id;
    created = true;
  }
  const at = now.toISOString();
  const change = await itemMediaChange(db, itemId, at);
  if (change.item.deletedAt !== null) throw new DomainError('conflict', { reasons: ['in_trash'] });
  const active = await activeMediaIds(db, itemId);
  if (active.length + ids.length > MAX_PHOTOS_PER_ITEM) {
    throw new DomainError('conflict', { reasons: ['too_many_photos'] });
  }

  const ops: Op[] = [];
  const newIds: string[] = [];
  for (const inboxId of ids) {
    const row = byId.get(inboxId);
    if (!row) continue;
    const parts = InboxParts.parse(JSON.parse(row.parts));
    const original = parts.find((p) => p.role === 'original');
    if (!original) throw new DomainError('conflict', { reasons: ['missing_files'] });
    const mediaId = ulid(now.getTime());
    newIds.push(mediaId);
    ops.push(
      db.insert(media).values({
        id: mediaId,
        itemId,
        position: active.length + newIds.length - 1,
        isCover: false,
        kind: 'image',
        originalKey: original.key,
        width: row.width,
        height: row.height,
        altText: '',
        contentHash: row.contentHash,
        createdAt: at,
      }),
      ...parts
        .filter((p) => p.role !== 'original')
        .map((p) =>
          db.insert(mediaVariants).values({
            key: p.key,
            mediaId,
            role: p.role === 'og' ? 'og' : 'image',
            width: p.width,
            height: p.height,
            format: p.format,
            bytes: p.bytes,
          }),
        ),
      db.delete(inboxPhotos).where(eq(inboxPhotos.id, inboxId)),
      audit(db, 'media', actor, 'media.add', mediaId, { itemId, from: 'inbox', inboxId }, at),
    );
  }
  const order = [...active, ...newIds];
  await run(db, [...ops, ...renumberOps(db, order), ...change.ops(order)]);

  if (created && data.categoryId) {
    await setItemCategories(d1, itemId, [data.categoryId], actor, now);
  }
  return { itemId, created };
}

const InboxIds = z.array(z.string().regex(ULID_PATTERN)).min(1).max(MAX_INBOX_PHOTOS);

/** Remove inbox photos (soft: restorable for 30 days). */
export async function removeInboxPhotos(
  d1: D1Database,
  photoIds: string[],
  actor: string,
  now: Date = new Date(),
): Promise<number> {
  const ids = [...new Set(InboxIds.parse(photoIds))];
  const db = drizzle(d1);
  const at = now.toISOString();
  const live = await db
    .select({ id: inboxPhotos.id })
    .from(inboxPhotos)
    .where(and(inArray(inboxPhotos.id, ids), isNull(inboxPhotos.deletedAt)));
  if (live.length === 0) return 0;
  await run(db, [
    db
      .update(inboxPhotos)
      .set({ deletedAt: at })
      .where(
        inArray(
          inboxPhotos.id,
          live.map((r) => r.id),
        ),
      ),
    ...live.map((r) => audit(db, 'media', actor, 'inbox.remove', r.id, {}, at)),
  ]);
  return live.length;
}

export async function restoreInboxPhotos(
  d1: D1Database,
  photoIds: string[],
  actor: string,
  now: Date = new Date(),
): Promise<number> {
  const ids = [...new Set(InboxIds.parse(photoIds))];
  const db = drizzle(d1);
  const at = now.toISOString();
  const gone = await db
    .select({ id: inboxPhotos.id })
    .from(inboxPhotos)
    .where(and(inArray(inboxPhotos.id, ids), isNotNull(inboxPhotos.deletedAt)));
  if (gone.length === 0) return 0;
  await run(db, [
    db
      .update(inboxPhotos)
      .set({ deletedAt: null })
      .where(
        inArray(
          inboxPhotos.id,
          gone.map((r) => r.id),
        ),
      ),
    ...gone.map((r) => audit(db, 'media', actor, 'inbox.restore', r.id, {}, at)),
  ]);
  return gone.length;
}

/** Cron: permanently delete inbox photos removed more than 30 days ago (rows, then files). */
export async function purgeRemovedInbox(
  d1: D1Database,
  buckets: MediaBuckets,
  now: Date = new Date(),
): Promise<number> {
  const db = drizzle(d1);
  const cutoff = new Date(now.getTime() - INBOX_RETENTION_DAYS * 24 * 3600 * 1000).toISOString();
  const rows = await db
    .select()
    .from(inboxPhotos)
    .where(and(isNotNull(inboxPhotos.deletedAt), lt(inboxPhotos.deletedAt, cutoff)))
    .limit(200);
  if (rows.length === 0) return 0;
  const parts = rows.flatMap((r) => InboxParts.parse(JSON.parse(r.parts)));
  const at = now.toISOString();
  await run(db, [
    ...rows.map((r) => audit(db, 'media', INBOX_PURGE_ACTOR, 'inbox.purge', r.id, {}, at)),
    db.delete(inboxPhotos).where(
      inArray(
        inboxPhotos.id,
        rows.map((r) => r.id),
      ),
    ),
  ]);
  await deleteKeys(
    buckets.MEDIA_PRIVATE,
    parts.filter((p) => p.role === 'original').map((p) => p.key),
    'private',
  );
  await deleteKeys(
    buckets.MEDIA_PUBLIC,
    parts.filter((p) => p.role !== 'original').map((p) => p.key),
    'public',
  );
  logEvent('info', 'inbox_purged', { photos: rows.length });
  return rows.length;
}

export interface InboxAssignment {
  itemId: string;
  title: string;
  photos: number;
  at: string;
  coverKey: string | null;
}

/** "Recently used": the latest items that received photos from the inbox. */
export async function recentInboxAssignments(
  d1: D1Database,
  limit = 8,
): Promise<InboxAssignment[]> {
  const db = drizzle(d1);
  const events = await db
    .select({ at: auditLog.at, details: auditLog.details })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, 'media.add'),
        sql`json_extract(${auditLog.details}, '$.from') = 'inbox'`,
      ),
    )
    .orderBy(desc(auditLog.at))
    .limit(200);
  const byItem = new Map<string, { at: string; photos: number }>();
  for (const e of events) {
    const itemId = (JSON.parse(e.details) as { itemId?: string }).itemId;
    if (!itemId) continue;
    const seen = byItem.get(itemId);
    if (seen) seen.photos++;
    else if (byItem.size < limit) byItem.set(itemId, { at: e.at, photos: 1 });
  }
  const itemIds = [...byItem.keys()];
  if (itemIds.length === 0) return [];
  const [rows, covers] = await Promise.all([
    db
      .select({ id: items.id, title: items.title })
      .from(items)
      .where(and(inArray(items.id, itemIds), isNull(items.deletedAt))),
    coverThumbKeys(d1, itemIds),
  ]);
  const title = new Map(rows.map((r) => [r.id, r.title]));
  return itemIds
    .filter((id) => title.has(id))
    .map((id) => ({
      itemId: id,
      title: title.get(id) ?? '',
      photos: byItem.get(id)?.photos ?? 0,
      at: byItem.get(id)?.at ?? '',
      coverKey: covers.get(id) ?? null,
    }));
}

/** Photos waiting in the inbox (for the admin nav badge). */
export async function countInbox(d1: D1Database): Promise<number> {
  const [row] = await drizzle(d1)
    .select({ n: count() })
    .from(inboxPhotos)
    .where(isNull(inboxPhotos.deletedAt));
  return row?.n ?? 0;
}

// ------------------------------------------------------------------ video (D-60)
//
// A video upload has two MP4 files, made on the device: the private master
// (higher bitrate, for M5's watermarking) and the public file, plus a poster
// frame planned like a photo (public WebP sizes + og JPEG; no private copy,
// the poster can be made again from the master). The MP4s don't fit a
// Worker's memory, so each goes up in chunks into an R2 multipart upload.
// Chunk 0 holds the header (`moov` first); it is checked completely before
// it is stored, and that check proves the media data that follows can only
// be the samples the header describes (media/mp4.ts).

/** Chunk size for video files: every chunk but the last is exactly this long. */
export const VIDEO_CHUNK_BYTES = 8 * 1024 * 1024;
/** MED-03: the largest stored video file. */
export const VIDEO_MAX_BYTES = 100 * 1024 * 1024;
/** Declared and measured durations may differ by this much (container rounding). */
const DURATION_TOLERANCE_S = 1;

export const VideoBegin = z.strictObject({
  width: z.number().int().positive().max(VIDEO_MAX_LONG_EDGE),
  height: z.number().int().positive().max(VIDEO_MAX_LONG_EDGE),
  durationS: z.number().positive().max(VIDEO_MAX_DURATION_S),
  hasAudio: z.boolean(),
  masterBytes: z.number().int().positive().max(VIDEO_MAX_BYTES),
  videoBytes: z.number().int().positive().max(VIDEO_MAX_BYTES),
});
export type VideoBegin = z.infer<typeof VideoBegin>;

/** What the browser needs to send each file (no storage keys). */
export type VideoUploadPart = Omit<StoredPart, 'key' | 'multipartId'> & { chunks?: number };

function chunkCount(part: Pick<StoredPart, 'bytes' | 'chunkSize'>): number {
  return Math.ceil((part.bytes ?? 0) / (part.chunkSize ?? VIDEO_CHUNK_BYTES));
}

export async function beginVideoUpload(
  d1: D1Database,
  buckets: MediaBuckets,
  itemId: string,
  input: VideoBegin,
  now: Date = new Date(),
): Promise<{ uploadId: string; parts: VideoUploadPart[] }> {
  const db = drizzle(d1);
  const v = VideoBegin.parse(input);
  if (
    Math.max(v.width, v.height) > VIDEO_MAX_LONG_EDGE ||
    Math.min(v.width, v.height) > VIDEO_MAX_SHORT_EDGE
  ) {
    throw new DomainError('invalid', { reason: 'video_too_large_picture' });
  }
  const [item] = await db
    .select({ deletedAt: items.deletedAt })
    .from(items)
    .where(eq(items.id, itemId))
    .limit(1);
  if (!item) throw new DomainError('not_found');
  if (item.deletedAt !== null) throw new DomainError('conflict', { reasons: ['in_trash'] });
  if ((await activeMediaIds(db, itemId)).length >= MAX_PHOTOS_PER_ITEM) {
    throw new DomainError('conflict', { reasons: ['too_many_photos'] });
  }
  let poster: PlannedPart[];
  try {
    poster = uploadPlan(v.width, v.height).filter((p) => p.role !== 'original');
  } catch (err) {
    if (err instanceof PlanError) {
      throw new DomainError('invalid', { reason: `poster_${err.reason}` });
    }
    throw err;
  }

  const uploadId = randomKey();
  const videoFile = (name: 'original' | 'video', bytes: number): StoredPart => ({
    name,
    role: name,
    format: 'video/mp4',
    width: v.width,
    height: v.height,
    maxBytes: VIDEO_MAX_BYTES,
    key: randomKey(),
    bytes,
    chunkSize: VIDEO_CHUNK_BYTES,
    durationS: v.durationS,
    hasAudio: v.hasAudio,
  });
  const files = [videoFile('original', v.masterBytes), videoFile('video', v.videoBytes)];
  for (const f of files) {
    const mpu = await bucketFor(buckets, f).createMultipartUpload(f.key, {
      httpMetadata: {
        contentType: 'video/mp4',
        ...(f.role === 'original'
          ? { contentDisposition: 'attachment; filename="original.mp4"' }
          : {}),
      },
      customMetadata: { upload: uploadId, part: f.name },
    });
    f.multipartId = mpu.uploadId;
  }
  const parts: StoredPart[] = [
    ...files,
    ...poster.map((p): StoredPart => ({
      ...p,
      role: p.role === 'og' ? 'og' : 'poster',
      name: p.role === 'og' ? 'og' : `poster-${p.name}`,
      key: randomKey(),
    })),
  ];
  await db.insert(mediaUploads).values({
    id: uploadId,
    itemId,
    parts: JSON.stringify(parts),
    createdAt: now.toISOString(),
  });
  return {
    uploadId,
    parts: parts.map(({ key: _key, multipartId: _mpu, ...p }) =>
      p.format === 'video/mp4' ? { ...p, chunks: chunkCount(p) } : p,
    ),
  };
}

/** Stores chunk `n` (0-based) of a video file; chunk 0 must pass the MP4 header check. */
export async function storeVideoChunk(
  d1: D1Database,
  buckets: MediaBuckets,
  uploadId: string,
  partName: string,
  n: number,
  bytes: Uint8Array,
  now: Date = new Date(),
): Promise<{ name: string; chunk: number; bytes: number }> {
  const db = drizzle(d1);
  const upload = await loadUpload(db, uploadId, now);
  const part = upload.parts.find((p) => p.name === partName);
  if (!part || part.format !== 'video/mp4' || !part.multipartId || !part.bytes) {
    throw new DomainError('not_found');
  }
  const chunks = chunkCount(part);
  const size = part.chunkSize ?? VIDEO_CHUNK_BYTES;
  if (!Number.isInteger(n) || n < 0 || n >= chunks) throw new DomainError('not_found');
  const expected = n < chunks - 1 ? size : part.bytes - size * (chunks - 1);
  if (bytes.length !== expected) {
    throw new DomainError('invalid', { reason: 'chunk_wrong_size', part: part.name, chunk: n });
  }

  if (n === 0) {
    let info: Mp4Info;
    try {
      info = verifyMp4Header(bytes, part.bytes);
    } catch (err) {
      if (!(err instanceof Mp4Error)) throw err;
      logEvent('warn', 'upload_rejected', { part: part.name, reason: err.reason });
      throw new DomainError('invalid', {
        reason: `video_${err.reason}`,
        part: part.name,
        ...(err.detail ? { detail: err.detail } : {}),
      });
    }
    const mismatch =
      info.width !== part.width ||
      info.height !== part.height ||
      info.hasAudio !== part.hasAudio ||
      Math.abs(info.durationS - (part.durationS ?? 0)) > DURATION_TOLERANCE_S;
    if (mismatch) {
      logEvent('warn', 'upload_rejected', { part: part.name, reason: 'video_not_as_declared' });
      throw new DomainError('invalid', { reason: 'video_not_as_declared', part: part.name });
    }
  }

  const mpu = bucketFor(buckets, part).resumeMultipartUpload(part.key, part.multipartId);
  const stored = await mpu.uploadPart(n + 1, bytes);
  await db
    .insert(mediaUploadChunks)
    .values({ uploadId, part: part.name, n, etag: stored.etag, bytes: bytes.length })
    .onConflictDoUpdate({
      target: [mediaUploadChunks.uploadId, mediaUploadChunks.part, mediaUploadChunks.n],
      set: { etag: stored.etag, bytes: bytes.length },
    });
  return { name: part.name, chunk: n, bytes: bytes.length };
}

/** Completes each video file (unless an earlier finalize already did). */
async function completeVideoFiles(
  db: Db,
  buckets: MediaBuckets,
  uploadId: string,
  parts: StoredPart[],
): Promise<void> {
  for (const part of parts) {
    if (part.format !== 'video/mp4' || !part.multipartId) continue;
    const bucket = bucketFor(buckets, part);
    const head = await bucket.head(part.key);
    if (head && head.customMetadata?.['upload'] === uploadId && head.size === part.bytes) continue;
    const rows = await db
      .select()
      .from(mediaUploadChunks)
      .where(and(eq(mediaUploadChunks.uploadId, uploadId), eq(mediaUploadChunks.part, part.name)))
      .orderBy(asc(mediaUploadChunks.n));
    if (rows.length !== chunkCount(part) || rows.some((r, i) => r.n !== i)) {
      throw new DomainError('conflict', { reasons: ['missing_files'], missing: [part.name] });
    }
    await bucket
      .resumeMultipartUpload(part.key, part.multipartId)
      .complete(rows.map((r) => ({ partNumber: r.n + 1, etag: r.etag })));
  }
}

async function finalizeVideo(
  db: Db,
  buckets: MediaBuckets,
  uploadId: string,
  itemId: string,
  parts: StoredPart[],
  alt: string,
  actor: string,
  at: string,
): Promise<{ mediaId: string }> {
  const change = await itemMediaChange(db, itemId, at);
  if (change.item.deletedAt !== null) throw new DomainError('conflict', { reasons: ['in_trash'] });
  await completeVideoFiles(db, buckets, uploadId, parts);
  const { heads, original } = await storedFiles(buckets, uploadId, parts);
  for (const { part, head } of heads) {
    if (part.format === 'video/mp4' && head?.size !== part.bytes) {
      throw new DomainError('conflict', { reasons: ['missing_files'], missing: [part.name] });
    }
  }
  const active = await activeMediaIds(db, itemId);
  const mediaId = ulid(Date.parse(at));
  const master = original.part;
  await run(db, [
    db.insert(media).values({
      id: mediaId,
      itemId,
      position: active.length,
      isCover: active.length === 0,
      kind: 'video',
      originalKey: master.key,
      width: master.width,
      height: master.height,
      durationS: master.durationS ?? null,
      hasAudio: master.hasAudio ?? false,
      altText: alt,
      contentHash: null,
      createdAt: at,
    }),
    ...heads
      .filter(({ part }) => part.role !== 'original')
      .map(({ part, head }) =>
        db.insert(mediaVariants).values({
          key: part.key,
          mediaId,
          role: part.role === 'video' ? 'video' : part.role === 'og' ? 'og' : 'poster',
          width: part.width,
          height: part.height,
          format: part.format,
          bytes: head?.size ?? 0,
        }),
      ),
    db.delete(mediaUploads).where(eq(mediaUploads.id, uploadId)),
    ...renumberOps(db, [...active, mediaId]),
    ...change.ops([...active, mediaId]),
    audit(db, 'media', actor, 'media.add', mediaId, { itemId, kind: 'video' }, at),
  ]);
  return { mediaId };
}
