/** Category tree (CNT-01..03, ADM-06). */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  createCategory,
  deleteCategory,
  descendantIds,
  listCategoryTree,
  moveCategory,
  reorderCategories,
  updateCategory,
} from '../src/admin/categories.ts';
import { DomainError } from '../src/admin/domain-error.ts';
import { createItem, setItemCategories } from '../src/admin/items.ts';
import { ACTOR, count } from './db-helpers.ts';

async function tree() {
  const rocks = await createCategory(env.DB, { name: 'Rocks & Minerals' }, ACTOR);
  const meteorites = await createCategory(
    env.DB,
    { name: 'Meteorites', parentId: rocks.id },
    ACTOR,
  );
  const chondrites = await createCategory(
    env.DB,
    { name: 'Chondrites', parentId: meteorites.id },
    ACTOR,
  );
  const h = await createCategory(env.DB, { name: 'H', parentId: chondrites.id }, ACTOR);
  return { rocks, meteorites, chondrites, h };
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

const sorted = (xs: string[]) => [...xs].sort();

describe('category tree', () => {
  it('keeps every ancestor/descendant pair (CNT-02/03)', async () => {
    const { rocks, meteorites, chondrites, h } = await tree();
    expect(rocks.slug).toBe('rocks-and-minerals');
    expect(sorted(await descendantIds(env.DB, rocks.id))).toEqual(
      sorted([rocks.id, meteorites.id, chondrites.id, h.id]),
    );
    expect(sorted(await descendantIds(env.DB, chondrites.id))).toEqual(
      sorted([chondrites.id, h.id]),
    );
    const nodes = await listCategoryTree(env.DB);
    expect(nodes.map((n) => [n.name, n.depth])).toEqual([
      ['Rocks & Minerals', 0],
      ['Meteorites', 1],
      ['Chondrites', 2],
      ['H', 3],
    ]);
  });

  it('rejects moving a category under itself or a descendant (CNT-01 AC)', async () => {
    const { meteorites, h } = await tree();
    const err = await expectDomainError(
      moveCategory(env.DB, meteorites.id, h.id, ACTOR),
      'invalid',
    );
    expect(err.details['reason']).toBe('cycle');
    await expectDomainError(moveCategory(env.DB, meteorites.id, meteorites.id, ACTOR), 'invalid');
  });

  it('moves a whole subtree and updates its ancestors', async () => {
    const { rocks, meteorites, chondrites, h } = await tree();
    const space = await createCategory(env.DB, { name: 'Space' }, ACTOR);
    await moveCategory(env.DB, meteorites.id, space.id, ACTOR);
    expect(sorted(await descendantIds(env.DB, rocks.id))).toEqual([rocks.id]);
    expect(sorted(await descendantIds(env.DB, space.id))).toEqual(
      sorted([space.id, meteorites.id, chondrites.id, h.id]),
    );
    // Depths are recomputed: H is now 3 below Space.
    const row = await env.DB.prepare(
      'SELECT depth FROM category_closure WHERE ancestor_id = ? AND descendant_id = ?',
    )
      .bind(space.id, h.id)
      .first<{ depth: number }>();
    expect(row?.depth).toBe(3);
    // And back to the top level.
    await moveCategory(env.DB, meteorites.id, null, ACTOR);
    expect(sorted(await descendantIds(env.DB, space.id))).toEqual([space.id]);
    expect(await count('category_closure', 'descendant_id = ?', h.id)).toBe(3); // self, Chondrites, Meteorites
  });

  it('reorders siblings and requires exactly the same siblings', async () => {
    // Storage isn't reset between tests in a file, so use a fresh parent.
    const parent = await createCategory(env.DB, { name: 'Reorder parent' }, ACTOR);
    const a = await createCategory(env.DB, { name: 'A', parentId: parent.id }, ACTOR);
    const b = await createCategory(env.DB, { name: 'B', parentId: parent.id }, ACTOR);
    await reorderCategories(env.DB, parent.id, [b.id, a.id], ACTOR);
    const children = (await listCategoryTree(env.DB))
      .filter((n) => n.parentId === parent.id)
      .map((n) => n.name);
    expect(children).toEqual(['B', 'A']);
    await expectDomainError(reorderCategories(env.DB, parent.id, [a.id], ACTOR), 'invalid');
  });

  it('deletes only empty categories (ADM-06)', async () => {
    const { meteorites, h } = await tree();
    const err = await expectDomainError(deleteCategory(env.DB, meteorites.id, ACTOR), 'conflict');
    expect(err.details['reasons']).toEqual(['has_children']);

    const item = await createItem(env.DB, { title: 'H5 chondrite' }, ACTOR);
    await setItemCategories(env.DB, item.id, [h.id], ACTOR);
    const err2 = await expectDomainError(deleteCategory(env.DB, h.id, ACTOR), 'conflict');
    expect(err2.details['reasons']).toEqual(['has_items']);

    await setItemCategories(env.DB, item.id, [], ACTOR);
    await deleteCategory(env.DB, h.id, ACTOR);
    expect(await count('categories', 'id = ?', h.id)).toBe(0);
    expect(
      await count('category_closure', 'descendant_id = ? OR ancestor_id = ?', h.id, h.id),
    ).toBe(0);
  });

  it('keeps slugs unique and audits every change', async () => {
    const first = await createCategory(env.DB, { name: 'Books' }, ACTOR);
    const again = await createCategory(env.DB, { name: 'Books' }, ACTOR);
    expect(again.slug).toBe('books-2');
    await expectDomainError(
      updateCategory(env.DB, again.id, { slug: 'books' }, ACTOR),
      'slug_taken',
    );
    await updateCategory(env.DB, again.id, { name: 'Rare books' }, ACTOR);
    expect(
      await count(
        'audit_log',
        "target_type = 'category' AND target_id IN (?, ?)",
        first.id,
        again.id,
      ),
    ).toBe(3);
  });
});
