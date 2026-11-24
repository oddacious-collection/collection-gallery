/** POST /api/revisions/:id/restore — restore an item's content from a revision (ADM-05). */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { actorOf, api, json, restoreRevision } from '@cg/core/admin';

export const POST: APIRoute = ({ request, params }) =>
  api(async () => {
    const item = await restoreRevision(env.DB, String(params['id']), actorOf(request));
    return json({ id: item.id });
  });
