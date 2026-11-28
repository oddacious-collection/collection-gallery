/**
 * Reviewing imported drafts (IMP-04, D-62; M2 step 5): the queue and its
 * views, save / publish / trash and next, hashtag rules applied in batches,
 * bulk actions.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { startImportedItem, type ImportedItemInput } from '../src/admin/import.ts';
import { getItem } from '../src/admin/items.ts';
import {
  APPLY_BATCH,
  applyHashtagRules,
  bulkItems,
  hashtagOverview,
  repeatSiblings,
  reviewFlags,
  reviewQueue,
  saveReview,
  setHashtagRule,
} from '../src/admin/review.ts';
import { ACTOR, insertCategory, insertMedia } from './db-helpers.ts';

let n = 0;
const uniq = () => `${Date.now().toString(36)}${(n++).toString(36)}`;

async function imported(
  over: Partial<ImportedItemInput> & { postedAt?: string } = {},
): Promise<string> {
  const ts = 1_600_000_000 + n++;
  const { itemId } = await startImportedItem(
    env.DB,
    {
      importKey: `ig:${ts}:${'d'.repeat(64)}`,
      title: `Imported ${uniq()}`,
      description: 'From Instagram.',
      postedAt: over.postedAt ?? new Date(ts * 1000).toISOString(),
      sourceCaption: 'Caption',
      suggestedTags: over.suggestedTags ?? [],
      review: over.review ?? { action: 'import', titleConfidence: 'high', mentionsRemoved: 0 },
    },
    ACTOR,
  );
  return itemId;
}

const clearQueue = () =>
  env.DB.prepare(
    "UPDATE items SET import_review = json_set(import_review, '$.reviewed', 1) WHERE import_key IS NOT NULL",
  ).run();

describe('review queue', () => {
  it('shows unreviewed imported drafts newest first, with flagged and repeats views', async () => {
    await clearQueue();
    const old = await imported({ postedAt: '2016-01-01T00:00:00.000Z' });
    const flagged = await imported({
      postedAt: '2018-01-01T00:00:00.000Z',
      review: { action: 'maybe-skip', titleConfidence: 'high', mentionsRemoved: 0, note: 'Hmm' },
    });
    const repeat = await imported({
      postedAt: '2017-01-01T00:00:00.000Z',
      review: {
        action: 'import',
        titleConfidence: 'high',
        mentionsRemoved: 0,
        duplicateGroup: 'grp',
      },
    });
    const twin = await imported({
      postedAt: '2015-01-01T00:00:00.000Z',
      review: {
        action: 'import',
        titleConfidence: 'high',
        mentionsRemoved: 0,
        duplicateGroup: 'grp',
      },
    });

    const all = await reviewQueue(env.DB, 'all');
    expect(all.counts).toEqual({ all: 4, flagged: 3, repeats: 2 });
    expect(all.nextId).toBe(flagged);
    // Skipping walks on in the same order.
    expect((await reviewQueue(env.DB, 'all', flagged)).nextId).toBe(repeat);
    expect((await reviewQueue(env.DB, 'all', repeat)).nextId).toBe(old);
    expect((await reviewQueue(env.DB, 'all', twin)).nextId).toBeNull();
    expect((await reviewQueue(env.DB, 'repeats')).nextId).toBe(repeat);
    expect((await repeatSiblings(env.DB, repeat, 'grp')).map((s) => s.id)).toEqual([twin]);
    expect((await reviewFlags(env.DB, flagged))?.note).toBe('Hmm');
  });

  it('saves and publishes; a blocked publish keeps it in the queue with the reasons', async () => {
    await clearQueue();
    const id = await imported();
    const cat = await insertCategory('Meteorites', `meteorites-${uniq()}`);
    const blocked = await saveReview(
      env.DB,
      id,
      {
        title: 'Gibeon - Iron, IVA',
        description: 'Etched slice.',
        categoryIds: [cat],
        tags: ['Iron'],
        then: 'publish',
      },
      ACTOR,
    );
    expect(blocked).toEqual({ published: false, reasons: ['needs_media'] });
    // Saved anyway, but still waiting for review.
    expect((await getItem(env.DB, id)).title).toBe('Gibeon - Iron, IVA');
    expect((await reviewQueue(env.DB)).nextId).toBe(id);

    await insertMedia(id);
    const ok = await saveReview(
      env.DB,
      id,
      {
        title: 'Gibeon - Iron, IVA',
        description: 'Etched slice.',
        categoryIds: [cat],
        tags: ['Iron', 'Namibia'],
        then: 'publish',
      },
      ACTOR,
    );
    expect(ok).toEqual({ published: true });
    const item = await getItem(env.DB, id);
    expect(item).toMatchObject({ status: 'public', categoryIds: [cat] });
    expect(item.tagNames.sort()).toEqual(['Iron', 'Namibia']);
    // Publishing keeps the Instagram date as the posted date.
    expect(item.postedAt?.startsWith('20')).toBe(true);
    expect((await reviewQueue(env.DB)).nextId).toBeNull();
  });

  it('saves as a draft or trashes, and either leaves the queue', async () => {
    await clearQueue();
    const keep = await imported();
    const bin = await imported();
    const base = { title: 'Kept', description: '', categoryIds: [], tags: [] };
    await saveReview(env.DB, keep, { ...base, then: 'save' }, ACTOR);
    await saveReview(env.DB, bin, { ...base, then: 'trash' }, ACTOR);
    expect((await getItem(env.DB, keep)).status).toBe('draft');
    expect((await getItem(env.DB, bin)).deletedAt).not.toBeNull();
    expect((await reviewQueue(env.DB)).counts.all).toBe(0);
    expect(await reviewFlags(env.DB, keep)).toMatchObject({ action: 'import' });
  });
});

describe('hashtag rules (D-62 (3))', () => {
  it('counts hashtags, sets and removes rules, and applies them in batches', async () => {
    const word = `zz${uniq()}`;
    const ids: string[] = [];
    for (let i = 0; i < APPLY_BATCH + 3; i++) {
      ids.push(await imported({ suggestedTags: [word, 'common'] }));
    }
    const other = await imported({ suggestedTags: ['unrelated'] });
    const { rows } = await hashtagOverview(env.DB, { q: `#${word}` });
    expect(rows).toEqual([
      {
        hashtag: word,
        items: APPLY_BATCH + 3,
        categoryId: null,
        categoryName: null,
        tagName: null,
      },
    ]);

    const cat = await insertCategory('Pallasites', `pallasites-${uniq()}`);
    await setHashtagRule(
      env.DB,
      { hashtag: `#${word.toUpperCase()}`, categoryId: cat, tagName: 'Olivine' },
      ACTOR,
    );
    expect((await hashtagOverview(env.DB, { q: word })).rows[0]).toMatchObject({
      categoryId: cat,
      categoryName: 'Pallasites',
      tagName: 'Olivine',
    });

    let cursor: string | null = null;
    let changed = 0;
    let rounds = 0;
    do {
      const r = await applyHashtagRules(env.DB, ACTOR, cursor);
      changed += r.changed;
      cursor = r.nextCursor;
      rounds++;
    } while (cursor && rounds < 100);
    expect(changed).toBe(APPLY_BATCH + 3);
    for (const id of ids.slice(0, 3)) {
      const item = await getItem(env.DB, id);
      expect(item.categoryIds).toContain(cat);
      expect(item.tagNames).toContain('Olivine');
    }
    expect((await getItem(env.DB, other)).categoryIds).not.toContain(cat);

    // Applying again changes nothing; removing the rule keeps what was added.
    let again = 0;
    cursor = null;
    do {
      const r = await applyHashtagRules(env.DB, ACTOR, cursor);
      again += r.changed;
      cursor = r.nextCursor;
    } while (cursor);
    expect(again).toBe(0);
    await setHashtagRule(env.DB, { hashtag: word, categoryId: null, tagName: null }, ACTOR);
    expect((await hashtagOverview(env.DB, { q: word })).rows[0]?.categoryId).toBeNull();
    expect((await getItem(env.DB, ids[0] ?? '')).categoryIds).toContain(cat);
  });
});

describe('bulk actions', () => {
  it('publishes what it can, reports the rest, adds categories and trashes', async () => {
    const cat = await insertCategory('Books', `books-${uniq()}`);
    const ready = await imported();
    const notReady = await imported();
    await insertMedia(ready);
    await bulkItems(
      env.DB,
      { ids: [ready, notReady], action: 'add-category', categoryId: cat },
      ACTOR,
    );
    expect((await getItem(env.DB, notReady)).categoryIds).toEqual([cat]);
    const res = await bulkItems(env.DB, { ids: [ready, notReady], action: 'publish' }, ACTOR);
    expect(res).toEqual([
      { id: ready, ok: true },
      { id: notReady, ok: false, reasons: ['needs_media'] },
    ]);
    await bulkItems(env.DB, { ids: [notReady], action: 'trash' }, ACTOR);
    expect((await getItem(env.DB, notReady)).deletedAt).not.toBeNull();
    await expect(
      bulkItems(env.DB, { ids: [ready], action: 'add-category' }, ACTOR),
    ).rejects.toThrow();
  });
});
