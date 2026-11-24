/** POST /api/items — create a draft item (ADM-02). */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { actorOf, api, createItem, json, readJson, type ItemCreateInput } from '@cg/core/admin';

export const POST: APIRoute = ({ request }) =>
  api(async () => {
    const body = (await readJson(request)) as ItemCreateInput;
    const item = await createItem(env.DB, body, actorOf(request));
    return json({ id: item.id, slug: item.slug }, 201);
  });
