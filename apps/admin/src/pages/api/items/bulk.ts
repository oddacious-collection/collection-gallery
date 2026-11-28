/**
 * POST /api/items/bulk {ids, action, categoryId?} — publish, trash or add a
 * category to up to 50 items; each succeeds or fails on its own (IMP-04).
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { BulkAction, actorOf, api, bulkItems, json, readJson } from '@cg/core/admin';

export const POST: APIRoute = ({ request }) =>
  api(async () => {
    const input = BulkAction.parse(await readJson(request));
    return json({ results: await bulkItems(env.DB, input, actorOf(request)) });
  });
