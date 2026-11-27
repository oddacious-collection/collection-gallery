/**
 * Seeds the LOCAL database and buckets (.wrangler/state) with the e2e data in
 * tests/e2e/seed-data.ts, through the real admin data layer, so the built
 * Workers have something to show. Local only: it uses Wrangler's local
 * platform proxy and refuses anything else.
 *
 *   npm run db:migrate:local && npm run db:seed:local
 *
 * Safe to run twice: it does nothing if the data is already there.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getPlatformProxy } from 'wrangler';
import {
  VIDEO_CHUNK_BYTES,
  beginUpload,
  beginVideoUpload,
  createCategory,
  createItem,
  finalizeInboxUpload,
  finalizeUpload,
  setItemCategories,
  setItemStatus,
  setItemTags,
  setVideoCaptions,
  storeUploadPart,
  storeVideoChunk,
  trashItem,
  updateItem,
} from '../packages/core/src/admin/index.ts';
import { verifyMp4Header } from '../packages/core/src/media/index.ts';
import {
  SEED_CATEGORIES,
  SEED_ITEMS,
  SEED_MANIFEST,
  SEED_VIDEO,
  type SeedManifest,
} from '../tests/e2e/seed-data.ts';
import { seedImagePath } from '../tests/e2e/fixtures/make-seed-images.ts';

const ROOT = path.join(import.meta.dirname, '..');
const ACTOR = 'seed@localhost';

interface Env {
  DB: D1Database;
  MEDIA_PUBLIC: R2Bucket;
  MEDIA_PRIVATE: R2Bucket;
  ENVIRONMENT: string;
  OWNER_NAME: string;
}

const proxy = await getPlatformProxy<Env>({
  configPath: path.join(ROOT, 'apps/admin/wrangler.jsonc'),
  persist: { path: path.join(ROOT, '.wrangler/state/v3') },
});
const env = proxy.env;
try {
  if (env.ENVIRONMENT !== 'local') throw new Error('seed-local only runs against local state');
  const existing = await env.DB.prepare('SELECT count(*) AS n FROM items WHERE slug = ?')
    .bind(SEED_ITEMS[0]?.slug ?? '')
    .first<{ n: number }>();
  if ((existing?.n ?? 0) > 0) {
    console.log('Local data already seeded.');
  } else {
    const catIds = new Map<string, string>();
    for (const c of SEED_CATEGORIES) {
      const row = await createCategory(
        env.DB,
        {
          name: c.name,
          slug: c.slug,
          description: c.description,
          parentId: c.parent ? (catIds.get(c.parent) ?? null) : null,
        },
        ACTOR,
      );
      catIds.set(c.slug, row.id);
    }

    const manifest: SeedManifest = { mediaKeys: {}, inbox: { variants: [], original: '' } };
    for (const s of SEED_ITEMS) {
      const item = await createItem(
        env.DB,
        {
          title: s.title,
          slug: s.oldSlug ?? s.slug,
          description: s.description ?? '',
          postedAt: s.postedAt,
          kind: s.kind ?? 'owned',
          ...(s.secret ?? {}),
          ...(s.secret ? { purchaseCurrency: 'USD' } : {}),
        },
        ACTOR,
      );
      if (s.oldSlug) await updateItem(env.DB, item.id, { slug: s.slug }, ACTOR);
      const keys = { variants: [] as string[], original: '' };
      for (const photo of s.photos) {
        const { uploadId, parts } = await beginUpload(env.DB, item.id, { width: 400, height: 300 });
        for (const part of parts) {
          const file = readFileSync(
            seedImagePath(photo, part.format === 'image/webp' ? 'webp' : 'jpg'),
          );
          await storeUploadPart(
            env.DB,
            env,
            uploadId,
            part.name,
            new Uint8Array(file),
            env.OWNER_NAME,
          );
        }
        const row = await env.DB.prepare('SELECT parts FROM media_uploads WHERE id = ?')
          .bind(uploadId)
          .first<{ parts: string }>();
        for (const p of JSON.parse(row?.parts ?? '[]') as Array<{ role: string; key: string }>) {
          if (p.role === 'original') keys.original ||= p.key;
          else keys.variants.push(p.key);
        }
        await finalizeUpload(env.DB, env, uploadId, '', ACTOR);
      }
      // Videos (PUB-06): the real upload path, fixture for both the master and
      // the public file, seed photo 0 as the poster (both are 400×300).
      for (const v of s.videos ?? []) {
        const clip = new Uint8Array(readFileSync(path.join(ROOT, SEED_VIDEO)));
        const info = verifyMp4Header(clip, clip.length);
        const { uploadId, parts } = await beginVideoUpload(env.DB, env, item.id, {
          width: info.width,
          height: info.height,
          durationS: info.durationS,
          hasAudio: info.hasAudio,
          masterBytes: clip.length,
          videoBytes: clip.length,
        });
        for (const part of parts) {
          if (part.format === 'video/mp4') {
            for (let n = 0; n * VIDEO_CHUNK_BYTES < clip.length; n++) {
              const chunk = clip.slice(n * VIDEO_CHUNK_BYTES, (n + 1) * VIDEO_CHUNK_BYTES);
              await storeVideoChunk(env.DB, env, uploadId, part.name, n, chunk);
            }
          } else {
            const file = readFileSync(
              seedImagePath(0, part.format === 'image/webp' ? 'webp' : 'jpg'),
            );
            await storeUploadPart(
              env.DB,
              env,
              uploadId,
              part.name,
              new Uint8Array(file),
              env.OWNER_NAME,
            );
          }
        }
        const row = await env.DB.prepare('SELECT parts FROM media_uploads WHERE id = ?')
          .bind(uploadId)
          .first<{ parts: string }>();
        for (const p of JSON.parse(row?.parts ?? '[]') as Array<{ role: string; key: string }>) {
          if (p.role !== 'original') keys.variants.push(p.key);
        }
        const { mediaId } = await finalizeUpload(env.DB, env, uploadId, v.alt ?? '', ACTOR);
        if (v.captions) {
          await setVideoCaptions(env.DB, env, mediaId, new TextEncoder().encode(v.captions), ACTOR);
        }
      }
      manifest.mediaKeys[s.slug] = keys;
      await setItemCategories(
        env.DB,
        item.id,
        s.categories.map((c) => catIds.get(c) ?? ''),
        ACTOR,
      );
      if (s.tags) await setItemTags(env.DB, item.id, s.tags, ACTOR);
      if (s.status !== 'draft') await setItemStatus(env.DB, item.id, s.status, ACTOR);
      if (s.trashed) await trashItem(env.DB, item.id, ACTOR);
    }
    // One photo left in the inbox (D-55): it must never be reachable publicly.
    {
      const { uploadId, parts } = await beginUpload(env.DB, null, { width: 400, height: 300 });
      for (const part of parts) {
        const file = readFileSync(seedImagePath(2, part.format === 'image/webp' ? 'webp' : 'jpg'));
        await storeUploadPart(
          env.DB,
          env,
          uploadId,
          part.name,
          new Uint8Array(file),
          env.OWNER_NAME,
        );
      }
      const row = await env.DB.prepare('SELECT parts FROM media_uploads WHERE id = ?')
        .bind(uploadId)
        .first<{ parts: string }>();
      for (const p of JSON.parse(row?.parts ?? '[]') as Array<{ role: string; key: string }>) {
        if (p.role === 'original') manifest.inbox.original = p.key;
        else manifest.inbox.variants.push(p.key);
      }
      await finalizeInboxUpload(env.DB, env, uploadId, ACTOR);
    }
    mkdirSync(path.join(ROOT, '.wrangler'), { recursive: true });
    writeFileSync(path.join(ROOT, SEED_MANIFEST), JSON.stringify(manifest, null, 2));
    console.log(`Seeded ${SEED_ITEMS.length} items in ${SEED_CATEGORIES.length} categories.`);
  }
} finally {
  await proxy.dispose();
}
