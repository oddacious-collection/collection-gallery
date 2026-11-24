/**
 * INV-1 / PUB-15: the public item queries return only publicly visible items,
 * only allowlisted fields, never IDs, and hidden items look exactly like
 * nonexistent ones.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  createItem,
  setItemCategories,
  setItemStatus,
  trashItem,
  updateItem,
} from '../src/admin/items.ts';
import { getPublicItemBySlug, listPublicItems } from '../src/public/items.ts';
import { ACTOR, insertCategory, insertMedia } from './db-helpers.ts';

const SENTINEL = 'SENTINEL-ADMIN-ONLY-91c2';

async function item(title: string, opts: { publish?: boolean } = {}) {
  const row = await createItem(
    env.DB,
    {
      title,
      purchasePriceCents: 123456,
      purchaseCurrency: 'USD',
      sourceCaption: SENTINEL,
      suggestedTags: [SENTINEL],
    },
    ACTOR,
  );
  const cat = await insertCategory('Cat', `cat-${row.id.toLowerCase()}`);
  await setItemCategories(env.DB, row.id, [cat], ACTOR);
  await insertMedia(row.id);
  if (opts.publish) await setItemStatus(env.DB, row.id, 'public', ACTOR);
  return row;
}

describe('getPublicItemBySlug', () => {
  it('returns a public item with allowlisted fields only', async () => {
    const row = await item('Public one', { publish: true });
    const result = await getPublicItemBySlug(env.DB, row.slug);
    expect(result.kind).toBe('item');
    if (result.kind !== 'item') return;
    expect(Object.keys(result.item).sort()).toEqual(
      ['description', 'licenseOverride', 'postedAt', 'slug', 'title'].sort(),
    );
    const json = JSON.stringify(result);
    expect(json).not.toContain(SENTINEL);
    expect(json).not.toContain(row.id);
    expect(json).not.toContain('123456');
  });

  it('treats draft, private, wishlist, trashed and missing items identically', async () => {
    const draft = await item('Draft');
    const priv = await item('Private', { publish: true });
    await setItemStatus(env.DB, priv.id, 'private', ACTOR);
    const wish = await item('Wish');
    await updateItem(env.DB, wish.id, { kind: 'wishlist' }, ACTOR);
    const trashed = await item('Trashed', { publish: true });
    await trashItem(env.DB, trashed.id, ACTOR);

    const results = await Promise.all(
      [draft.slug, priv.slug, wish.slug, trashed.slug, 'does-not-exist', '../etc', 'A B'].map((s) =>
        getPublicItemBySlug(env.DB, s),
      ),
    );
    for (const r of results) expect(r).toEqual({ kind: 'not_found' });
  });

  it('redirects an old slug only while the item is public', async () => {
    const row = await item('Renamed', { publish: true });
    await updateItem(env.DB, row.id, { slug: 'renamed-now' }, ACTOR);
    expect(await getPublicItemBySlug(env.DB, 'renamed')).toEqual({
      kind: 'redirect',
      slug: 'renamed-now',
    });
    await setItemStatus(env.DB, row.id, 'private', ACTOR);
    expect(await getPublicItemBySlug(env.DB, 'renamed')).toEqual({ kind: 'not_found' });
  });
});

describe('listPublicItems', () => {
  it('lists only public items, newest first, with stable paging', async () => {
    // Far-future dates so items other tests in this file published sort after these.
    const times = ['2099-01-01', '2099-01-02', '2099-01-03'];
    const published: string[] = [];
    for (const [i, day] of times.entries()) {
      const row = await item(`Item ${i}`);
      await setItemStatus(env.DB, row.id, 'public', ACTOR, new Date(`${day}T00:00:00Z`));
      published.push(row.slug);
    }
    await item('Hidden draft');

    const first = await listPublicItems(env.DB, { limit: 2 });
    expect(first.items.map((i) => i.slug)).toEqual([published[2], published[1]]);
    if (!first.next) throw new Error('expected a next page');
    const second = await listPublicItems(env.DB, { limit: 1, after: first.next });
    expect(second.items.map((i) => i.slug)).toEqual([published[0]]);
    const all = await listPublicItems(env.DB, { limit: 100 });
    expect(all.next).toBeNull();
    expect(all.items.map((i) => i.slug)).not.toContain('hidden-draft');
    expect(JSON.stringify([first, second, all])).not.toContain(SENTINEL);
  });
});
