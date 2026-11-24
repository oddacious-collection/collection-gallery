/** POST /api/items/:id/trash {trashed} — move to or restore from the trash (ADM-04). */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { actorOf, api, json, readJson, restoreItem, trashItem } from '@cg/core/admin';

const Body = z.strictObject({ trashed: z.boolean() });

export const POST: APIRoute = ({ request, params }) =>
  api(async () => {
    const { trashed } = Body.parse(await readJson(request));
    const id = String(params['id']);
    const item = trashed
      ? await trashItem(env.DB, id, actorOf(request))
      : await restoreItem(env.DB, id, actorOf(request));
    return json({ id: item.id, deletedAt: item.deletedAt });
  });
