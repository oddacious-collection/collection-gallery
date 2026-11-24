/**
 * POST /api/items/:id/media {width, height} — start a photo upload (D-46).
 * The browser sends the size of the master it made on the device; the answer
 * lists the files to send and where (see @cg/core/admin media.ts).
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { api, beginUpload, json, readJson } from '@cg/core/admin';

const Body = z.strictObject({
  width: z.number().int().positive().max(100_000),
  height: z.number().int().positive().max(100_000),
});

export const POST: APIRoute = ({ request, params }) =>
  api(async () => {
    const size = Body.parse(await readJson(request));
    return json(await beginUpload(env.DB, String(params['id']), size), 201);
  });
