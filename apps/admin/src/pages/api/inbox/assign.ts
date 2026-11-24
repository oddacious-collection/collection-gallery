/**
 * POST /api/inbox/assign {photoIds, itemId} | {photoIds, title, categoryId?}
 * — move inbox photos onto an existing item, or into a new draft (D-55).
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { actorOf, api, assignInboxPhotos, json, readJson, type AssignInbox } from '@cg/core/admin';
import type { z } from 'zod';

export const POST: APIRoute = ({ request }) =>
  api(async () => {
    const body = (await readJson(request)) as z.input<typeof AssignInbox>;
    const result = await assignInboxPhotos(env.DB, body, actorOf(request));
    return json({ id: result.itemId, created: result.created });
  });
