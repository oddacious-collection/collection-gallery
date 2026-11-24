/**
 * Serving public photo files (MED-10). Exported through `@cg/core/public`.
 *
 * A file is served only while ALL of these hold, checked on every request
 * (no edge caching in M1, D-45):
 * - the key is a known public variant (media_variants), never a master;
 * - its photo isn't removed;
 * - its item is publicly visible.
 * Anything else gets the same 404 as a key that never existed.
 *
 * Supports single-range `Range` requests (Safari needs them for video, M4)
 * and conditional requests (`If-None-Match` → 304).
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { RANDOM_KEY_PATTERN } from '../ids.ts';
import { publiclyVisible } from './items.ts';

/** Browsers may keep a file this long; hiding an item takes effect after it (≤ 60 s, MED-10). */
export const MEDIA_CACHE_CONTROL = 'public, max-age=60';

export type ByteRange = { offset: number; length: number } | { suffix: number };

/**
 * Parses a single `bytes=` range. Returns null for no/unsupported ranges
 * (serve the whole file) and 'invalid' for unsatisfiable ones (416).
 */
export function parseRange(header: string | null, size: number): ByteRange | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(header.trim());
  if (!m) return null; // multiple or malformed ranges: ignore, send everything
  const [, a = '', b = ''] = m;
  if (a === '' && b === '') return null;
  if (a === '') {
    const n = Number(b);
    if (n === 0) return 'invalid';
    return { suffix: Math.min(n, size) };
  }
  const start = Number(a);
  if (start >= size) return 'invalid';
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  if (end < start) return 'invalid';
  return { offset: start, length: end - start + 1 };
}

/** The public file response for `key`, or null for a 404. */
export async function servePublicMedia(
  d1: D1Database,
  bucket: R2Bucket,
  key: string,
  request: Request,
): Promise<Response | null> {
  if (!RANDOM_KEY_PATTERN.test(key)) return null;
  const db = drizzle(d1);
  const row = await db.get<{ format: string }>(sql`
    SELECT v.format AS format
    FROM media_variants v
    JOIN media m ON m.id = v.media_id
    JOIN items ON items.id = m.item_id
    WHERE v.key = ${key} AND m.deleted_at IS NULL AND ${publiclyVisible}
    LIMIT 1`);
  if (!row) return null;

  const head = await bucket.head(key);
  if (!head) return null;
  const etag = head.httpEtag;
  const headers = new Headers({
    'Content-Type': row.format,
    'Cache-Control': MEDIA_CACHE_CONTROL,
    'Accept-Ranges': 'bytes',
    ETag: etag,
  });
  const inm = request.headers.get('if-none-match');
  if (inm !== null && inm.split(',').some((t) => t.trim() === etag || t.trim() === '*')) {
    return new Response(null, { status: 304, headers });
  }

  const range = parseRange(request.headers.get('range'), head.size);
  if (range === 'invalid') {
    headers.set('Content-Range', `bytes */${head.size}`);
    return new Response(null, { status: 416, headers });
  }
  const isHead = request.method === 'HEAD';
  if (range === null) {
    headers.set('Content-Length', String(head.size));
    if (isHead) return new Response(null, { status: 200, headers });
    const obj = await bucket.get(key);
    if (!obj) return null;
    return new Response(obj.body, { status: 200, headers });
  }
  const offset = 'suffix' in range ? head.size - range.suffix : range.offset;
  const length = 'suffix' in range ? range.suffix : range.length;
  headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${head.size}`);
  headers.set('Content-Length', String(length));
  if (isHead) return new Response(null, { status: 206, headers });
  const obj = await bucket.get(key, { range: { offset, length } });
  if (!obj) return null;
  return new Response(obj.body, { status: 206, headers });
}
