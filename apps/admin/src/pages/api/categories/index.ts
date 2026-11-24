/**
 * POST /api/categories — create a category (ADM-06).
 * PUT  /api/categories {parentId, order} — reorder one parent's children.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import {
  actorOf,
  api,
  createCategory,
  json,
  readJson,
  reorderCategories,
  type CategoryCreate,
} from '@cg/core/admin';

export const POST: APIRoute = ({ request }) =>
  api(async () => {
    const body = (await readJson(request)) as z.input<typeof CategoryCreate>;
    const category = await createCategory(env.DB, body, actorOf(request));
    return json({ id: category.id, slug: category.slug }, 201);
  });

const Order = z.strictObject({
  parentId: z.string().nullable(),
  order: z.array(z.string()).max(1000),
});

export const PUT: APIRoute = ({ request }) =>
  api(async () => {
    const { parentId, order } = Order.parse(await readJson(request));
    await reorderCategories(env.DB, parentId, order, actorOf(request));
    return json({ ok: true });
  });
