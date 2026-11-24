/**
 * POST /api/uploads/:uploadId/finalize {altText?} — finish a photo upload:
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
} from '@cg/core/admin';

const Body = z.strictObject({ altText: z.string().optional() });

export const POST: APIRoute = ({ request, params }) =>
  api(async () => {
    const { altText } = Body.parse(await readJson(request));
    const uploadId = String(params['uploadId']);
    const actor = actorOf(request);
    if ((await uploadTarget(env.DB, uploadId)) === 'inbox') {
      return json(await finalizeInboxUpload(env.DB, env, uploadId, actor), 201);
    }
    return json(await finalizeUpload(env.DB, env, uploadId, altText ?? '', actor), 201);
  });
