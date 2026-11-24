/**
 * Photo uploads and photo edits (ADM-03, MED-03/04/05/07/13, D-46, TST-05).
 * Runs inside workerd with real D1 and R2 bindings.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { DomainError } from '../src/admin/domain-error.ts';
import {
  createItem,
  listRevisions,
  publishBlockers,
  setItemCategories,
  setItemStatus,
  trashItem,
} from '../src/admin/items.ts';
import {
  beginUpload,
  cleanupStaleUploads,
  coverThumbKeys,
  finalizeUpload,
  getOriginalObject,
  getVariantObject,
  listItemMedia,
  purgeRemovedMedia,
  removeMedia,
  reorderMedia,
  restoreMedia,
  setMediaAlt,
  storeUploadPart,
} from '../src/admin/media.ts';
import { purgeItemNow } from '../src/admin/purge.ts';
import {
  hasOnlyRightsMetadata,
  parseJpeg,
  webpHasOnlyRightsMetadata,
  type PlannedPart,
} from '../src/media/index.ts';
import { ACTOR, count, insertCategory } from './db-helpers.ts';
import {
  HTML_TAIL,
  SENTINEL,
  SVG,
  bytesContain,
  cameraExifSegment,
  makeJpeg,
  makeWebp,
} from './image-fixtures.ts';

const OWNER = 'Insignificant Nobody';
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function fileFor(part: PlannedPart): Uint8Array {
  return part.format === 'image/jpeg'
    ? makeJpeg({ width: part.width, height: part.height })
    : makeWebp({ width: part.width, height: part.height });
}

async function storeAll(uploadId: string, parts: PlannedPart[], now?: Date) {
  for (const p of parts)
    await storeUploadPart(env.DB, env, uploadId, p.name, fileFor(p), OWNER, now);
}

async function invalidReason(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    if (err instanceof DomainError) return { code: err.code, ...err.details };
    throw err;
  }
  return 'no error';
}

/** A full upload of one photo; returns its media id. */
async function addPhoto(
  itemId: string,
  width = 4032,
  height = 3024,
  now = new Date(),
): Promise<string> {
  const { uploadId, parts } = await beginUpload(env.DB, itemId, { width, height }, now);
  await storeAll(uploadId, parts, now);
  return (await finalizeUpload(env.DB, env, uploadId, '', ACTOR, now)).mediaId;
}

async function uploadKeys(
  uploadId: string,
): Promise<Array<{ name: string; role: string; key: string }>> {
  const row = await env.DB.prepare('SELECT parts FROM media_uploads WHERE id = ?')
    .bind(uploadId)
    .first<{ parts: string }>();
  return JSON.parse(row?.parts ?? '[]') as Array<{ name: string; role: string; key: string }>;
}

describe('a full upload', () => {
  it('stores the master privately and the public files with rights metadata, then attaches them', async () => {
    const item = await createItem(env.DB, { title: 'Seymchan slice' }, ACTOR);
    const { uploadId, parts } = await beginUpload(env.DB, item.id, { width: 4032, height: 3024 });
    expect(parts.map((p) => p.name)).toEqual([
      'original',
      'w400',
      'w800',
      'w1200',
      'w1600',
      'w2048',
      'og',
    ]);
    const keys = await uploadKeys(uploadId);
    expect(new Set(keys.map((k) => k.key)).size).toBe(parts.length);

    await storeAll(uploadId, parts);
    const { mediaId } = await finalizeUpload(
      env.DB,
      env,
      uploadId,
      '  Cut face of the slice  ',
      ACTOR,
    );

    // The master: private bucket only, no metadata at all, download-only.
    const originalKey = keys.find((k) => k.role === 'original')?.key ?? '';
    const master = await env.MEDIA_PRIVATE.get(originalKey);
    expect(master).not.toBeNull();
    expect(master?.httpMetadata?.contentDisposition).toMatch(/^attachment/);
    expect(
      parseJpeg(new Uint8Array(await (master as R2ObjectBody).arrayBuffer())).metadata,
    ).toEqual([]);
    expect(await env.MEDIA_PUBLIC.head(originalKey)).toBeNull();

    // Public files: only the creator/copyright tags (MED-07).
    for (const k of keys.filter((x) => x.role !== 'original')) {
      expect(await env.MEDIA_PRIVATE.head(k.key)).toBeNull();
      const obj = await env.MEDIA_PUBLIC.get(k.key);
      const bytes = new Uint8Array(await (obj as R2ObjectBody).arrayBuffer());
      const ok = k.role === 'og' ? hasOnlyRightsMetadata(bytes) : webpHasOnlyRightsMetadata(bytes);
      expect(ok, k.name).toBe(true);
      expect(bytesContain(bytes, `Copyright ${new Date().getUTCFullYear()} ${OWNER}`)).toBe(true);
    }

    const { active } = await listItemMedia(env.DB, item.id);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      id: mediaId,
      isCover: true,
      width: 4032,
      height: 3024,
      altText: 'Cut face of the slice',
    });
    expect(await count('media_variants', 'media_id = ?', mediaId)).toBe(6);
    expect(
      await count(
        'media_variants',
        "media_id = ? AND role = 'og' AND format = 'image/jpeg'",
        mediaId,
      ),
    ).toBe(1);
    expect(await count('media_uploads', 'id = ?', uploadId)).toBe(0);
    const media = await env.DB.prepare('SELECT content_hash FROM media WHERE id = ?')
      .bind(mediaId)
      .first<{ content_hash: string }>();
    expect(media?.content_hash).toMatch(/^[0-9a-f]{64}$/);

    // A revision records the new photo; the audit log names the owner.
    const [latest] = await listRevisions(env.DB, item.id);
    expect(latest?.snapshot.mediaIds).toEqual([mediaId]);
    expect(
      await count(
        'audit_log',
        "action = 'media.add' AND target_id = ? AND actor_email = ?",
        mediaId,
        ACTOR,
      ),
    ).toBe(1);

    // The item can now be published.
    expect(await publishBlockers(env.DB, item.id)).toEqual(['needs_category']);
  });

  it('lets a file be re-sent before finalizing (retries are safe)', async () => {
    const item = await createItem(env.DB, { title: 'Retry' }, ACTOR);
    const { uploadId, parts } = await beginUpload(env.DB, item.id, { width: 1000, height: 800 });
    const first = parts[0] as PlannedPart;
    await storeUploadPart(env.DB, env, uploadId, first.name, fileFor(first), OWNER);
    await storeAll(uploadId, parts);
    await expect(finalizeUpload(env.DB, env, uploadId, '', ACTOR)).resolves.toHaveProperty(
      'mediaId',
    );
  });
});

describe('server verification rejects bad files before storing them (MED-03, TST-05)', () => {
  it.each([
    ['an SVG', () => SVG, 'file_wrong_type'],
    [
      'a JPEG with camera EXIF / GPS',
      () => makeJpeg({ width: 1000, height: 800, extra: [cameraExifSegment()] }),
      'file_has_metadata',
    ],
    [
      'a JPEG + HTML polyglot',
      () => makeJpeg({ width: 1000, height: 800, trailing: HTML_TAIL }),
      'file_malformed',
    ],
    ['the wrong dimensions', () => makeJpeg({ width: 800, height: 1000 }), 'file_wrong_size'],
    [
      'a WebP where the master belongs',
      () => makeWebp({ width: 1000, height: 800 }),
      'file_wrong_type',
    ],
    [
      'an oversize file',
      () => makeJpeg({ width: 1000, height: 800, minBytes: 30 * 1024 * 1024 + 1000 }),
      'file_too_large',
    ],
  ])('%s', async (_label, bytes, why) => {
    const item = await createItem(env.DB, { title: 'Bad file' }, ACTOR);
    const { uploadId } = await beginUpload(env.DB, item.id, { width: 1000, height: 800 });
    expect(
      await invalidReason(storeUploadPart(env.DB, env, uploadId, 'original', bytes(), OWNER)),
    ).toMatchObject({
      code: 'invalid',
      reason: why,
      part: 'original',
    });
    // Nothing was stored.
    const [original] = await uploadKeys(uploadId);
    expect(await env.MEDIA_PRIVATE.head(original?.key ?? '')).toBeNull();
  });

  it('no stored object anywhere carries the camera-metadata sentinel', async () => {
    for (const bucket of [env.MEDIA_PUBLIC, env.MEDIA_PRIVATE]) {
      const { objects } = await bucket.list();
      for (const o of objects) {
        const body = await bucket.get(o.key);
        const bytes = new Uint8Array(await (body as R2ObjectBody).arrayBuffer());
        expect(bytesContain(bytes, SENTINEL), o.key).toBe(false);
      }
    }
  });

  it('rejects unknown uploads and parts, and expired uploads', async () => {
    const item = await createItem(env.DB, { title: 'Unknowns' }, ACTOR);
    const t0 = new Date('2026-06-01T00:00:00Z');
    const { uploadId, parts } = await beginUpload(
      env.DB,
      item.id,
      { width: 1000, height: 800 },
      t0,
    );
    const og = parts.find((p) => p.name === 'og') as PlannedPart;
    expect(
      await invalidReason(storeUploadPart(env.DB, env, uploadId, 'w9999', fileFor(og), OWNER, t0)),
    ).toMatchObject({ code: 'not_found' });
    expect(
      await invalidReason(storeUploadPart(env.DB, env, 'nope', 'og', fileFor(og), OWNER, t0)),
    ).toMatchObject({ code: 'not_found' });
    expect(
      await invalidReason(
        storeUploadPart(env.DB, env, '0'.repeat(26), 'og', fileFor(og), OWNER, t0),
      ),
    ).toMatchObject({ code: 'not_found' });
    const later = new Date(t0.getTime() + 25 * HOUR);
    expect(
      await invalidReason(storeUploadPart(env.DB, env, uploadId, 'og', fileFor(og), OWNER, later)),
    ).toMatchObject({
      code: 'not_found',
      reason: 'expired',
    });
  });

  it('refuses photo sizes outside the plan, and uploads to trashed items', async () => {
    const item = await createItem(env.DB, { title: 'Sizes' }, ACTOR);
    expect(
      await invalidReason(beginUpload(env.DB, item.id, { width: 8064, height: 6048 })),
    ).toMatchObject({ reason: 'photo_too_large' });
    expect(
      await invalidReason(beginUpload(env.DB, item.id, { width: 100, height: 80 })),
    ).toMatchObject({ reason: 'photo_too_small' });
    await trashItem(env.DB, item.id, ACTOR);
    expect(
      await invalidReason(beginUpload(env.DB, item.id, { width: 1000, height: 800 })),
    ).toMatchObject({ code: 'conflict', reasons: ['in_trash'] });
    expect(
      await invalidReason(beginUpload(env.DB, 'nope', { width: 1000, height: 800 })),
    ).toMatchObject({ code: 'not_found' });
  });

  it('finalize refuses until every file is stored, and only once', async () => {
    const item = await createItem(env.DB, { title: 'Partial' }, ACTOR);
    const { uploadId, parts } = await beginUpload(env.DB, item.id, { width: 1000, height: 800 });
    await storeAll(uploadId, parts.slice(0, 2));
    expect(await invalidReason(finalizeUpload(env.DB, env, uploadId, '', ACTOR))).toMatchObject({
      code: 'conflict',
      reasons: ['missing_files'],
      missing: parts.slice(2).map((p) => p.name),
    });
    await storeAll(uploadId, parts.slice(2));
    await finalizeUpload(env.DB, env, uploadId, '', ACTOR);
    expect(await invalidReason(finalizeUpload(env.DB, env, uploadId, '', ACTOR))).toMatchObject({
      code: 'not_found',
    });
    expect(
      await invalidReason(
        storeUploadPart(env.DB, env, uploadId, 'og', fileFor(parts.at(-1) as PlannedPart), OWNER),
      ),
    ).toMatchObject({ code: 'not_found' });
  });
});

describe('photo edits', () => {
  it('reorders (first is the cover), sets alt text, removes and restores', async () => {
    const item = await createItem(env.DB, { title: 'Three photos' }, ACTOR);
    const a = await addPhoto(item.id, 1000, 800);
    const b = await addPhoto(item.id, 800, 1000);
    const c = await addPhoto(item.id, 1000, 1000);
    expect((await listItemMedia(env.DB, item.id)).active.map((m) => m.id)).toEqual([a, b, c]);

    await reorderMedia(env.DB, item.id, [c, a, b], ACTOR);
    let { active } = await listItemMedia(env.DB, item.id);
    expect(active.map((m) => [m.id, m.position, m.isCover])).toEqual([
      [c, 0, true],
      [a, 1, false],
      [b, 2, false],
    ]);
    expect((await coverThumbKeys(env.DB, [item.id])).get(item.id)).toBe(active[0]?.thumbKey);

    await expect(reorderMedia(env.DB, item.id, [c, a], ACTOR)).rejects.toThrow(DomainError);
    await expect(reorderMedia(env.DB, item.id, [c, a, a], ACTOR)).rejects.toThrow(DomainError);

    await setMediaAlt(env.DB, a, 'Etched face', ACTOR);
    await removeMedia(env.DB, c, ACTOR);
    ({ active } = await listItemMedia(env.DB, item.id));
    expect(active.map((m) => [m.id, m.isCover, m.altText])).toEqual([
      [a, true, 'Etched face'],
      [b, false, ''],
    ]);
    const removed = (await listItemMedia(env.DB, item.id)).removed;
    expect(removed.map((m) => m.id)).toEqual([c]);

    await restoreMedia(env.DB, c, ACTOR);
    ({ active } = await listItemMedia(env.DB, item.id));
    expect(active.map((m) => m.id)).toEqual([a, b, c]);
    const [latest] = await listRevisions(env.DB, item.id);
    expect(latest?.snapshot.mediaIds).toEqual([a, b, c]);
    for (const action of ['media.reorder', 'media.alt', 'media.remove', 'media.restore']) {
      expect(
        await count('audit_log', 'action = ? AND actor_email = ?', action, ACTOR),
        action,
      ).toBeGreaterThan(0);
    }
  });

  it("a public item can't lose its last photo", async () => {
    const cat = await insertCategory('Photo cat', `photo-cat-${Date.now()}`);
    const item = await createItem(env.DB, { title: 'Public one' }, ACTOR);
    const only = await addPhoto(item.id, 1000, 800);
    await setItemCategories(env.DB, item.id, [cat], ACTOR);
    await setItemStatus(env.DB, item.id, 'public', ACTOR);
    expect(await invalidReason(removeMedia(env.DB, only, ACTOR))).toMatchObject({
      code: 'cannot_publish',
      reasons: ['needs_media'],
    });
    await setItemStatus(env.DB, item.id, 'private', ACTOR);
    await removeMedia(env.DB, only, ACTOR);
    expect(await publishBlockers(env.DB, item.id)).toEqual(['needs_media']);
  });
});

describe('admin previews and downloads', () => {
  it('serves known variants and the master; unknown keys get nothing', async () => {
    const item = await createItem(env.DB, { title: 'Previews' }, ACTOR);
    const id = await addPhoto(item.id, 1000, 800);
    const { active } = await listItemMedia(env.DB, item.id);
    const thumb = active[0]?.thumbKey ?? '';
    expect(await getVariantObject(env.DB, env, thumb)).not.toBeNull();
    expect(await getVariantObject(env.DB, env, 'x'.repeat(26))).toBeNull();
    expect(await getVariantObject(env.DB, env, '../secret')).toBeNull();
    const original = await getOriginalObject(env.DB, env, id);
    expect(original?.httpMetadata?.contentType).toBe('image/jpeg');
    expect(await getOriginalObject(env.DB, env, '0'.repeat(26))).toBeNull();
    // A master key is never servable as a variant.
    const row = await env.DB.prepare('SELECT original_key FROM media WHERE id = ?')
      .bind(id)
      .first<{ original_key: string }>();
    expect(await getVariantObject(env.DB, env, row?.original_key ?? '')).toBeNull();
  });
});

describe('cleanup jobs', () => {
  it('removes uploads never finalized after 24 hours, with their files', async () => {
    const item = await createItem(env.DB, { title: 'Abandoned' }, ACTOR);
    const t0 = new Date('2026-07-01T00:00:00Z');
    const { uploadId, parts } = await beginUpload(
      env.DB,
      item.id,
      { width: 1000, height: 800 },
      t0,
    );
    await storeAll(uploadId, parts, t0);
    const keys = await uploadKeys(uploadId);
    await cleanupStaleUploads(env.DB, env, new Date(t0.getTime() + 23 * HOUR));
    expect(await count('media_uploads', 'id = ?', uploadId)).toBe(1);
    expect(
      await cleanupStaleUploads(env.DB, env, new Date(t0.getTime() + 25 * HOUR)),
    ).toBeGreaterThanOrEqual(1);
    expect(await count('media_uploads', 'id = ?', uploadId)).toBe(0);
    for (const k of keys) {
      const bucket = k.role === 'original' ? env.MEDIA_PRIVATE : env.MEDIA_PUBLIC;
      expect(await bucket.head(k.key), k.name).toBeNull();
    }
  });

  it('purges photos removed more than 30 days ago, files included', async () => {
    const item = await createItem(env.DB, { title: 'Purge photo' }, ACTOR);
    const keep = await addPhoto(item.id, 1000, 800);
    const gone = await addPhoto(item.id, 1000, 800);
    const t0 = new Date('2026-08-01T00:00:00Z');
    await removeMedia(env.DB, gone, ACTOR, t0);
    const variantKeys = (
      await env.DB.prepare('SELECT key FROM media_variants WHERE media_id = ?')
        .bind(gone)
        .all<{ key: string }>()
    ).results.map((r) => r.key);
    const orig = await env.DB.prepare('SELECT original_key FROM media WHERE id = ?')
      .bind(gone)
      .first<{ original_key: string }>();

    expect(await purgeRemovedMedia(env.DB, env, new Date(t0.getTime() + 29 * DAY))).toBe(0);
    expect(
      await purgeRemovedMedia(env.DB, env, new Date(t0.getTime() + 31 * DAY)),
    ).toBeGreaterThanOrEqual(1);
    expect(await count('media', 'id = ?', gone)).toBe(0);
    expect(await count('media', 'id = ?', keep)).toBe(1);
    expect(await env.MEDIA_PRIVATE.head(orig?.original_key ?? '')).toBeNull();
    for (const k of variantKeys) expect(await env.MEDIA_PUBLIC.head(k)).toBeNull();
    expect(await count('audit_log', "action = 'media.purge' AND target_id = ?", gone)).toBe(1);
  });

  it('deleting an item permanently also deletes its unfinished uploads', async () => {
    const item = await createItem(env.DB, { title: 'Purge with pending' }, ACTOR);
    const { uploadId, parts } = await beginUpload(env.DB, item.id, { width: 1000, height: 800 });
    await storeAll(uploadId, parts);
    const keys = await uploadKeys(uploadId);
    await trashItem(env.DB, item.id, ACTOR);
    await purgeItemNow(env.DB, env, item.id, ACTOR);
    for (const k of keys) {
      const bucket = k.role === 'original' ? env.MEDIA_PRIVATE : env.MEDIA_PUBLIC;
      expect(await bucket.head(k.key), k.name).toBeNull();
    }
  });
});
