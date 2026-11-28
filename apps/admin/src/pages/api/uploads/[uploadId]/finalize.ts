/**
 * POST /api/uploads/:uploadId/finalize {altText?, sourceHash?} — finish a photo
 * or video upload (sourceHash: the importer's SHA-256 of the source file, D-70):
 * attach it to its item, or (an inbox upload, D-55) put it in the inbox.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import {
  actorOf,
  api,
  finalizeInboxUpload,
  finalizeUpload,
  json,
  readJson,
  uploadTarget,
  SOURCE_HASH_PATTERN,
} from '@cg/core/admin';

const Body = z.strictObject({
  altText: z.string().optional(),
  sourceHash: z.string().regex(SOURCE_HASH_PATTERN).optional(),
});

export const POST: APIRoute = ({ request, params }) =>
  api(async () => {
    const { altText, sourceHash } = Body.parse(await readJson(request));
    const uploadId = String(params['uploadId']);
    const actor = actorOf(request);
    if ((await uploadTarget(env.DB, uploadId)) === 'inbox') {
      return json(await finalizeInboxUpload(env.DB, env, uploadId, actor), 201);
    }
    return json(
      await finalizeUpload(env.DB, env, uploadId, altText ?? '', actor, new Date(), {
        ...(sourceHash ? { sourceHash } : {}),
      }),
      201,
    );
  });
