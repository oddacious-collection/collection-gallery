/**
 * The Instagram import's bookkeeping in the database (M2 step 3, D-62, D-70):
 * import keys are unique (re-runs never duplicate), hashtag rules are kept
 * tidy by the database itself.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createItem } from '../src/admin/items.ts';
import { ACTOR, insertCategory, insertMedia } from './db-helpers.ts';

const now = () => new Date().toISOString();

describe('import bookkeeping (D-70)', () => {
  it('allows each import key once, and any number of hand-made items without one', async () => {
    const a = await createItem(env.DB, { title: 'Imported A' }, ACTOR);
    const b = await createItem(env.DB, { title: 'Imported B' }, ACTOR);
    await createItem(env.DB, { title: 'Hand made 1' }, ACTOR);
    await createItem(env.DB, { title: 'Hand made 2' }, ACTOR);
    const key = `ig:1474978842:${'ab'.repeat(32)}`;
    await env.DB.prepare('UPDATE items SET import_key = ? WHERE id = ?').bind(key, a.id).run();
    await expect(
      env.DB.prepare('UPDATE items SET import_key = ? WHERE id = ?').bind(key, b.id).run(),
    ).rejects.toThrow(/UNIQUE/);
    const n = await env.DB.prepare(
      'SELECT count(*) AS n FROM items WHERE import_key IS NULL',
    ).first<{ n: number }>();
    expect(n?.n).toBeGreaterThanOrEqual(3);
  });

  it('records the source file hash on media', async () => {
    const item = await createItem(env.DB, { title: 'With media' }, ACTOR);
    const media = await insertMedia(item.id);
    await env.DB.prepare('UPDATE media SET source_hash = ? WHERE id = ?')
      .bind('cd'.repeat(32), media)
      .run();
    const row = await env.DB.prepare('SELECT id FROM media WHERE item_id = ? AND source_hash = ?')
      .bind(item.id, 'cd'.repeat(32))
      .first<{ id: string }>();
    expect(row?.id).toBe(media);
  });

  it('keeps hashtag rules well-formed and drops them with their category', async () => {
    const cat = await insertCategory('Meteorites', `meteorites-${Date.now()}`);
    const rule = (hashtag: string, categoryId: string | null, tagName: string | null) =>
      env.DB.prepare(
        'INSERT INTO hashtag_rules (hashtag, category_id, tag_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
        .bind(hashtag, categoryId, tagName, now(), now())
        .run();
    await rule('meteorite', cat, null);
    await rule('iron', null, 'Iron');
    await rule('pallasite', cat, 'Pallasite');
    // Upper case, empty, or pointing nowhere: refused.
    await expect(rule('Meteor', cat, null)).rejects.toThrow(/CHECK/);
    await expect(rule('', cat, null)).rejects.toThrow(/CHECK/);
    await expect(rule('nowhere', null, null)).rejects.toThrow(/CHECK/);
    await expect(rule('meteorite', null, 'Again')).rejects.toThrow(/UNIQUE|PRIMARY/);
    // Deleting the category removes the rules that point at it.
    await env.DB.prepare('DELETE FROM category_closure WHERE ancestor_id = ? OR descendant_id = ?')
      .bind(cat, cat)
      .run();
    await env.DB.prepare('DELETE FROM categories WHERE id = ?').bind(cat).run();
    const left = await env.DB.prepare(
      "SELECT hashtag FROM hashtag_rules WHERE hashtag IN ('meteorite', 'iron', 'pallasite') ORDER BY hashtag",
    ).all<{ hashtag: string }>();
    expect(left.results.map((r) => r.hashtag)).toEqual(['iron']);
  });
});
