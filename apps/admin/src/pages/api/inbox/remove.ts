/** POST /api/inbox/remove {photoIds} — remove inbox photos (restorable for 30 days). */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { actorOf, api, json, readJson, removeInboxPhotos } from '@cg/core/admin';

const Body = z.strictObject({ photoIds: z.array(z.string()).min(1).max(500) });

export const POST: APIRoute = ({ request }) =>
  api(async () => {
    const { photoIds } = Body.parse(await readJson(request));
    return json({ removed: await removeInboxPhotos(env.DB, photoIds, actorOf(request)) });
  });
