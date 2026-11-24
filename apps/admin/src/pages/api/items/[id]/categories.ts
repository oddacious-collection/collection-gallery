/** PUT /api/items/:id/categories {categoryIds} — replace an item's categories (CNT-02). */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { actorOf, api, json, readJson, setItemCategories } from '@cg/core/admin';

const Body = z.strictObject({ categoryIds: z.array(z.string()) });

export const PUT: APIRoute = ({ request, params }) =>
  api(async () => {
    const { categoryIds } = Body.parse(await readJson(request));
    await setItemCategories(env.DB, String(params['id']), categoryIds, actorOf(request));
    return json({ ok: true });
  });
