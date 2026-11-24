/** ADM-04: permanent deletion from the trash (30-day auto-purge and "Delete permanently"). */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createItem, trashItem } from '../src/admin/items.ts';
import { PURGE_ACTOR, purgeExpiredTrash, purgeItemNow } from '../src/admin/purge.ts';
import { DomainError } from '../src/admin/domain-error.ts';
import { randomKey } from '../src/ids.ts';
import { ACTOR, count, insertMedia } from './db-helpers.ts';

const DAY = 24 * 3600 * 1000;

/** An item with one photo whose master and one derivative exist in R2. */
async function itemWithFiles(title: string) {
  const item = await createItem(env.DB, { title }, ACTOR);
  const mediaId = await insertMedia(item.id);
  const row = await env.DB.prepare('SELECT original_key FROM media WHERE id = ?')
    .bind(mediaId)
    .first<{ original_key: string }>();
  const originalKey = row?.original_key ?? '';
  const variantKey = randomKey();
  await env.DB.prepare(
    `INSERT INTO media_variants (key, media_id, role, width, height, format, bytes)
     VALUES (?, ?, 'image', 400, 300, 'image/webp', 3)`,
  )
    .bind(variantKey, mediaId)
    .run();
  await env.MEDIA_PRIVATE.put(originalKey, 'jpg');
  await env.MEDIA_PUBLIC.put(variantKey, 'webp');
  return { item, originalKey, variantKey };
}

describe('purgeExpiredTrash', () => {
  it('deletes items trashed more than 30 days ago, with their files, and keeps newer ones', async () => {
    const now = new Date('2026-12-31T00:00:00Z');
    const old = await itemWithFiles('Old trash');
    const recent = await itemWithFiles('Recent trash');
    const live = await itemWithFiles('Not trashed');
    await trashItem(env.DB, old.item.id, ACTOR, new Date(now.getTime() - 31 * DAY));
    await trashItem(env.DB, recent.item.id, ACTOR, new Date(now.getTime() - 29 * DAY));

    expect(await purgeExpiredTrash(env.DB, env, now)).toBe(1);

    expect(await count('items', 'id = ?', old.item.id)).toBe(0);
    expect(await count('media', 'item_id = ?', old.item.id)).toBe(0);
    expect(await count('item_revisions', 'item_id = ?', old.item.id)).toBe(0);
    expect(await env.MEDIA_PRIVATE.get(old.originalKey)).toBeNull();
    expect(await env.MEDIA_PUBLIC.get(old.variantKey)).toBeNull();
    expect(
      await count(
        'audit_log',
        "target_id = ? AND action = 'item.purge' AND actor_email = ?",
        old.item.id,
        PURGE_ACTOR,
      ),
    ).toBe(1);

    for (const kept of [recent, live]) {
      expect(await count('items', 'id = ?', kept.item.id)).toBe(1);
      expect(await env.MEDIA_PRIVATE.get(kept.originalKey)).not.toBeNull();
      expect(await env.MEDIA_PUBLIC.get(kept.variantKey)).not.toBeNull();
    }
  });
});

describe('purgeItemNow', () => {
  it('purges a trashed item at once, and refuses one that is not in the trash', async () => {
    const trashed = await itemWithFiles('Delete me');
    await trashItem(env.DB, trashed.item.id, ACTOR);
    await purgeItemNow(env.DB, env, trashed.item.id, ACTOR);
    expect(await count('items', 'id = ?', trashed.item.id)).toBe(0);
    expect(await env.MEDIA_PRIVATE.get(trashed.originalKey)).toBeNull();

    const live = await itemWithFiles('Keep me');
    const err = await purgeItemNow(env.DB, env, live.item.id, ACTOR).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe('conflict');
    expect(await count('items', 'id = ?', live.item.id)).toBe(1);
  });
});
