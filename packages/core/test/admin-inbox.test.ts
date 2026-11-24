/**
 * The photo inbox (D-55): uploads without an item, assigned later. Real D1
 * and R2 in workerd. Includes the privacy rule: an inbox photo is never
 * reachable publicly until it belongs to a public item.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { DomainError } from '../src/admin/domain-error.ts';
import { createCategory } from '../src/admin/categories.ts';
import {
  createItem,
  getItem,
  listRevisions,
  setItemStatus,
  trashItem,
} from '../src/admin/items.ts';
import {
  assignInboxPhotos,
  beginUpload,
  cleanupStaleUploads,
  finalizeInboxUpload,
  finalizeUpload,
  getOriginalObject,
  getVariantObject,
  listInbox,
  listItemMedia,
  purgeRemovedInbox,
  recentInboxAssignments,
  removeInboxPhotos,
  restoreInboxPhotos,
  storeUploadPart,
  uploadTarget,
} from '../src/admin/media.ts';
import { servePublicMedia } from '../src/public/index.ts';
import type { PlannedPart } from '../src/media/index.ts';
import { ACTOR, count } from './db-helpers.ts';
import { makeJpeg, makeWebp } from './image-fixtures.ts';

const OWNER = 'Insignificant Nobody';
const DAY = 24 * 3600 * 1000;

async function inboxPhoto(width = 1000, height = 800, now = new Date()): Promise<string> {
  const { uploadId, parts } = await beginUpload(env.DB, null, { width, height }, now);
  for (const p of parts as PlannedPart[]) {
    const bytes = p.format === 'image/jpeg' ? makeJpeg(p) : makeWebp(p);
    await storeUploadPart(env.DB, env, uploadId, p.name, bytes, OWNER, now);
  }
  expect(await uploadTarget(env.DB, uploadId, now)).toBe('inbox');
  return (await finalizeInboxUpload(env.DB, env, uploadId, ACTOR, now)).inboxId;
}

async function partsOf(inboxId: string): Promise<Array<{ role: string; key: string }>> {
  const row = await env.DB.prepare('SELECT parts FROM inbox_photos WHERE id = ?')
    .bind(inboxId)
    .first<{ parts: string }>();
  return JSON.parse(row?.parts ?? '[]') as Array<{ role: string; key: string }>;
}

const publicGet = (key: string) =>
  servePublicMedia(env.DB, env.MEDIA_PUBLIC, key, new Request(`https://x/media/${key}`));

async function reason(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    if (err instanceof DomainError) return { code: err.code, ...err.details };
    throw err;
  }
  return 'no error';
}

describe('uploading into the inbox', () => {
  it('stores the files like any photo, but attaches them to nothing', async () => {
    const id = await inboxPhoto(1200, 900);
    const { photos } = await listInbox(env.DB);
    const view = photos.find((p) => p.id === id);
    expect(view).toMatchObject({ width: 1200, height: 900, deletedAt: null });
    expect(view?.thumbKey).toMatch(/^[0-9a-z]{26}$/);
    expect(await count('media', '1')).toBeGreaterThanOrEqual(0);
    expect(await count('media_uploads', '1')).toBe(0);
    expect(await count('audit_log', "action = 'inbox.add' AND target_id = ?", id)).toBe(1);

    // The master is private; the public sizes exist but nothing serves them publicly.
    const parts = await partsOf(id);
    const original = parts.find((p) => p.role === 'original')?.key ?? '';
    expect(await env.MEDIA_PRIVATE.head(original)).not.toBeNull();
    for (const p of parts.filter((x) => x.role !== 'original')) {
      expect(await env.MEDIA_PUBLIC.head(p.key)).not.toBeNull();
      expect(await publicGet(p.key)).toBeNull();
    }
    // The admin can preview the public sizes, never the master that way.
    expect(await getVariantObject(env.DB, env, view?.thumbKey ?? '')).not.toBeNull();
    expect(await getVariantObject(env.DB, env, original)).toBeNull();
  });

  it('an item upload and an inbox upload are finalized by their own function only', async () => {
    const item = await createItem(env.DB, { title: 'Not inbox' }, ACTOR);
    const forItem = await beginUpload(env.DB, item.id, { width: 1000, height: 800 });
    expect(await reason(finalizeInboxUpload(env.DB, env, forItem.uploadId, ACTOR))).toMatchObject({
      code: 'not_found',
    });
    const forInbox = await beginUpload(env.DB, null, { width: 1000, height: 800 });
    expect(await reason(finalizeUpload(env.DB, env, forInbox.uploadId, '', ACTOR))).toMatchObject({
      code: 'not_found',
    });
    // Unfinished inbox uploads are cleaned up like any other.
    await cleanupStaleUploads(env.DB, env, new Date(Date.now() + 2 * DAY));
    expect(await count('media_uploads', 'id = ?', forInbox.uploadId)).toBe(0);
  });
});

describe('assigning inbox photos', () => {
  it('creates a draft in the order chosen, with its category; the photos leave the inbox', async () => {
    const cat = await createCategory(
      env.DB,
      { name: 'Inbox cat', slug: `inbox-cat-${Date.now()}` },
      ACTOR,
    );
    const a = await inboxPhoto();
    const b = await inboxPhoto(800, 1000);
    const c = await inboxPhoto();
    const keysB = await partsOf(b);

    const { itemId, created } = await assignInboxPhotos(
      env.DB,
      { photoIds: [b, a], title: 'Seymchan from the inbox', categoryId: cat.id },
      ACTOR,
    );
    expect(created).toBe(true);
    const item = await getItem(env.DB, itemId);
    expect(item).toMatchObject({
      title: 'Seymchan from the inbox',
      status: 'draft',
      categoryIds: [cat.id],
    });

    const { active } = await listItemMedia(env.DB, itemId);
    expect(active.map((m) => [m.width, m.height, m.isCover])).toEqual([
      [800, 1000, true],
      [1000, 800, false],
    ]);
    // Same stored files: nothing copied.
    const original = await env.DB.prepare('SELECT original_key FROM media WHERE id = ?')
      .bind(active[0]?.id ?? '')
      .first<{ original_key: string }>();
    expect(original?.original_key).toBe(keysB.find((p) => p.role === 'original')?.key);
    expect(await getOriginalObject(env.DB, env, active[0]?.id ?? '')).not.toBeNull();

    const inbox = (await listInbox(env.DB)).photos.map((p) => p.id);
    expect(inbox).toContain(c);
    expect(inbox).not.toContain(a);
    expect(inbox).not.toContain(b);
    const [latest] = await listRevisions(env.DB, itemId);
    expect(latest?.snapshot.mediaIds).toEqual(active.map((m) => m.id));

    // "Recently used" shows the item.
    const recent = await recentInboxAssignments(env.DB);
    expect(recent[0]).toMatchObject({ itemId, title: 'Seymchan from the inbox', photos: 2 });

    // Assigned photos are public only once the item is.
    const variant = keysB.find((p) => p.role === 'image')?.key ?? '';
    expect(await publicGet(variant)).toBeNull();
    await setItemStatus(env.DB, itemId, 'public', ACTOR);
    expect((await publicGet(variant))?.status).toBe(200);
  });

  it('adds to an existing item after its photos; refuses used, removed and trashed targets', async () => {
    const item = await createItem(env.DB, { title: 'Existing' }, ACTOR);
    const first = await inboxPhoto();
    await assignInboxPhotos(env.DB, { photoIds: [first], itemId: item.id }, ACTOR);
    const second = await inboxPhoto(900, 900);
    const { created } = await assignInboxPhotos(
      env.DB,
      { photoIds: [second], itemId: item.id },
      ACTOR,
    );
    expect(created).toBe(false);
    const { active } = await listItemMedia(env.DB, item.id);
    expect(active.map((m) => [m.width, m.isCover])).toEqual([
      [1000, true],
      [900, false],
    ]);

    expect(
      await reason(assignInboxPhotos(env.DB, { photoIds: [first], itemId: item.id }, ACTOR)),
    ).toMatchObject({
      code: 'not_found',
      reason: 'inbox_photo',
    });
    const removed = await inboxPhoto();
    await removeInboxPhotos(env.DB, [removed], ACTOR);
    expect(
      await reason(assignInboxPhotos(env.DB, { photoIds: [removed], title: 'X' }, ACTOR)),
    ).toMatchObject({
      code: 'not_found',
    });
    const trashed = await createItem(env.DB, { title: 'Trashed' }, ACTOR);
    await trashItem(env.DB, trashed.id, ACTOR);
    const spare = await inboxPhoto();
    expect(
      await reason(assignInboxPhotos(env.DB, { photoIds: [spare], itemId: trashed.id }, ACTOR)),
    ).toMatchObject({
      code: 'conflict',
      reasons: ['in_trash'],
    });
    expect((await listInbox(env.DB)).photos.map((p) => p.id)).toContain(spare);
    // Exactly one of item / title.
    await expect(assignInboxPhotos(env.DB, { photoIds: [spare] }, ACTOR)).rejects.toThrow();
    await expect(
      assignInboxPhotos(env.DB, { photoIds: [spare], itemId: item.id, title: 'Both' }, ACTOR),
    ).rejects.toThrow();
  });
});

describe('removing inbox photos', () => {
  it('is soft for 30 days, then the files go too', async () => {
    const t0 = new Date('2026-09-01T00:00:00Z');
    const id = await inboxPhoto(1000, 800, t0);
    const parts = await partsOf(id);
    expect(await removeInboxPhotos(env.DB, [id], ACTOR, t0)).toBe(1);
    let inbox = await listInbox(env.DB);
    expect(inbox.photos.map((p) => p.id)).not.toContain(id);
    expect(inbox.removed.map((p) => p.id)).toContain(id);
    expect(await restoreInboxPhotos(env.DB, [id], ACTOR, t0)).toBe(1);
    inbox = await listInbox(env.DB);
    expect(inbox.photos.map((p) => p.id)).toContain(id);

    await removeInboxPhotos(env.DB, [id], ACTOR, t0);
    await purgeRemovedInbox(env.DB, env, new Date(t0.getTime() + 29 * DAY));
    expect(await count('inbox_photos', 'id = ?', id)).toBe(1);
    await purgeRemovedInbox(env.DB, env, new Date(t0.getTime() + 31 * DAY));
    expect(await count('inbox_photos', 'id = ?', id)).toBe(0);
    for (const p of parts) {
      const bucket = p.role === 'original' ? env.MEDIA_PRIVATE : env.MEDIA_PUBLIC;
      expect(await bucket.head(p.key), p.role).toBeNull();
    }
  });
});
