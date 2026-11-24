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
import { and, asc, eq, inArray, isNotNull, isNull, lt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { z } from 'zod';
import { items, media, mediaUploads, mediaVariants } from '../db/schema.ts';
import { logEvent } from '../errors.ts';
import { RANDOM_KEY_PATTERN, ULID_PATTERN, randomKey, ulid } from '../ids.ts';
import {
  MAX_BYTES,
  PlanError,
  addJpegRights,
  addWebpRights,
  rightsFor,
  uploadPlan,
  verifyPart,
  type PlannedPart,
} from '../media/index.ts';
import { audit, run, type Db, type Op } from './db-util.ts';
import { DomainError } from './domain-error.ts';
import { itemMediaChange } from './items.ts';

export interface MediaBuckets {
  MEDIA_PUBLIC: R2Bucket;
  MEDIA_PRIVATE: R2Bucket;
}

export const UPLOAD_TTL_HOURS = 24;
export const REMOVED_MEDIA_RETENTION_DAYS = 30;
export const MAX_PHOTOS_PER_ITEM = 100;
export const ALT_TEXT_MAX = 1000;
export const MEDIA_PURGE_ACTOR = 'system:media-purge';
/** The largest single file the upload endpoint reads (the master's limit, MED-03). */
export const MAX_UPLOAD_PART_BYTES = MAX_BYTES.original;

const StoredPart = z.object({
  name: z.string(),
  role: z.enum(['original', 'image', 'og']),
  format: z.enum(['image/jpeg', 'image/webp']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  maxBytes: z.number().int().positive(),
  key: z.string().regex(RANDOM_KEY_PATTERN),
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

export async function beginUpload(
  d1: D1Database,
  itemId: string,
  size: { width: number; height: number },
  now: Date = new Date(),
): Promise<BeganUpload> {
  const db = drizzle(d1);
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

  const check = verifyPart(bytes, part);
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
  const at = now.toISOString();
  const change = await itemMediaChange(db, upload.itemId, at);
  if (change.item.deletedAt !== null) throw new DomainError('conflict', { reasons: ['in_trash'] });

  const heads = await Promise.all(
    upload.parts.map(async (p) => ({ part: p, head: await bucketFor(buckets, p).head(p.key) })),
  );
  const missing = heads
    .filter(({ head }) => !head || head.customMetadata?.['upload'] !== uploadId)
    .map(({ part }) => part.name);
  if (missing.length > 0)
    throw new DomainError('conflict', { reasons: ['missing_files'], missing });

  const original = heads.find((h) => h.part.role === 'original');
  if (!original?.head) throw new DomainError('conflict', { reasons: ['missing_files'] });
  const active = await activeMediaIds(db, upload.itemId);
  const mediaId = ulid(now.getTime());

  await run(db, [
    db.insert(media).values({
      id: mediaId,
      itemId: upload.itemId,
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
    audit(db, 'media', actor, 'media.add', mediaId, { itemId: upload.itemId }, at),
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
  if (!row) return null;
  return buckets.MEDIA_PUBLIC.get(key);
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
