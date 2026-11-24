/**
 * PATCH  /api/categories/:id — rename or edit a category (ADM-06).
 * DELETE /api/categories/:id — delete an empty category.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import type { z } from 'zod';
import {
  actorOf,
  api,
  deleteCategory,
  json,
  readJson,
  updateCategory,
  type CategoryUpdate,
} from '@cg/core/admin';

export const PATCH: APIRoute = ({ request, params }) =>
  api(async () => {
    const body = (await readJson(request)) as z.input<typeof CategoryUpdate>;
    const category = await updateCategory(env.DB, String(params['id']), body, actorOf(request));
    return json({ id: category.id, slug: category.slug });
  });

export const DELETE: APIRoute = ({ request, params }) =>
  api(async () => {
    await deleteCategory(env.DB, String(params['id']), actorOf(request));
    return json({ ok: true });
  });
