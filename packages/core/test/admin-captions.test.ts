/**
 * Captions for a video (MED-12, D-65): the file as uploaded stays private,
 * the rebuilt WebVTT is public only while the item is publicly visible, and
 * replace/remove/purge leave no files behind.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { getCaptionsSource, removeVideoCaptions, setVideoCaptions } from '../src/admin/captions.ts';
import { DomainError } from '../src/admin/domain-error.ts';
import { createItem, setItemCategories, setItemStatus } from '../src/admin/items.ts';
import { listItemMedia, removeMedia } from '../src/admin/media.ts';
import { ulid, randomKey } from '../src/ids.ts';
import { servePublicMedia } from '../src/public/media.ts';
import { ACTOR, count, insertCategory, insertMedia } from './db-helpers.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const FILE = 'WEBVTT\n\nNOTE caption-sentinel-note\n\n00:01.000 --> 00:02.000\nHello\n';

async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    if (err instanceof DomainError) return { code: err.code, ...err.details };
    throw err;
  }
  return 'no error';
}

async function video(): Promise<{ itemId: string; mediaId: string }> {
  const item = await createItem(env.DB, { title: `Captioned ${Math.random()}` }, ACTOR);
  const mediaId = ulid();
  await env.DB.prepare(
    `INSERT INTO media (id, item_id, position, is_cover, kind, original_key, width, height,
       duration_s, has_audio, created_at)
     VALUES (?, ?, 0, 1, 'video', ?, 1280, 720, 10, 1, ?)`,
  )
    .bind(mediaId, item.id, randomKey(), new Date().toISOString())
    .run();
  return { itemId: item.id, mediaId };
}

async function captionKeys(mediaId: string): Promise<{ priv: string | null; pub: string[] }> {
  const row = await env.DB.prepare('SELECT captions_key AS k FROM media WHERE id = ?')
    .bind(mediaId)
    .first<{ k: string | null }>();
  const pub = await env.DB.prepare(
    "SELECT key FROM media_variants WHERE media_id = ? AND role = 'captions'",
  )
    .bind(mediaId)
    .all<{ key: string }>();
  return { priv: row?.k ?? null, pub: pub.results.map((r) => r.key) };
}

const get = (key: string) =>
  servePublicMedia(env.DB, env.MEDIA_PUBLIC, key, new Request(`https://x.test/media/${key}`));

describe('video captions (MED-12)', () => {
  it('keeps the upload private and serves the cleaned copy only while the item is public', async () => {
    const v = await video();
    expect(await setVideoCaptions(env.DB, env, v.mediaId, enc(FILE), ACTOR)).toEqual({ cues: 1 });
    const keys = await captionKeys(v.mediaId);
    expect(keys.priv).not.toBeNull();
    expect(keys.pub).toHaveLength(1);
    const pubKey = keys.pub[0] as string;

    // As uploaded, privately (note included); never in the public bucket.
    const source = await getCaptionsSource(env.DB, env, v.mediaId);
    expect(await source?.text()).toBe(FILE);
    expect(await env.MEDIA_PUBLIC.head(String(keys.priv))).toBeNull();

    // Draft item: the public file is a 404 like any unknown key.
    expect(await get(pubKey)).toBeNull();

    const cat = await insertCategory('Captioned', `captioned-${Date.now()}`);
    await setItemCategories(env.DB, v.itemId, [cat], ACTOR);
    await setItemStatus(env.DB, v.itemId, 'public', ACTOR);
    const res = await get(pubKey);
    expect(res?.status).toBe(200);
    expect(res?.headers.get('content-type')).toBe('text/vtt');
    const body = (await res?.text()) ?? '';
    expect(body).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n');
    expect(body).not.toContain('caption-sentinel-note');

    const { active } = await listItemMedia(env.DB, v.itemId);
    expect(active[0]?.hasCaptions).toBe(true);

    await setItemStatus(env.DB, v.itemId, 'private', ACTOR);
    expect(await get(pubKey)).toBeNull();
  });

  it('replaces and removes captions, deleting the old files', async () => {
    const v = await video();
    await setVideoCaptions(env.DB, env, v.mediaId, enc(FILE), ACTOR);
    const first = await captionKeys(v.mediaId);
    await setVideoCaptions(
      env.DB,
      env,
      v.mediaId,
      enc('1\n00:00:03,000 --> 00:00:04,000\nAgain\n'),
      ACTOR,
    );
    const second = await captionKeys(v.mediaId);
    expect(second.priv).not.toBe(first.priv);
    expect(second.pub).toHaveLength(1);
    expect(await env.MEDIA_PRIVATE.head(String(first.priv))).toBeNull();
    expect(await env.MEDIA_PUBLIC.head(String(first.pub[0]))).toBeNull();
    expect(
      await count('audit_log', "action = 'media.captions_replace' AND target_id = ?", v.mediaId),
    ).toBe(1);

    await removeVideoCaptions(env.DB, env, v.mediaId, ACTOR);
    expect(await captionKeys(v.mediaId)).toEqual({ priv: null, pub: [] });
    expect(await env.MEDIA_PRIVATE.head(String(second.priv))).toBeNull();
    expect(await env.MEDIA_PUBLIC.head(String(second.pub[0]))).toBeNull();
    expect(await getCaptionsSource(env.DB, env, v.mediaId)).toBeNull();
  });

  it('refuses photos, removed videos and bad files, storing nothing', async () => {
    const item = await createItem(env.DB, { title: 'A photo' }, ACTOR);
    const photo = await insertMedia(item.id);
    expect(await failure(setVideoCaptions(env.DB, env, photo, enc(FILE), ACTOR))).toEqual({
      code: 'invalid',
      reason: 'not_a_video',
    });

    const v = await video();
    expect(
      await failure(
        setVideoCaptions(
          env.DB,
          env,
          v.mediaId,
          enc('WEBVTT\n\n00:20.000 --> 00:21.000\nx\n'),
          ACTOR,
        ),
      ),
    ).toEqual({ code: 'invalid', reason: 'captions_starts_after_end', block: 1 });
    expect(await captionKeys(v.mediaId)).toEqual({ priv: null, pub: [] });

    // A removed video (in its 30 days of restore) takes no new captions.
    await removeMedia(env.DB, v.mediaId, ACTOR);
    expect(await failure(setVideoCaptions(env.DB, env, v.mediaId, enc(FILE), ACTOR))).toEqual({
      code: 'conflict',
      reasons: ['media_removed'],
    });
    expect(await failure(setVideoCaptions(env.DB, env, 'nope', enc(FILE), ACTOR))).toEqual({
      code: 'not_found',
    });
  });
});
