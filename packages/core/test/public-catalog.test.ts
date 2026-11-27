/**
 * The public catalog (PUB-01/04/05/07/08/15, MED-10) and the search index's
 * privacy rule (INV-1). Real D1 and R2 inside workerd; data is created through
 * the admin data layer, exactly as the owner would.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createCategory, moveCategory, updateCategory } from '../src/admin/categories.ts';
import {
  createItem,
  restoreItem,
  setItemCategories,
  setItemStatus,
  setItemTags,
  trashItem,
  updateItem,
} from '../src/admin/items.ts';
import {
  beginUpload,
  finalizeUpload,
  removeMedia,
  setMediaAlt,
  storeUploadPart,
} from '../src/admin/media.ts';
import { purgeItemNow } from '../src/admin/purge.ts';
import {
  categoryCovers,
  contextPosition,
  getPublicItemDetail,
  listContextCards,
  listContextItems,
  listPublicCategories,
  parseRange,
  servePublicMedia,
  toFtsQuery,
} from '../src/public/index.ts';
import type { PlannedPart } from '../src/media/index.ts';
import { randomKey, ulid } from '../src/ids.ts';
import { ACTOR } from './db-helpers.ts';
import { makeJpeg, makeWebp } from './image-fixtures.ts';

let n = 0;
const uid = () => `${Date.now().toString(36)}${(n++).toString(36)}`;

async function addPhoto(itemId: string): Promise<string> {
  const { uploadId, parts } = await beginUpload(env.DB, itemId, { width: 1000, height: 800 });
  for (const p of parts as PlannedPart[]) {
    const bytes = p.format === 'image/jpeg' ? makeJpeg(p) : makeWebp(p);
    await storeUploadPart(env.DB, env, uploadId, p.name, bytes, 'Insignificant Nobody');
  }
  return (await finalizeUpload(env.DB, env, uploadId, '', ACTOR)).mediaId;
}

async function category(name: string, parentId: string | null = null) {
  return createCategory(
    env.DB,
    { name, slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${uid()}`, parentId },
    ACTOR,
  );
}

/** An item with a photo, filed in `categoryIds`, published unless `status` says otherwise. */
async function item(
  title: string,
  categoryIds: string[],
  opts: {
    tags?: string[];
    status?: 'public' | 'private' | 'draft';
    postedAt?: string;
    description?: string;
  } = {},
) {
  const row = await createItem(
    env.DB,
    {
      title,
      description: opts.description ?? '',
      ...(opts.postedAt ? { postedAt: opts.postedAt } : {}),
    },
    ACTOR,
  );
  const mediaId = await addPhoto(row.id);
  await setItemCategories(env.DB, row.id, categoryIds, ACTOR);
  if (opts.tags) await setItemTags(env.DB, row.id, opts.tags, ACTOR);
  if ((opts.status ?? 'public') !== 'draft')
    await setItemStatus(env.DB, row.id, opts.status ?? 'public', ACTOR);
  return { ...row, mediaId };
}

async function indexedIds(): Promise<string[]> {
  const { results } = await env.DB.prepare('SELECT item_id FROM search_index').all<{
    item_id: string;
  }>();
  return results.map((r) => r.item_id);
}

async function searchSlugs(q: string, category?: string): Promise<string[]> {
  const { cards } = await listContextCards(
    env.DB,
    { kind: 'search', q, ...(category ? { category } : {}) },
    0,
    100,
  );
  return cards.map((c) => c.slug);
}

describe('search index holds only public items (INV-1, PUB-08)', () => {
  it('follows every visibility change in the same transaction', async () => {
    const cat = await category('Index cat');
    const word = `zorbonite${uid()}`;
    const it = await item(`A ${word} specimen`, [cat.id], { status: 'draft' });
    expect(await indexedIds()).not.toContain(it.id);

    await setItemStatus(env.DB, it.id, 'public', ACTOR);
    expect(await indexedIds()).toContain(it.id);
    expect(await searchSlugs(word)).toEqual([it.slug]);

    await setItemStatus(env.DB, it.id, 'private', ACTOR);
    expect(await indexedIds()).not.toContain(it.id);
    expect(await searchSlugs(word)).toEqual([]);

    await setItemStatus(env.DB, it.id, 'public', ACTOR);
    await trashItem(env.DB, it.id, ACTOR);
    expect(await indexedIds()).not.toContain(it.id);
    await restoreItem(env.DB, it.id, ACTOR);
    expect(await indexedIds()).toContain(it.id);

    await setItemStatus(env.DB, it.id, 'draft', ACTOR);
    expect(await indexedIds()).not.toContain(it.id);
    await updateItem(env.DB, it.id, { kind: 'wishlist' }, ACTOR);
    await expect(setItemStatus(env.DB, it.id, 'public', ACTOR)).rejects.toThrow();
    expect(await indexedIds()).not.toContain(it.id);
    await updateItem(env.DB, it.id, { kind: 'owned' }, ACTOR);

    await setItemStatus(env.DB, it.id, 'public', ACTOR);
    await trashItem(env.DB, it.id, ACTOR);
    await restoreItem(env.DB, it.id, ACTOR);
    await trashItem(env.DB, it.id, ACTOR);
    await purgeItemNow(env.DB, env, it.id, ACTOR);
    expect(await indexedIds()).not.toContain(it.id);
  });

  it('indexes title, description, tags and every ancestor category name; never admin fields', async () => {
    const top = await category(`Meteorites ${uid()}`);
    const sub = await category(`Pallasites ${uid()}`, top.id);
    const secret = `secretprice${uid()}`;
    const it = await item('Seymchan slice', [sub.id], {
      tags: ['Olivine'],
      description: 'Etched **Widmanstätten** pattern',
    });
    await updateItem(
      env.DB,
      it.id,
      { sourceCaption: secret, purchaseCurrency: 'USD', purchasePriceCents: 4242 },
      ACTOR,
    );

    expect(await searchSlugs('olivine')).toContain(it.slug);
    expect(await searchSlugs('widmanstatten')).toContain(it.slug); // diacritics folded
    expect(await searchSlugs(top.name.split(' ')[0] ?? '')).toContain(it.slug);
    expect(await searchSlugs('seym')).toContain(it.slug); // prefix
    expect(await searchSlugs(secret)).toEqual([]);
    const row = await env.DB.prepare('SELECT * FROM search_index WHERE item_id = ?')
      .bind(it.id)
      .first<Record<string, string>>();
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(JSON.stringify(row)).not.toContain('4242');

    // Renaming or moving a category re-indexes the items under it.
    const renamed = `Stonyirons${uid()}`;
    await updateCategory(env.DB, top.id, { name: renamed }, ACTOR);
    expect(await searchSlugs(renamed)).toContain(it.slug);
    const other = await category(`Elsewhere${uid()}`);
    await moveCategory(env.DB, sub.id, other.id, ACTOR);
    expect(await searchSlugs(renamed)).not.toContain(it.slug);
    expect(await searchSlugs(other.name)).toContain(it.slug);

    // Scoped search: only items under the category.
    expect(await searchSlugs('olivine', other.slug)).toContain(it.slug);
    expect(await searchSlugs('olivine', top.slug)).toEqual([]);
  });

  it('turns visitor input into plain prefix words (no FTS syntax injection)', () => {
    expect(toFtsQuery('meteor  slice')).toBe('"meteor"* "slice"*');
    expect(toFtsQuery('title:x OR "y" NEAR(z) *')).toBe('"title"* "x"* "OR"* "y"* "NEAR"* "z"*');
    expect(toFtsQuery('  -- ;; ')).toBeNull();
    expect((toFtsQuery('a b c d e f g h i j') ?? '').split(' ')).toHaveLength(8);
  });
});

describe('categories and lists', () => {
  it('shows only categories with public items, counting subcategories', async () => {
    const top = await category(`Rocks ${uid()}`);
    const sub = await category(`Fossils ${uid()}`, top.id);
    const empty = await category(`Planned ${uid()}`);
    const hiddenOnly = await category(`Hidden ${uid()}`);
    await item('Ammonite', [sub.id]);
    await item('Trilobite', [sub.id]);
    await item('Private thing', [hiddenOnly.id], { status: 'private' });

    const cats = await listPublicCategories(env.DB);
    const bySlug = new Map(cats.map((c) => [c.slug, c]));
    expect(bySlug.get(top.slug)?.itemCount).toBe(2);
    expect(bySlug.get(sub.slug)).toMatchObject({ itemCount: 2, parentSlug: top.slug });
    expect(bySlug.has(empty.slug)).toBe(false);
    expect(bySlug.has(hiddenOnly.slug)).toBe(false);
    expect(
      (await categoryCovers(env.DB, [top.slug])).get(top.slug)?.sources.length,
    ).toBeGreaterThan(0);
  });

  it('lists a category with or without subcategories, newest first, never private items', async () => {
    const top = await category(`Books ${uid()}`);
    const sub = await category(`Signed ${uid()}`, top.id);
    const a = await item('Direct book', [top.id], { postedAt: '2026-01-01T00:00:00.000Z' });
    const b = await item('Signed book', [sub.id], { postedAt: '2026-02-01T00:00:00.000Z' });
    await item('Private book', [top.id], { status: 'private' });
    await item('Draft book', [sub.id], { status: 'draft' });

    const all = await listContextCards(
      env.DB,
      { kind: 'category', slug: top.slug, descendants: true },
      0,
      50,
    );
    expect(all.cards.map((c) => c.slug)).toEqual([b.slug, a.slug]);
    expect(all.total).toBe(2);
    const direct = await listContextCards(
      env.DB,
      { kind: 'category', slug: top.slug, descendants: false },
      0,
      50,
    );
    expect(direct.cards.map((c) => c.slug)).toEqual([a.slug]);

    expect(
      await contextPosition(
        env.DB,
        { kind: 'category', slug: top.slug, descendants: true },
        a.slug,
      ),
    ).toBe(1);
    expect(
      await contextPosition(
        env.DB,
        { kind: 'category', slug: top.slug, descendants: false },
        b.slug,
      ),
    ).toBeNull();

    const feed = await listContextItems(
      env.DB,
      { kind: 'category', slug: top.slug, descendants: true },
      1,
      5,
    );
    expect(feed.items.map((i) => i.slug)).toEqual([a.slug]);

    // Cards carry public data only: no internal IDs anywhere.
    const json = JSON.stringify(all);
    for (const id of [a.id, b.id, a.mediaId, b.mediaId]) expect(json).not.toContain(id);
  });
});

describe('item detail (PUB-04, PUB-15)', () => {
  it('has photos with alt fallback, category trails and tags; non-public items are null', async () => {
    const top = await category(`Coins ${uid()}`);
    const sub = await category(`Roman ${uid()}`, top.id);
    const it = await item('Denarius', [sub.id], { tags: ['Silver', 'Ancient'] });
    const second = await addPhoto(it.id);
    await setMediaAlt(env.DB, second, 'Reverse side', ACTOR);

    const d = await getPublicItemDetail(env.DB, it.slug);
    expect(d?.media.map((m) => m.alt)).toEqual(['Denarius', 'Reverse side']);
    expect(d?.media[0]?.sources.map((s) => s.width)).toEqual([400, 800, 1000]);
    expect(d?.media[0]?.og).toMatchObject({ width: 1000, height: 800 });
    expect(d?.categories).toEqual([
      {
        trail: [
          { slug: top.slug, name: top.name },
          { slug: sub.slug, name: sub.name },
        ],
      },
    ]);
    expect(d?.tags).toEqual(['Ancient', 'Silver']);

    await removeMedia(env.DB, second, ACTOR);
    expect((await getPublicItemDetail(env.DB, it.slug))?.media).toHaveLength(1);

    await setItemStatus(env.DB, it.id, 'private', ACTOR);
    expect(await getPublicItemDetail(env.DB, it.slug)).toBeNull();
    expect(await getPublicItemDetail(env.DB, 'Not A Slug!')).toBeNull();
  });

  it('includes videos as their poster plus the file, sound and captions (PUB-06)', async () => {
    const cat = await category(`Clips ${uid()}`);
    const it = await item('Spinning slice', [cat.id]);
    // A video row as the uploader leaves it (D-60), plus captions (D-65).
    const video = async (variants: Array<[string, number]>) => {
      const id = ulid();
      await env.DB.prepare(
        `INSERT INTO media (id, item_id, position, is_cover, kind, original_key, width, height,
           duration_s, has_audio, alt_text, created_at)
         VALUES (?, ?, 9, 0, 'video', ?, 640, 360, 20.4, 1, 'Turning slowly', ?)`,
      )
        .bind(id, it.id, randomKey(), new Date().toISOString())
        .run();
      for (const [role, width] of variants) {
        await env.DB.prepare(
          `INSERT INTO media_variants (key, media_id, role, width, height, format, bytes)
           VALUES (?, ?, ?, ?, ?, 'x', 1)`,
        )
          .bind(randomKey(), id, role, width, width ? Math.round((width * 9) / 16) : 0)
          .run();
      }
      return id;
    };
    await video([
      ['poster', 400],
      ['poster', 640],
      ['og', 640],
      ['video', 640],
      ['captions', 0],
    ]);
    // A video missing its file is left out rather than shown as a still.
    await video([['poster', 400]]);

    const d = await getPublicItemDetail(env.DB, it.slug);
    expect(d?.media).toHaveLength(2);
    const [photo, clip] = d?.media ?? [];
    expect(photo?.video).toBeNull();
    expect(clip?.alt).toBe('Turning slowly');
    expect(clip?.sources.map((s) => s.width)).toEqual([400, 640]);
    expect(clip?.og).toMatchObject({ width: 640 });
    expect(clip?.video).toMatchObject({ width: 640, height: 360, durationS: 20.4, hasAudio: true });
    expect(clip?.video?.captions).toMatch(/^[0-9a-z]{26}$/);
    expect(clip?.video?.key).not.toBe(clip?.video?.captions);
  });
});

describe('media serving (MED-10)', () => {
  async function keysOf(mediaId: string) {
    const { results } = await env.DB.prepare(
      'SELECT key, role FROM media_variants WHERE media_id = ? ORDER BY width',
    )
      .bind(mediaId)
      .all<{ key: string; role: string }>();
    const orig = await env.DB.prepare('SELECT original_key FROM media WHERE id = ?')
      .bind(mediaId)
      .first<{ original_key: string }>();
    return { variants: results, original: orig?.original_key ?? '' };
  }
  const get = (key: string, headers: Record<string, string> = {}, method = 'GET') =>
    servePublicMedia(
      env.DB,
      env.MEDIA_PUBLIC,
      key,
      new Request(`https://x/media/${key}`, { method, headers }),
    );

  it('serves public files with type, caching and ranges', async () => {
    const cat = await category('Media cat');
    const it = await item('Served', [cat.id]);
    const { variants } = await keysOf(it.mediaId);
    const key = variants[0]?.key ?? '';

    const full = await get(key);
    expect(full?.status).toBe(200);
    expect(full?.headers.get('content-type')).toBe('image/webp');
    expect(full?.headers.get('accept-ranges')).toBe('bytes');
    expect(full?.headers.get('cache-control')).toBe('public, max-age=60');
    const body = new Uint8Array(await (full as Response).arrayBuffer());

    const part = await get(key, { range: 'bytes=0-9' });
    expect(part?.status).toBe(206);
    expect(part?.headers.get('content-range')).toBe(`bytes 0-9/${body.length}`);
    expect(new Uint8Array(await (part as Response).arrayBuffer())).toEqual(body.subarray(0, 10));
    expect((await get(key, { range: `bytes=${body.length + 5}-` }))?.status).toBe(416);

    const etag = full?.headers.get('etag') ?? '';
    expect((await get(key, { 'if-none-match': etag }))?.status).toBe(304);
    expect((await get(key, {}, 'HEAD'))?.headers.get('content-length')).toBe(String(body.length));

    const og = variants.find((v) => v.role === 'og')?.key ?? '';
    expect((await get(og))?.headers.get('content-type')).toBe('image/jpeg');
  });

  it('answers 404 (null) for masters, removed photos and non-public items', async () => {
    const cat = await category('Media hidden');
    const it = await item('Hidden later', [cat.id]);
    const { variants, original } = await keysOf(it.mediaId);
    const key = variants[0]?.key ?? '';
    expect(await get(original)).toBeNull();
    expect(await get('x'.repeat(26))).toBeNull();
    expect(await get('../../etc/passwd')).toBeNull();

    for (const hide of [
      () => setItemStatus(env.DB, it.id, 'private', ACTOR),
      () => setItemStatus(env.DB, it.id, 'draft', ACTOR),
      () => trashItem(env.DB, it.id, ACTOR),
    ]) {
      await hide();
      expect(await get(key)).toBeNull();
      await restoreItem(env.DB, it.id, ACTOR);
      await setItemStatus(env.DB, it.id, 'public', ACTOR);
      expect((await get(key))?.status).toBe(200);
    }
    const extra = await addPhoto(it.id);
    const extraKey = (await keysOf(extra)).variants[0]?.key ?? '';
    expect((await get(extraKey))?.status).toBe(200);
    await removeMedia(env.DB, extra, ACTOR);
    expect(await get(extraKey)).toBeNull();
  });

  it('parses ranges strictly', () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange('bytes=0-', 100)).toEqual({ offset: 0, length: 100 });
    expect(parseRange('bytes=10-19', 100)).toEqual({ offset: 10, length: 10 });
    expect(parseRange('bytes=90-500', 100)).toEqual({ offset: 90, length: 10 });
    expect(parseRange('bytes=-20', 100)).toEqual({ suffix: 20 });
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(parseRange('bytes=100-', 100)).toBe('invalid');
    expect(parseRange('bytes=5-2', 100)).toBe('invalid');
    expect(parseRange('items=0-1', 100)).toBeNull();
  });
});
