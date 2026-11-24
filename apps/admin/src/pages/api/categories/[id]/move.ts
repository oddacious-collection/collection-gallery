/** POST /api/categories/:id/move {parentId} — move a category and its subtree (CNT-01). */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { actorOf, api, json, moveCategory, readJson } from '@cg/core/admin';

const Body = z.strictObject({ parentId: z.string().nullable() });

export const POST: APIRoute = ({ request, params }) =>
  api(async () => {
    const { parentId } = Body.parse(await readJson(request));
    await moveCategory(env.DB, String(params['id']), parentId, actorOf(request));
    return json({ ok: true });
  });
