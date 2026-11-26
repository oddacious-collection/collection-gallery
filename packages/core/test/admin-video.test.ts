/**
 * Video uploads (D-60): begin, chunks into R2 multipart uploads with the
 * header checked before anything is stored, poster files checked like
 * photos, finalize, public serving with Range requests, cleanup.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { DomainError } from '../src/admin/domain-error.ts';
import { createItem, setItemCategories, setItemStatus } from '../src/admin/items.ts';
import {
  VIDEO_CHUNK_BYTES,
  beginVideoUpload,
  cleanupStaleUploads,
  finalizeUpload,
  storeUploadPart,
  storeVideoChunk,
  type VideoUploadPart,
} from '../src/admin/media.ts';
import { verifyMp4Header } from '../src/media/mp4.ts';
import { servePublicMedia } from '../src/public/media.ts';
import { ACTOR, count, insertCategory } from './db-helpers.ts';
import { makeJpeg, makeWebp } from './image-fixtures.ts';
import { makeMp4, type Make } from './video-fixtures.ts';

const OWNER = 'Insignificant Nobody';

async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    if (err instanceof DomainError) return { code: err.code, ...err.details };
    throw err;
  }
  return 'no error';
}

interface Video {
  itemId: string;
  uploadId: string;
  parts: VideoUploadPart[];
  master: Uint8Array;
  pub: Uint8Array;
}

async function begin(
  make: Make = {},
  declare: Partial<Record<string, unknown>> = {},
): Promise<Video> {
  const master = await makeMp4(make);
  const pub = await makeMp4(make);
  // What the uploader would declare (the file itself may be a bad one on purpose).
  const plain: Make = { ...make };
  delete plain.title;
  const clean = await makeMp4(plain);
  const info = verifyMp4Header(clean, clean.length);
  const item = await createItem(env.DB, { title: `Clip ${Math.random()}` }, ACTOR);
  const { uploadId, parts } = await beginVideoUpload(env.DB, env, item.id, {
    width: info.width,
    height: info.height,
    durationS: info.durationS,
    hasAudio: info.hasAudio,
    masterBytes: master.length,
    videoBytes: pub.length,
    ...declare,
  });
  return { itemId: item.id, uploadId, parts, master, pub };
}

async function sendChunks(v: Video, name: 'original' | 'video'): Promise<void> {
  const file = name === 'original' ? v.master : v.pub;
  for (let n = 0; n * VIDEO_CHUNK_BYTES < file.length; n++) {
    await storeVideoChunk(
      env.DB,
      env,
      v.uploadId,
      name,
      n,
      file.slice(n * VIDEO_CHUNK_BYTES, (n + 1) * VIDEO_CHUNK_BYTES),
    );
  }
}

async function sendPosters(v: Video): Promise<void> {
  for (const p of v.parts.filter((x) => x.format !== 'video/mp4')) {
    const file =
      p.format === 'image/jpeg'
        ? makeJpeg({ width: p.width, height: p.height })
        : makeWebp({ width: p.width, height: p.height });
    await storeUploadPart(env.DB, env, v.uploadId, p.name, file, OWNER);
  }
}

describe('video uploads (D-60)', () => {
  it('stores a multi-chunk video, its master and poster, and serves it publicly with Range', async () => {
    // ~10 MB: two chunks per file.
    const v = await begin({ seconds: 2, frameBytes: 170_000 });
    const names = v.parts.map((p) => p.name);
    expect(names).toContain('original');
    expect(names).toContain('video');
    expect(names).toContain('og');
    expect(names.some((n) => n.startsWith('poster-w'))).toBe(true);
    const videoPart = v.parts.find((p) => p.name === 'video');
    expect(videoPart?.chunks).toBe(2);
    // Storage keys never go to the browser.
    expect(JSON.stringify(v.parts)).not.toMatch(/"key"|multipart/i);

    await sendChunks(v, 'original');
    await sendChunks(v, 'video');
    await sendPosters(v);
    const { mediaId } = await finalizeUpload(env.DB, env, v.uploadId, 'A clip', ACTOR);

    const row = await env.DB.prepare(
      'SELECT kind, original_key, width, height, has_audio, duration_s FROM media WHERE id = ?',
    )
      .bind(mediaId)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({ kind: 'video', width: 1920, height: 1080, has_audio: 1 });
    expect(Number(row?.['duration_s'])).toBeCloseTo(2, 0);
    // The master is private, whole and byte-identical.
    const master = await env.MEDIA_PRIVATE.get(String(row?.['original_key']));
    expect(new Uint8Array((await master?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(v.master);
    expect(await env.MEDIA_PUBLIC.head(String(row?.['original_key']))).toBeNull();
    expect(await count('media_variants', 'media_id = ? AND role = ?', mediaId, 'video')).toBe(1);
    expect(
      await count('media_variants', 'media_id = ? AND role = ?', mediaId, 'poster'),
    ).toBeGreaterThan(0);
    expect(await count('media_uploads', 'id = ?', v.uploadId)).toBe(0);
    expect(await count('media_upload_chunks', 'upload_id = ?', v.uploadId)).toBe(0);

    // Public only once the item is public; then Range works (Safari).
    const key = (
      await env.DB.prepare("SELECT key FROM media_variants WHERE media_id = ? AND role = 'video'")
        .bind(mediaId)
        .first<{ key: string }>()
    )?.key as string;
    const get = (headers: HeadersInit = {}) =>
      servePublicMedia(
        env.DB,
        env.MEDIA_PUBLIC,
        key,
        new Request(`https://x/media/${key}`, { headers }),
      );
    expect(await get()).toBeNull();
    const cat = await insertCategory('Clips', `clips-${Date.now()}`);
    await setItemCategories(env.DB, v.itemId, [cat], ACTOR);
    await setItemStatus(env.DB, v.itemId, 'public', ACTOR);
    const part = await get({ range: 'bytes=0-99' });
    expect(part?.status).toBe(206);
    expect(part?.headers.get('content-type')).toBe('video/mp4');
    expect(part?.headers.get('content-range')).toBe(`bytes 0-99/${v.pub.length}`);
    expect((await part?.arrayBuffer())?.byteLength).toBe(100);
  });

  it('refuses a header with metadata before storing anything', async () => {
    const v = await begin({ title: 'SENTINEL-TITLE' });
    expect(
      await failure(storeVideoChunk(env.DB, env, v.uploadId, 'video', 0, v.pub)),
    ).toMatchObject({
      code: 'invalid',
      reason: 'video_has_metadata',
    });
    expect(await count('media_upload_chunks', 'upload_id = ?', v.uploadId)).toBe(0);
    await sendChunks(v, 'original').catch(() => undefined);
    await sendPosters(v);
    expect(await failure(finalizeUpload(env.DB, env, v.uploadId, '', ACTOR))).toMatchObject({
      code: 'conflict',
      reasons: ['missing_files'],
    });
  });

  it('refuses a file that is not what was declared, wrong chunk sizes, and photo-style uploads', async () => {
    const v = await begin({}, { width: 1280, height: 720 });
    expect(
      await failure(storeVideoChunk(env.DB, env, v.uploadId, 'video', 0, v.pub)),
    ).toMatchObject({
      reason: 'video_not_as_declared',
    });
    const w = await begin();
    expect(
      await failure(storeVideoChunk(env.DB, env, w.uploadId, 'video', 0, w.pub.slice(1))),
    ).toMatchObject({ reason: 'chunk_wrong_size' });
    expect(
      await failure(storeVideoChunk(env.DB, env, w.uploadId, 'video', 1, w.pub)),
    ).toMatchObject({
      code: 'not_found',
    });
    expect(
      await failure(storeUploadPart(env.DB, env, w.uploadId, 'video', w.pub, OWNER)),
    ).toMatchObject({
      reason: 'video_sent_in_chunks',
    });
    // Over the limits at the start.
    // (Rejected by the request schema; the API answers 400.)
    await expect(begin({}, { durationS: 121 })).rejects.toThrow();
    await expect(begin({}, { width: 3840, height: 2160 })).rejects.toThrow();
    await expect(begin({}, { width: 1920, height: 1440 })).rejects.toThrow(DomainError);
  });

  it('cleans up an abandoned video upload after a day, chunks included', async () => {
    const v = await begin();
    await storeVideoChunk(env.DB, env, v.uploadId, 'video', 0, v.pub);
    expect(await count('media_upload_chunks', 'upload_id = ?', v.uploadId)).toBe(1);
    const later = new Date(Date.now() + 25 * 3600 * 1000);
    expect(await cleanupStaleUploads(env.DB, env, later)).toBeGreaterThan(0);
    expect(await count('media_uploads', 'id = ?', v.uploadId)).toBe(0);
    expect(await count('media_upload_chunks', 'upload_id = ?', v.uploadId)).toBe(0);
  });
});
