/** POST /api/items/:id/status {status} — Public/Private toggle and Save draft (ADM-02). */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { actorOf, api, json, readJson, setItemStatus } from '@cg/core/admin';

const Body = z.strictObject({ status: z.enum(['draft', 'public', 'private']) });

export const POST: APIRoute = ({ request, params }) =>
  api(async () => {
    const { status } = Body.parse(await readJson(request));
    const item = await setItemStatus(env.DB, String(params['id']), status, actorOf(request));
    return json({ id: item.id, status: item.status, postedAt: item.postedAt });
  });
