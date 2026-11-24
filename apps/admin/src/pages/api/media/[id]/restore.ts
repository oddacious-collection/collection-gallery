/** POST /api/media/:id/restore — bring back a removed photo (at the end of the list). */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { actorOf, api, json, restoreMedia } from '@cg/core/admin';

export const POST: APIRoute = ({ request, params }) =>
  api(async () => {
    await restoreMedia(env.DB, String(params['id']), actorOf(request));
    return json({ ok: true });
  });
