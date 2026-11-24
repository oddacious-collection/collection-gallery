/** POST /api/inbox/restore {photoIds} — bring removed inbox photos back. */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { actorOf, api, json, readJson, restoreInboxPhotos } from '@cg/core/admin';

const Body = z.strictObject({ photoIds: z.array(z.string()).min(1).max(500) });

export const POST: APIRoute = ({ request }) =>
  api(async () => {
    const { photoIds } = Body.parse(await readJson(request));
    return json({ restored: await restoreInboxPhotos(env.DB, photoIds, actorOf(request)) });
  });
