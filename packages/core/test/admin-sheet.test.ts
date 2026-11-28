/**
 * The spreadsheet export and import (IMP-06, D-71; M2 step 6): export every
 * field, preview exactly what would change without writing, apply through
 * the normal item functions, and the column rules (only columns present are
 * applied, empty clears, unknown categories and the trash are refused).
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  createItem,
  getItem,
  listRevisions,
  setItemCategories,
  setItemStatus,
  setItemTags,
  trashItem,
  updateItem,
} from '../src/admin/items.ts';
import {
  SHEET_APPLY_BATCH,
  SHEET_BATCH,
  SHEET_COLUMNS,
  exportSheet,
  processSheetRows,
  type SheetRecord,
  type SheetRowsInput,
} from '../src/admin/sheet.ts';
import { LIST_SEPARATOR, readSheetCsv, writeCsv } from '../src/import/index.ts';
import { ACTOR, count, insertCategory, insertMedia } from './db-helpers.ts';

let n = 0;
const uniq = () => `${Date.now().toString(36)}${(n++).toString(36)}`;

async function category(parentId: string | null = null) {
  const slug = `cat-${uniq()}`;
  return { id: await insertCategory(slug, slug, parentId), slug };
}

async function item(title = `Item ${uniq()}`) {
  return createItem(env.DB, { title, description: 'Original.' }, ACTOR);
}

const one = async (
  mode: 'preview' | 'apply',
  columns: SheetRowsInput['columns'],
  cells: SheetRowsInput['rows'][number]['cells'],
) => {
  const [r] = await processSheetRows(env.DB, { mode, columns, rows: [{ line: 2, cells }] }, ACTOR);
  if (!r) throw new Error('no result');
  return r;
};

const record = async (id: string): Promise<SheetRecord> => {
  const r = (await exportSheet(env.DB)).find((x) => x.id === id);
  if (!r) throw new Error('not exported');
  return r;
};

describe('export', () => {
  it('has every column, admin fields included, categories as paths and tags by name', async () => {
    const parent = await category();
    const child = await category(parent.id);
    const it1 = await item();
    await updateItem(
      env.DB,
      it1.id,
      {
        purchasePriceCents: 1250,
        purchaseDate: '2024-05-31',
        openToParting: true,
        sourceCaption: 'Raw',
      },
      ACTOR,
    );
    await setItemCategories(env.DB, it1.id, [child.id], ACTOR);
    await setItemTags(env.DB, it1.id, ['Iron', 'Pallasite'], ACTOR);
    const r = await record(it1.id);
    expect(Object.keys(r)).toEqual([...SHEET_COLUMNS]);
    expect(r).toMatchObject({
      purchase_price_usd: '12.50',
      purchase_date: '2024-05-31',
      open_to_parting: 'yes',
      source_caption: 'Raw',
      categories: [`${parent.slug}/${child.slug}`],
      tags: ['Iron', 'Pallasite'],
      status: 'draft',
      watermark: 'inherit',
      license: '',
    });
  });

  it('leaves out items in the trash', async () => {
    const gone = await item();
    await trashItem(env.DB, gone.id, ACTOR);
    expect((await exportSheet(env.DB)).some((r) => r.id === gone.id)).toBe(false);
  });
});

describe('preview', () => {
  it('lists the changes without writing anything', async () => {
    const it1 = await item('Before');
    const revs = (await listRevisions(env.DB, it1.id)).length;
    const r = await one('preview', ['id', 'title', 'description'], {
      id: it1.id,
      title: 'After',
      description: 'Original.',
    });
    expect(r.action).toBe('update');
    expect(r.changes).toEqual([{ field: 'title', from: 'Before', to: 'After' }]);
    expect(r.applied).toBeUndefined();
    expect((await getItem(env.DB, it1.id)).title).toBe('Before');
    expect((await listRevisions(env.DB, it1.id)).length).toBe(revs);
  });

  it('finds no changes in an untouched export, also after a CSV round trip', async () => {
    const cat = await category();
    const it1 = await item();
    await updateItem(
      env.DB,
      it1.id,
      { description: '=1+1, "quoted"\nline two', purchasePriceCents: 500 },
      ACTOR,
    );
    await setItemCategories(env.DB, it1.id, [cat.id], ACTOR);
    await setItemTags(env.DB, it1.id, ['Stone'], ACTOR);
    await insertMedia(it1.id);
    await setItemStatus(env.DB, it1.id, 'public', ACTOR);
    const rec = await record(it1.id);
    const csv = writeCsv([
      [...SHEET_COLUMNS],
      SHEET_COLUMNS.map((c) => {
        const v = rec[c];
        return Array.isArray(v) ? v.join(LIST_SEPARATOR) : (v ?? '');
      }),
    ]);
    // As a spreadsheet saves it: line breaks inside cells become CRLF too.
    const file = readSheetCsv(csv.replace(/\n/g, '\r\n').replace(/\r\r\n/g, '\r\n'));
    expect(file.errors).toEqual([]);
    const [r] = await processSheetRows(
      env.DB,
      { mode: 'preview', columns: file.columns, rows: file.rows },
      ACTOR,
    );
    expect(r?.errors).toEqual([]);
    expect(r?.action).toBe('unchanged');
  });

  it('matches by slug when there is no id, and creates when nothing matches', async () => {
    const it1 = await item();
    const bySlug = await one('preview', ['slug', 'title'], { slug: it1.slug, title: 'Renamed' });
    expect(bySlug).toMatchObject({ action: 'update', itemId: it1.id });
    const fresh = await one('preview', ['slug', 'title'], {
      slug: `new-${uniq()}`,
      title: 'Brand new',
    });
    expect(fresh.action).toBe('create');
    expect(fresh.itemId).toBeUndefined();
    const untitled = await one('preview', ['slug'], { slug: `new-${uniq()}` });
    expect(untitled.errors).toContain('a new item needs a title');
  });

  it('refuses unknown IDs and categories, the trash, bad values and taken slugs', async () => {
    const it1 = await item();
    const other = await item();
    expect((await one('preview', ['id'], { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' })).errors[0]).toMatch(
      /no item with the ID/,
    );
    const bad = await one(
      'preview',
      [
        'id',
        'categories',
        'kind',
        'status',
        'license',
        'watermark',
        'posted_at',
        'purchase_price_usd',
        'purchase_date',
        'open_to_parting',
        'slug',
      ],
      {
        id: it1.id,
        categories: 'no/such-path',
        kind: 'borrowed',
        status: 'secret',
        license: 'gpl',
        watermark: 'sometimes',
        posted_at: 'yesterday-ish',
        purchase_price_usd: 'twelve',
        purchase_date: 'soon',
        open_to_parting: 'maybe',
        slug: 'Not A Slug',
      },
    );
    expect(bad.action).toBe('error');
    expect(bad.errors).toHaveLength(10);
    expect(bad.errors.join(' | ')).toMatch(/no category "no\/such-path"/);
    const taken = await one('preview', ['id', 'slug'], { id: it1.id, slug: other.slug });
    expect(taken.errors).toContain('that URL name is used by another item');
    await trashItem(env.DB, other.id, ACTOR);
    expect((await one('preview', ['id', 'title'], { id: other.id, title: 'x' })).errors).toContain(
      'this item is in the trash (restore it first)',
    );
  });

  it('checks the publish rules as they will be after the row', async () => {
    const it1 = await item();
    const cat = await category();
    const r = await one('preview', ['id', 'status', 'categories'], {
      id: it1.id,
      status: 'public',
      categories: cat.slug,
    });
    expect(r.errors).toEqual(['a public item needs a photo (add it in the editor first)']);
    await insertMedia(it1.id);
    expect(
      (await one('preview', ['id', 'status'], { id: it1.id, status: 'public' })).errors,
    ).toEqual(['a public item needs a category']);
    const wish = await one('preview', ['id', 'status', 'categories', 'kind'], {
      id: it1.id,
      status: 'public',
      categories: cat.slug,
      kind: 'wishlist',
    });
    expect(wish.errors).toEqual(['a wishlist item can’t be public']);
  });
});

describe('apply', () => {
  it('saves the changes through the item functions (revisions and audit kept)', async () => {
    const cat = await category();
    const it1 = await item();
    const revs = (await listRevisions(env.DB, it1.id)).length;
    const r = await one(
      'apply',
      [
        'id',
        'title',
        'categories',
        'tags',
        'purchase_price_usd',
        'purchase_date',
        'open_to_parting',
        'posted_at',
        'status',
      ],
      {
        id: it1.id,
        title: 'Applied',
        categories: [cat.slug],
        tags: 'Iron;  Rare ',
        purchase_price_usd: '$1,200.5',
        purchase_date: '2023-01-02',
        open_to_parting: 'TRUE',
        posted_at: '2020-03-04',
        status: 'private',
      },
    );
    expect(r).toMatchObject({ action: 'update', applied: true, errors: [] });
    const after = await getItem(env.DB, it1.id);
    expect(after).toMatchObject({
      title: 'Applied',
      categoryIds: [cat.id],
      purchasePriceCents: 120050,
      purchaseCurrency: 'USD',
      purchaseDate: '2023-01-02',
      openToParting: true,
      postedAt: '2020-03-04T00:00:00.000Z',
      status: 'private',
    });
    expect(after.tagNames).toEqual(['Iron', 'Rare']);
    expect((await listRevisions(env.DB, it1.id)).length).toBeGreaterThan(revs);
    expect(
      await count('audit_log', "target_id = ? AND action = 'item.update'", it1.id),
    ).toBeGreaterThan(0);
    // Applying the same row again changes nothing.
    expect(
      (
        await one('preview', ['id', 'title', 'tags'], {
          id: it1.id,
          title: 'Applied',
          tags: 'rare; iron',
        })
      ).action,
    ).toBe('unchanged');
  });

  it('only applies the columns in the file; an empty cell clears the field', async () => {
    const it1 = await item();
    await updateItem(env.DB, it1.id, { purchasePriceCents: 900 }, ACTOR);
    await one('apply', ['id', 'title'], { id: it1.id, title: 'Only the title' });
    let after = await getItem(env.DB, it1.id);
    expect(after.description).toBe('Original.');
    expect(after.purchasePriceCents).toBe(900);
    const r = await one('apply', ['id', 'description', 'purchase_price_usd'], {
      id: it1.id,
      description: '',
      purchase_price_usd: '',
    });
    expect(r.changes.map((c) => c.field)).toEqual(['description', 'purchase_price_usd']);
    after = await getItem(env.DB, it1.id);
    expect(after.description).toBe('');
    expect(after.purchasePriceCents).toBeNull();
    expect(after.purchaseCurrency).toBeNull();
    // A JSON record that leaves a field out (no cell) leaves it alone.
    await one('apply', ['id', 'title', 'description'], { id: it1.id, title: 'Kept description' });
    expect((await getItem(env.DB, it1.id)).description).toBe('');
  });

  it('refuses a required field being emptied', async () => {
    const it1 = await item();
    const r = await one('apply', ['id', 'title', 'slug'], { id: it1.id, title: ' ', slug: '' });
    expect(r.errors).toEqual(['title is empty', 'slug (URL name) is empty']);
    expect(r.applied).toBeUndefined();
  });

  it('creates new drafts, with the given URL name and categories', async () => {
    const cat = await category();
    const slug = `made-${uniq()}`;
    const r = await one('apply', ['slug', 'title', 'description', 'categories', 'status'], {
      slug,
      title: 'From a sheet',
      description: 'Typed in a spreadsheet.',
      categories: cat.slug,
      status: 'private',
    });
    expect(r).toMatchObject({ action: 'create', applied: true });
    const made = await getItem(env.DB, r.itemId ?? '');
    expect(made).toMatchObject({
      slug,
      title: 'From a sheet',
      status: 'private',
      categoryIds: [cat.id],
    });
    expect(made.importKey).toBeNull();
  });

  it('makes a public item private before removing its last category', async () => {
    const cat = await category();
    const it1 = await item();
    await setItemCategories(env.DB, it1.id, [cat.id], ACTOR);
    await insertMedia(it1.id);
    await setItemStatus(env.DB, it1.id, 'public', ACTOR);
    const r = await one('apply', ['id', 'categories', 'status', 'kind'], {
      id: it1.id,
      categories: '',
      status: 'private',
      kind: 'wishlist',
    });
    expect(r).toMatchObject({ applied: true, errors: [] });
    expect(await getItem(env.DB, it1.id)).toMatchObject({
      status: 'private',
      kind: 'wishlist',
      categoryIds: [],
    });
  });

  it('publishes once the categories are in place', async () => {
    const cat = await category();
    const it1 = await item();
    await insertMedia(it1.id);
    const r = await one('apply', ['id', 'status', 'categories'], {
      id: it1.id,
      status: 'public',
      categories: cat.slug,
    });
    expect(r).toMatchObject({ applied: true, errors: [] });
    expect((await getItem(env.DB, it1.id)).status).toBe('public');
  });

  it('handles each row on its own', async () => {
    const a = await item();
    const b = await item();
    const results = await processSheetRows(
      env.DB,
      {
        mode: 'apply',
        columns: ['id', 'title'],
        rows: [
          { line: 2, cells: { id: a.id, title: 'Fine' } },
          { line: 3, cells: { id: b.id, title: '' } },
        ],
      },
      ACTOR,
    );
    expect(results.map((r) => r.action)).toEqual(['update', 'error']);
    expect((await getItem(env.DB, a.id)).title).toBe('Fine');
  });

  it('ignores the read-only columns', async () => {
    const it1 = await item();
    const r = await one('apply', ['id', 'import_key', 'created_at', 'updated_at'], {
      id: it1.id,
      import_key: 'ig:1:abc',
      created_at: '2000-01-01',
      updated_at: '2000-01-01',
    });
    expect(r.action).toBe('unchanged');
    expect((await getItem(env.DB, it1.id)).importKey).toBeNull();
  });

  it('rejects oversized batches and unknown columns', async () => {
    const rows = Array.from({ length: 51 }, (_, i) => ({ line: i + 2, cells: { title: 'x' } }));
    await expect(
      processSheetRows(env.DB, { mode: 'preview', columns: ['title'], rows }, ACTOR),
    ).rejects.toThrow();
    await expect(
      processSheetRows(
        env.DB,
        {
          mode: 'preview',
          columns: ['title', 'secret' as never],
          rows: [{ line: 2, cells: { title: 'x' } }],
        },
        ACTOR,
      ),
    ).rejects.toThrow();
  });
});

/** env.DB, counting the D1 calls (a batch counts once, as Cloudflare counts it). */
function countingDb() {
  let calls = 0;
  const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(s, {
      get(t, p) {
        const v: unknown = Reflect.get(t, p, t);
        if (typeof v !== 'function') return v;
        const fn = v as (...a: unknown[]) => unknown;
        if (p === 'bind') return (...a: unknown[]) => wrap(fn.apply(t, a) as D1PreparedStatement);
        if (p === 'all' || p === 'run' || p === 'first' || p === 'raw') {
          return (...a: unknown[]) => {
            calls++;
            return fn.apply(t, a);
          };
        }
        return fn.bind(t);
      },
    });
  const db = new Proxy(env.DB, {
    get(t, p) {
      const v: unknown = Reflect.get(t, p, t);
      if (p === 'prepare') return (q: string) => wrap(t.prepare(q));
      if (p === 'batch' || p === 'exec') calls++;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  return { db, calls: () => calls };
}

describe('request size (D1 allows 1,000 queries per request)', () => {
  it('a full apply batch and a full preview batch stay well under the limit', async () => {
    const cat = await category();
    const rows = [];
    for (let i = 0; i < SHEET_BATCH; i++) {
      const it1 = await item();
      await insertMedia(it1.id);
      rows.push({
        line: i + 2,
        cells: {
          id: it1.id,
          title: `Busy ${i}`,
          description: 'Changed.',
          categories: [cat.slug],
          tags: `a${i}; b${i}; c${i}`,
          purchase_price_usd: '10',
          status: 'public',
        },
      });
    }
    const columns: SheetRowsInput['columns'] = [
      'id',
      'title',
      'description',
      'categories',
      'tags',
      'purchase_price_usd',
      'status',
    ];
    const preview = countingDb();
    await processSheetRows(preview.db, { mode: 'preview', columns, rows }, ACTOR);
    expect(preview.calls()).toBeLessThan(300);

    const apply = countingDb();
    const results = await processSheetRows(
      apply.db,
      { mode: 'apply', columns, rows: rows.slice(0, SHEET_APPLY_BATCH) },
      ACTOR,
    );
    expect(results.every((r) => r.applied)).toBe(true);
    // About 18 per row: 10 rows ≈ 180. 50 rows came to ~900, which is why
    // apply requests are smaller.
    expect(apply.calls()).toBeLessThan(400);
  });

  it('refuses an apply request with more rows than SHEET_APPLY_BATCH', async () => {
    const rows = Array.from({ length: SHEET_APPLY_BATCH + 1 }, (_, i) => ({
      line: i + 2,
      cells: { title: 'x' },
    }));
    await expect(
      processSheetRows(env.DB, { mode: 'apply', columns: ['title'], rows }, ACTOR),
    ).rejects.toThrow();
    expect(
      await processSheetRows(env.DB, { mode: 'preview', columns: ['title'], rows }, ACTOR),
    ).toHaveLength(SHEET_APPLY_BATCH + 1);
  });
});
