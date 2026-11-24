/**
 * PATCH  /api/items/:id — edit an item's fields (ADM-02).
 * DELETE /api/items/:id — "Delete permanently" an item that is in the trash (ADM-04).
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  actorOf,
  api,
  json,
  purgeItemNow,
  readJson,
  updateItem,
  type ItemUpdateInput,
} from '@cg/core/admin';

export const PATCH: APIRoute = ({ request, params }) =>
  api(async () => {
    const body = (await readJson(request)) as ItemUpdateInput;
    const item = await updateItem(env.DB, String(params['id']), body, actorOf(request));
    return json({ id: item.id, slug: item.slug });
  });

export const DELETE: APIRoute = ({ request, params }) =>
  api(async () => {
    await purgeItemNow(env.DB, env, String(params['id']), actorOf(request));
    return json({ ok: true });
  });
