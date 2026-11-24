/** POST /api/inbox/uploads {width, height} — start a photo upload into the inbox (D-55). */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { api, beginUpload, json, readJson } from '@cg/core/admin';

const Body = z.strictObject({
  width: z.number().int().positive().max(100_000),
  height: z.number().int().positive().max(100_000),
});

export const POST: APIRoute = ({ request }) =>
  api(async () => {
    const size = Body.parse(await readJson(request));
    return json(await beginUpload(env.DB, null, size), 201);
  });
