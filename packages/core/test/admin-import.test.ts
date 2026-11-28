/**
 * The importer's server side (IMP-01, IMP-03; D-70): a post becomes a draft
 * once; re-runs resume it and skip files it already has; a trashed draft is
 * left alone; finalize records each file's source hash.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { importReviewOf, startImportedItem, type ImportedItemInput } from '../src/admin/import.ts';
import { trashItem } from '../src/admin/items.ts';
import { beginUpload, finalizeUpload, storeUploadPart } from '../src/admin/media.ts';
import type { PlannedPart } from '../src/media/index.ts';
import { ACTOR } from './db-helpers.ts';
import { makeJpeg, makeWebp } from './image-fixtures.ts';

let n = 0;
const post = (over: Partial<ImportedItemInput> = {}): ImportedItemInput => ({
  importKey: `ig:${1_700_000_000 + n++}:${'a'.repeat(64)}`,
  title: 'Tagish Lake - C2 Ungrouped',
  description: 'A piece of the \\*carbon-rich\\* meteorite.',
  postedAt: '2016-07-14T12:00:00.000Z',
  sourceCaption: 'A piece of the *carbon-rich* meteorite. #meteorite #space',
  suggestedTags: ['meteorite', 'space'],
  review: { action: 'import', titleConfidence: 'high', mentionsRemoved: 0 },
  ...over,
});

async function addPhoto(itemId: string, sourceHash: string): Promise<void> {
  const { uploadId, parts } = await beginUpload(env.DB, itemId, { width: 1000, height: 800 });
  for (const p of parts as PlannedPart[]) {
    const bytes = p.format === 'image/jpeg' ? makeJpeg(p) : makeWebp(p);
    await storeUploadPart(env.DB, env, uploadId, p.name, bytes, 'Insignificant Nobody');
  }
  await finalizeUpload(env.DB, env, uploadId, '', ACTOR, new Date(), { sourceHash });
}

describe('importing a post (D-70)', () => {
  it('creates a draft once, with its key, flags and caption; re-runs resume it', async () => {
    const input = post({
      review: {
        action: 'maybe-skip',
        titleConfidence: 'low',
        note: 'Not sure this is an object.',
        duplicateGroup: 'amber-spider-fly',
        mentionsRemoved: 2,
      },
    });
    const first = await startImportedItem(env.DB, input, ACTOR);
    expect(first).toMatchObject({ status: 'created', sourceHashes: [] });

    const row = await env.DB.prepare(
      'SELECT status, title, posted_at, import_key, source_caption, suggested_tags, import_review FROM items WHERE id = ?',
    )
      .bind(first.itemId)
      .first<Record<string, string>>();
    expect(row).toMatchObject({
      status: 'draft',
      title: 'Tagish Lake - C2 Ungrouped',
      posted_at: '2016-07-14T12:00:00.000Z',
      import_key: input.importKey,
      source_caption: input.sourceCaption,
    });
    expect(JSON.parse(String(row?.['suggested_tags']))).toEqual(['meteorite', 'space']);
    expect(importReviewOf({ importReview: row?.['import_review'] ?? null })).toEqual(input.review);
    // The normal create path: a revision and an audit entry.
    const rev = await env.DB.prepare('SELECT count(*) AS n FROM item_revisions WHERE item_id = ?')
      .bind(first.itemId)
      .first<{ n: number }>();
    expect(rev?.n).toBe(1);

    // Files land with their source hashes; a re-run sees them.
    await addPhoto(first.itemId, 'b'.repeat(64));
    await addPhoto(first.itemId, 'c'.repeat(64));
    const again = await startImportedItem(env.DB, input, ACTOR);
    expect(again.itemId).toBe(first.itemId);
    expect(again.status).toBe('existing');
    expect(again.sourceHashes.sort()).toEqual(['b'.repeat(64), 'c'.repeat(64)]);
    const items = await env.DB.prepare('SELECT count(*) AS n FROM items WHERE import_key = ?')
      .bind(input.importKey)
      .first<{ n: number }>();
    expect(items?.n).toBe(1);
  });

  it('leaves a draft the owner moved to the trash alone', async () => {
    const input = post();
    const { itemId } = await startImportedItem(env.DB, input, ACTOR);
    await trashItem(env.DB, itemId, ACTOR);
    expect(await startImportedItem(env.DB, input, ACTOR)).toMatchObject({
      itemId,
      status: 'trashed',
    });
  });

  it('refuses bad keys, skip entries and unknown fields', async () => {
    await expect(startImportedItem(env.DB, post({ importKey: 'ig:1:abc' }), ACTOR)).rejects.toThrow(
      ZodError,
    );
    await expect(
      startImportedItem(
        env.DB,
        post({
          review: { action: 'skip' as 'import', titleConfidence: 'high', mentionsRemoved: 0 },
        }),
        ACTOR,
      ),
    ).rejects.toThrow(ZodError);
    await expect(
      startImportedItem(env.DB, { ...post(), status: 'public' } as ImportedItemInput, ACTOR),
    ).rejects.toThrow(ZodError);
  });
});
