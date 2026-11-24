/** Admin item rules: ADM-02 (publish), ADM-04 (trash), ADM-05 (revisions), SEC-13 (audit), slugs. */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  createItem,
  getItem,
  listItems,
  listRevisions,
  publishBlockers,
  restoreItem,
  restoreRevision,
  setItemCategories,
  setItemStatus,
  setItemTags,
  trashItem,
  updateItem,
} from '../src/admin/items.ts';
import { DomainError } from '../src/admin/domain-error.ts';
import { ACTOR, count, insertCategory, insertMedia } from './db-helpers.ts';

async function publishable(title = 'Seymchan pallasite') {
  const item = await createItem(env.DB, { title }, ACTOR);
  const cat = await insertCategory('Meteorites', `meteorites-${item.id.toLowerCase()}`);
  await setItemCategories(env.DB, item.id, [cat], ACTOR);
  await insertMedia(item.id);
  return { item, cat };
}

async function expectDomainError(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  expect((err as DomainError).code).toBe(code);
  return err as DomainError;
}

describe('createItem', () => {
  it('creates a draft with a unique slug, one revision and one audit entry', async () => {
    const a = await createItem(env.DB, { title: 'Seymchan Pallasite' }, ACTOR);
    const b = await createItem(env.DB, { title: 'Seymchan pallasite!' }, ACTOR);
    expect(a.status).toBe('draft');
    expect(a.kind).toBe('owned');
    expect(a.slug).toBe('seymchan-pallasite');
    expect(b.slug).toBe('seymchan-pallasite-2');
    expect(await count('item_revisions', 'item_id = ?', a.id)).toBe(1);
    expect(await count('audit_log', "target_id = ? AND action = 'item.create'", a.id)).toBe(1);
  });

  it('rejects a taken explicit slug and invalid input', async () => {
    await createItem(env.DB, { title: 'A', slug: 'taken' }, ACTOR);
    await expectDomainError(createItem(env.DB, { title: 'B', slug: 'taken' }, ACTOR), 'slug_taken');
    await expect(createItem(env.DB, { title: '   ' }, ACTOR)).rejects.toThrow();
    await expect(
      createItem(env.DB, { title: 'x', purchaseCurrency: 'usd' } as never, ACTOR),
    ).rejects.toThrow();
    await expect(
      createItem(env.DB, { title: 'x', status: 'public' } as never, ACTOR),
    ).rejects.toThrow();
  });
});

describe('publishing (§4.1, ADM-02)', () => {
  it('needs a category and a photo', async () => {
    const item = await createItem(env.DB, { title: 'Bare' }, ACTOR);
    const err = await expectDomainError(
      setItemStatus(env.DB, item.id, 'public', ACTOR),
      'cannot_publish',
    );
    expect(err.details['reasons']).toEqual(['needs_category', 'needs_media']);
  });

  it('sets posted_at on first publish only, and toggles private/public', async () => {
    const { item } = await publishable();
    const first = await setItemStatus(
      env.DB,
      item.id,
      'public',
      ACTOR,
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(first.postedAt).toBe('2026-01-01T00:00:00.000Z');
    await setItemStatus(env.DB, item.id, 'private', ACTOR);
    const again = await setItemStatus(
      env.DB,
      item.id,
      'public',
      ACTOR,
      new Date('2026-02-01T00:00:00Z'),
    );
    expect(again.postedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(await count('audit_log', "target_id = ? AND action = 'item.status'", item.id)).toBe(3);
  });

  it('never lets a wishlist item be public, in code or in the database', async () => {
    const { item } = await publishable();
    await updateItem(env.DB, item.id, { kind: 'wishlist' }, ACTOR);
    const err = await expectDomainError(
      setItemStatus(env.DB, item.id, 'public', ACTOR),
      'cannot_publish',
    );
    expect(err.details['reasons']).toContain('wishlist');
    await expect(
      env.DB.prepare("UPDATE items SET status = 'public' WHERE id = ?").bind(item.id).run(),
    ).rejects.toThrow(/CHECK/);
  });

  it('keeps at least one category on a public item', async () => {
    const { item } = await publishable();
    await setItemStatus(env.DB, item.id, 'public', ACTOR);
    await expectDomainError(setItemCategories(env.DB, item.id, [], ACTOR), 'cannot_publish');
  });
});

describe('trash (ADM-04)', () => {
  it('moves to and restores from the trash, and blocks publishing while trashed', async () => {
    const { item } = await publishable();
    await trashItem(env.DB, item.id, ACTOR);
    expect((await listItems(env.DB)).map((i) => i.id)).not.toContain(item.id);
    expect((await listItems(env.DB, { trashed: true })).map((i) => i.id)).toContain(item.id);
    expect(await publishBlockers(env.DB, item.id)).toContain('in_trash');
    await restoreItem(env.DB, item.id, ACTOR);
    expect((await getItem(env.DB, item.id)).deletedAt).toBeNull();
  });
});

describe('slugs and redirects', () => {
  it('records the old slug when it changes, and lets the item reclaim it', async () => {
    const item = await createItem(env.DB, { title: 'Old name' }, ACTOR);
    await updateItem(env.DB, item.id, { slug: 'new-name' }, ACTOR);
    expect(await count('slug_redirects', 'old_slug = ? AND item_id = ?', 'old-name', item.id)).toBe(
      1,
    );
    // Another item can't take the redirected slug.
    await expectDomainError(
      createItem(env.DB, { title: 'x', slug: 'old-name' }, ACTOR),
      'slug_taken',
    );
    // The same item can go back to it; the redirect then points the other way.
    await updateItem(env.DB, item.id, { slug: 'old-name' }, ACTOR);
    expect(await count('slug_redirects', 'old_slug = ?', 'old-name')).toBe(0);
    expect(await count('slug_redirects', 'old_slug = ?', 'new-name')).toBe(1);
  });
});

describe('tags', () => {
  it('creates tags by name, de-duplicates by slug, and replaces the set', async () => {
    const item = await createItem(env.DB, { title: 'Tagged' }, ACTOR);
    await setItemTags(env.DB, item.id, ['Pallasite', ' pallasite ', 'Meteorite'], ACTOR);
    expect((await getItem(env.DB, item.id)).tagNames).toEqual(['Meteorite', 'Pallasite']);
    await setItemTags(env.DB, item.id, ['Meteorite'], ACTOR);
    expect((await getItem(env.DB, item.id)).tagNames).toEqual(['Meteorite']);
    expect(await count('tags')).toBe(2);
  });
});

describe('revisions (ADM-05)', () => {
  it('writes one per save and restores content without changing status', async () => {
    const { item } = await publishable('First title');
    await updateItem(env.DB, item.id, { description: 'v2 text' }, ACTOR);
    await setItemStatus(env.DB, item.id, 'public', ACTOR);
    await updateItem(env.DB, item.id, { title: 'Third title', description: 'v3 text' }, ACTOR);

    const revs = await listRevisions(env.DB, item.id);
    const v2 = revs.find((r) => r.snapshot.item.description === 'v2 text');
    if (!v2) throw new Error('expected a revision with the v2 description');
    const restored = await restoreRevision(env.DB, v2.id, ACTOR);
    expect(restored.title).toBe('First title');
    expect(restored.description).toBe('v2 text');
    expect((await getItem(env.DB, item.id)).status).toBe('public');
    expect(await count('audit_log', "action = 'item.revision_restore'")).toBe(1);
  });

  it('records the acting owner on every mutation (SEC-13)', async () => {
    const { item } = await publishable();
    await updateItem(env.DB, item.id, { title: 'Changed' }, 'someone@example.test');
    const row = await env.DB.prepare(
      "SELECT actor_email, details FROM audit_log WHERE target_id = ? AND action = 'item.update'",
    )
      .bind(item.id)
      .first<{ actor_email: string; details: string }>();
    expect(row?.actor_email).toBe('someone@example.test');
    expect(JSON.parse(row?.details ?? '{}')).toEqual({ changed: ['title'] });
  });
});

describe('purchase currency (D-57)', () => {
  it('stores USD for a price given without a currency, on create and on edit', async () => {
    const a = await createItem(env.DB, { title: 'Priced', purchasePriceCents: 4200 }, ACTOR);
    expect(a.purchaseCurrency).toBe('USD');
    const b = await createItem(env.DB, { title: 'Unpriced' }, ACTOR);
    expect(b.purchaseCurrency).toBeNull();
    const edited = await updateItem(env.DB, b.id, { purchasePriceCents: 1999 }, ACTOR);
    expect(edited.purchaseCurrency).toBe('USD');
    const row = await env.DB.prepare('SELECT purchase_currency FROM items WHERE id = ?')
      .bind(b.id)
      .first<{ purchase_currency: string }>();
    expect(row?.purchase_currency).toBe('USD');
  });
});
