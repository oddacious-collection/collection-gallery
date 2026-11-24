/** PUT /api/items/:id/tags {tags} — replace an item's tags by name. */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { actorOf, api, json, readJson, setItemTags } from '@cg/core/admin';

const Body = z.strictObject({ tags: z.array(z.string()) });

export const PUT: APIRoute = ({ request, params }) =>
  api(async () => {
    const { tags } = Body.parse(await readJson(request));
    await setItemTags(env.DB, String(params['id']), tags, actorOf(request));
    return json({ ok: true });
  });
