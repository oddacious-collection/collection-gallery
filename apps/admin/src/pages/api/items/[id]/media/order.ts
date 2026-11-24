/** PUT /api/items/:id/media/order {order} — reorder an item's photos; the first is the cover (ADM-03). */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { actorOf, api, json, readJson, reorderMedia } from '@cg/core/admin';

const Body = z.strictObject({ order: z.array(z.string()).max(1000) });

export const PUT: APIRoute = ({ request, params }) =>
  api(async () => {
    const { order } = Body.parse(await readJson(request));
    await reorderMedia(env.DB, String(params['id']), order, actorOf(request));
    return json({ ok: true });
  });
