/** POST /api/uploads/:uploadId/finalize {altText?} — attach a fully uploaded photo to its item. */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { actorOf, api, finalizeUpload, json, readJson } from '@cg/core/admin';

const Body = z.strictObject({ altText: z.string().optional() });

export const POST: APIRoute = ({ request, params }) =>
  api(async () => {
    const { altText } = Body.parse(await readJson(request));
    const result = await finalizeUpload(
      env.DB,
      env,
      String(params['uploadId']),
      altText ?? '',
      actorOf(request),
    );
    return json(result, 201);
  });
