/**
 * Backups (BAK-02 to BAK-06, D-47) against a fake Backblaze B2 that records
 * every request, with real D1 and R2 inside workerd.
 */
import { env } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createItem } from '../src/admin/items.ts';
import {
  B2Error,
  DAY_MS,
  isRetryable,
  retryPolicy,
  alertText,
  exportDatabase,
  exportableTables,
  gunzip,
  parseExport,
  runBackup,
  type BackupConfig,
} from '../src/backup/index.ts';
import { ACTOR } from './db-helpers.ts';

interface StoredFile {
  name: string;
  bucketId: string;
  bytes: Uint8Array;
  headers: Record<string, string>;
  hidden: boolean;
}

/** An in-memory B2 that speaks the few native-API calls the backup uses. */
class FakeB2 {
  files: StoredFile[] = [];
  calls: string[] = [];
  buckets = { 'db-bucket': 'bid-db', 'media-bucket': 'bid-media' } as Record<string, string>;
  /** Return true to answer this upload with a 524 timeout. */
  failUpload: (name: string) => boolean = () => false;

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const op = url.pathname.split('/').pop() ?? '';
    this.calls.push(op);
    if (op === 'b2_authorize_account') {
      return json({
        accountId: 'acct',
        authorizationToken: 'tok',
        apiInfo: { storageApi: { apiUrl: 'https://api.fake', downloadUrl: 'https://dl.fake' } },
      });
    }
    const body =
      init?.body && typeof init.body === 'string'
        ? (JSON.parse(init.body) as Record<string, string>)
        : {};
    if (op === 'b2_list_buckets') {
      const id = this.buckets[body['bucketName'] ?? ''];
      return json({ buckets: id ? [{ bucketId: id, bucketName: body['bucketName'] }] : [] });
    }
    if (op === 'b2_list_file_names') {
      const files = this.files
        .filter(
          (x) =>
            x.bucketId === body['bucketId'] && !x.hidden && x.name.startsWith(body['prefix'] ?? ''),
        )
        .map((x) => ({
          fileName: x.name,
          fileId: x.name,
          contentLength: x.bytes.length,
          uploadTimestamp: 0,
          action: 'upload',
        }));
      return json({ files, nextFileName: null });
    }
    if (op === 'b2_get_upload_url') {
      return json({
        uploadUrl: `https://up.fake/upload/${body['bucketId']}`,
        authorizationToken: 'up-tok',
      });
    }
    if (url.host === 'up.fake') {
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      const name = decodeURIComponent(headers['x-bz-file-name'] ?? '');
      if (this.failUpload(name)) {
        // What B2 sent on 2026-11-25: a 524 timeout with a non-JSON body.
        return new Response('<html>timeout</html>', { status: 524 });
      }
      const bytes = new Uint8Array(init?.body as Uint8Array);
      this.files.push({
        name: decodeURIComponent(headers['x-bz-file-name'] ?? ''),
        bucketId: url.pathname.split('/').pop() ?? '',
        bytes,
        headers,
        hidden: false,
      });
      return json({ fileId: `f${this.files.length}` });
    }
    if (op === 'b2_hide_file') {
      for (const x of this.files)
        if (x.bucketId === body['bucketId'] && x.name === body['fileName']) x.hidden = true;
      return json({ action: 'hide' });
    }
    return json({ code: 'bad_request', message: op }, 400);
  };

  named(prefix: string) {
    return this.files.filter((x) => x.name.startsWith(prefix));
  }
}

// No real waiting between retries in tests.
const realDelay = retryPolicy.baseDelayMs;
beforeAll(() => {
  retryPolicy.baseDelayMs = 0;
});
afterAll(() => {
  retryPolicy.baseDelayMs = realDelay;
});

const config: BackupConfig = {
  ENVIRONMENT: 'local',
  B2_KEY_ID: 'key-id-0000',
  B2_APP_KEY: 'app-key-0000',
  B2_DB_BUCKET: 'db-bucket',
  B2_MEDIA_BUCKET: 'media-bucket',
};

async function sha1(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes as Uint8Array<ArrayBuffer>));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('database export', () => {
  it('exports every real table (search index skipped, migrations kept) and round-trips', async () => {
    await createItem(env.DB, { title: 'Exported item' }, ACTOR);
    const tables = await exportableTables(env.DB);
    expect(tables).toContain('items');
    expect(tables).toContain('media');
    expect(tables).toContain('inbox_photos');
    expect(tables.some((t) => t.startsWith('search_index'))).toBe(false);
    expect(tables.some((t) => t.startsWith('_cf_') || t.startsWith('sqlite_'))).toBe(false);

    const data = await exportDatabase(env.DB, new Date('2026-12-01T03:30:00Z'));
    const items = data.tables['items'];
    expect(items?.columns).toContain('purchase_price_cents');
    const titleCol = items?.columns.indexOf('title') ?? -1;
    expect(items?.rows.some((r) => r[titleCol] === 'Exported item')).toBe(true);
    expect(parseExport(JSON.stringify(data)).exportedAt).toBe('2026-12-01T03:30:00.000Z');
    expect(() => parseExport('{"format":"other"}')).toThrow();
  });
});

describe('a backup run', () => {
  it('writes a locked, encrypted daily and monthly export once, and syncs media', async () => {
    const fake = new FakeB2();
    await env.MEDIA_PRIVATE.put('backuporig000000000000001', new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: 'image/jpeg' },
    });
    const now = new Date('2026-12-01T03:30:00Z');
    const report = await runBackup(config, env, 'full', now, fake.fetch);

    expect(report.db?.daily).toBe('daily/2026-12-01.json.gz');
    expect(report.db?.monthly).toBe('monthly/2026-12.json.gz');
    const [daily] = fake.named('daily/');
    expect(daily?.headers['x-bz-file-retention-mode']).toBe('governance');
    expect(Number(daily?.headers['x-bz-file-retention-retain-until-timestamp'])).toBe(
      now.getTime() + 30 * DAY_MS,
    );
    expect(daily?.headers['x-bz-server-side-encryption']).toBe('AES256');
    expect(daily?.headers['x-bz-content-sha1']).toBe(await sha1(daily?.bytes ?? new Uint8Array()));
    const [monthly] = fake.named('monthly/');
    expect(Number(monthly?.headers['x-bz-file-retention-retain-until-timestamp'])).toBe(
      now.getTime() + 365 * DAY_MS,
    );
    const restored = parseExport(await gunzip(daily?.bytes ?? new Uint8Array()));
    expect(Object.keys(restored.tables)).toContain('items');

    // Media: the original went to the media bucket, locked for a year.
    const media = fake.named('media-private/backuporig000000000000001');
    expect(media).toHaveLength(1);
    expect(media[0]?.bucketId).toBe('bid-media');
    expect(Number(media[0]?.headers['x-bz-file-retention-retain-until-timestamp'])).toBe(
      now.getTime() + 365 * DAY_MS,
    );

    // A second run the same day adds nothing to the database bucket.
    const again = await runBackup(
      config,
      env,
      'full',
      new Date('2026-12-01T09:00:00Z'),
      fake.fetch,
    );
    expect(again.db).toBeNull(); // nothing exported: today's copies exist
    expect(fake.named('daily/')).toHaveLength(1);
    // The job never asks B2 to delete anything.
    expect(fake.calls.some((c) => c.includes('delete'))).toBe(false);
  });

  it('hides the backup of a deleted original (kept as a prior version), never deletes', async () => {
    const fake = new FakeB2();
    const now = new Date('2026-12-02T03:30:00Z');
    for (let i = 0; i < 30; i++) {
      await env.MEDIA_PRIVATE.put(`keep${String(i).padStart(21, '0')}`, new Uint8Array([i]));
    }
    await env.MEDIA_PRIVATE.put('gonesoon00000000000000001', new Uint8Array([9]));
    await runBackup(config, env, 'media', now, fake.fetch);
    await env.MEDIA_PRIVATE.delete('gonesoon00000000000000001');
    const report = await runBackup(config, env, 'media', now, fake.fetch);
    expect(report.media.hidden).toBe(1);
    expect(
      fake.files.find((x) => x.name === 'media-private/gonesoon00000000000000001')?.hidden,
    ).toBe(true);
    expect(fake.calls.some((c) => c.includes('delete'))).toBe(false);
  });

  it('refuses to hide most of the backup when R2 suddenly lists far fewer files', async () => {
    const fake = new FakeB2();
    for (let i = 0; i < 100; i++) {
      fake.files.push({
        name: `media-private/other${String(i).padStart(20, '0')}`,
        bucketId: 'bid-media',
        bytes: new Uint8Array([1]),
        headers: {},
        hidden: false,
      });
    }
    await expect(runBackup(config, env, 'media', new Date(), fake.fetch)).rejects.toThrow(
      /refusing to hide/,
    );
    expect(fake.files.every((x) => !x.hidden)).toBe(true);
  });

  it('retries a B2 timeout (524) with a fresh upload URL, then succeeds', async () => {
    const fake = new FakeB2();
    let failures = 2;
    fake.failUpload = (name) => name.includes('retryme') && failures-- > 0;
    await env.MEDIA_PRIVATE.put('retryme000000000000000001', new Uint8Array([7]));
    const report = await runBackup(config, env, 'media', new Date(), fake.fetch);
    expect(report.media.failed).toBe(0);
    expect(fake.named('media-private/retryme000000000000000001')).toHaveLength(1);
    // Three attempts for this file, each with its own upload URL.
    const uploadUrlCalls = fake.calls.filter((c) => c === 'b2_get_upload_url').length;
    expect(uploadUrlCalls).toBeGreaterThanOrEqual(3);
  });

  it('a file that keeps failing does not stop the others; the run fails and alerts', async () => {
    const fake = new FakeB2();
    fake.failUpload = (name) => name.includes('alwaysbad');
    await env.MEDIA_PRIVATE.put('alwaysbad0000000000000001', new Uint8Array([1]));
    await env.MEDIA_PRIVATE.put('fineafter0000000000000001', new Uint8Array([2]));
    await expect(runBackup(config, env, 'media', new Date(), fake.fetch)).rejects.toThrow(
      /1 photo upload\(s\) failed after retries \(first: B2 524 unknown/,
    );
    expect(fake.named('media-private/fineafter0000000000000001')).toHaveLength(1);
    expect(fake.named('media-private/alwaysbad0000000000000001')).toHaveLength(0);

    // B2 recovers: the next run copies the file it missed.
    fake.failUpload = () => false;
    const next = await runBackup(config, env, 'media', new Date(), fake.fetch);
    expect(next.media.failed).toBe(0);
    expect(fake.named('media-private/alwaysbad0000000000000001')).toHaveLength(1);
  });

  it('does not retry errors that will not go away (bad key, bad request)', () => {
    expect(isRetryable(new B2Error(401, 'unauthorized', ''))).toBe(false);
    expect(isRetryable(new B2Error(400, 'bad_request', ''))).toBe(false);
    expect(isRetryable(new B2Error(503, 'service_unavailable', ''))).toBe(true);
    expect(isRetryable(new B2Error(524, 'unknown', ''))).toBe(true);
    expect(isRetryable(new B2Error(429, 'too_many_requests', ''))).toBe(true);
    expect(isRetryable(new TypeError('fetch failed'))).toBe(true);
  });

  it('fails clearly when a bucket is missing, and writes a plain alert', async () => {
    const fake = new FakeB2();
    fake.buckets = {};
    await expect(runBackup(config, env, 'full', new Date(), fake.fetch)).rejects.toThrow(/bucket/);
    const alert = alertText(
      'staging',
      'full',
      new Error('B2 403 unauthorized: nope'),
      new Date('2026-12-03T03:30:00Z'),
    );
    expect(alert.subject).toBe('[collection-gallery staging] backup FAILED (full)');
    expect(alert.text).toContain('B2 403 unauthorized');
    expect(alert.text).not.toContain(config.B2_APP_KEY);
  });
});

describe('restore', () => {
  it('an export restores exactly into an emptied database, search index rebuilt', async () => {
    const { createCategory } = await import('../src/admin/categories.ts');
    const { setItemCategories, setItemStatus } = await import('../src/admin/items.ts');
    const { restoreStatements, exportedMigrations, tableKeys, FOREIGN_KEYS_SQL, PRIMARY_KEYS_SQL } =
      await import('../src/backup/index.ts');
    // Some data with quotes, nesting, NULLs and a public item to index.
    const parent = await createCategory(
      env.DB,
      { name: "Collector's shelf", slug: `shelf-${Date.now()}` },
      ACTOR,
    );
    const child = await createCategory(
      env.DB,
      { name: 'Sub "quoted"', slug: `sub-${Date.now()}`, parentId: parent.id },
      ACTOR,
    );
    const it = await createItem(
      env.DB,
      { title: "O'Brien's meteorite", description: 'Line 1\nLine 2' },
      ACTOR,
    );
    await env.DB.prepare(
      `INSERT INTO media (id, item_id, position, is_cover, kind, original_key, width, height, created_at)
       VALUES ('01RESTRE0000000000000000M1', ?, 0, 1, 'image', 'restorekey00000000000000m1', 10, 10, '2026-01-01T00:00:00.000Z')`,
    )
      .bind(it.id)
      .run();
    await setItemCategories(env.DB, it.id, [child.id], ACTOR);
    await setItemStatus(env.DB, it.id, 'public', ACTOR);
    // Links that point "forward": the shelf moves under a category created
    // after it, and a category's cover points at media (which points at items).
    const { moveCategory } = await import('../src/admin/categories.ts');
    const newer = await createCategory(
      env.DB,
      { name: 'Newer room', slug: `room-${Date.now()}` },
      ACTOR,
    );
    await moveCategory(env.DB, parent.id, newer.id, ACTOR);
    await env.DB.prepare('UPDATE categories SET cover_media_id = ? WHERE id = ?')
      .bind('01RESTRE0000000000000000M1', newer.id)
      .run();

    const before = await exportDatabase(env.DB, new Date('2026-12-05T00:00:00Z'));
    expect(exportedMigrations(before).length).toBeGreaterThanOrEqual(4);
    const indexedBefore = await env.DB.prepare('SELECT count(*) AS n FROM search_index').first<{
      n: number;
    }>();

    // Empty every restored table (children first is irrelevant: FKs deferred).
    const statements = ['PRAGMA defer_foreign_keys = true;'];
    for (const name of Object.keys(before.tables)) {
      if (name !== 'd1_migrations') statements.push(`DELETE FROM "${name}";`);
    }
    statements.push('DELETE FROM search_index;');
    await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
    expect(
      (await env.DB.prepare('SELECT count(*) AS n FROM items').first<{ n: number }>())?.n,
    ).toBe(0);

    // One statement at a time, no deferred foreign keys: how D1's remote
    // import runs a file (the first drill failed on exactly this).
    const keys = tableKeys(
      (
        await env.DB.prepare(FOREIGN_KEYS_SQL).all<{
          tbl: string;
          col: string;
          ref: string;
          nn: number;
        }>()
      ).results,
      (await env.DB.prepare(PRIMARY_KEYS_SQL).all<{ tbl: string; col: string }>()).results,
    );
    expect(keys.foreignKeys.some((k) => k.table === 'categories' && k.column === 'parent_id')).toBe(
      true,
    );
    for (const s of restoreStatements(before, keys)) {
      for (const x of s.startsWith('DELETE FROM search_index;') ? s.split(';\n') : [s]) {
        if (x.trim()) await env.DB.prepare(x).run();
      }
    }
    const fkProblems = await env.DB.prepare('PRAGMA foreign_key_check').all();
    expect(fkProblems.results).toHaveLength(0);

    const after = await exportDatabase(env.DB, new Date('2026-12-05T00:00:00Z'));
    expect(after.tables).toEqual(before.tables);
    const indexedAfter = await env.DB.prepare('SELECT count(*) AS n FROM search_index').first<{
      n: number;
    }>();
    expect(indexedAfter?.n).toBe(indexedBefore?.n);
    const row = await env.DB.prepare('SELECT title, description FROM items WHERE id = ?')
      .bind(it.id)
      .first<{ title: string; description: string }>();
    expect(row).toEqual({ title: "O'Brien's meteorite", description: 'Line 1\nLine 2' });
  });
});
