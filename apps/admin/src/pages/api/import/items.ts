/**
 * POST /api/import/items — the draft for one Instagram post (IMP-01/03,
 * D-70): created, or the existing one to resume (with the source hashes of
 * the files it already has), or "trashed" when the owner binned it.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ImportedItem, actorOf, api, json, readJson, startImportedItem } from '@cg/core/admin';

export const POST: APIRoute = ({ request }) =>
  api(async () => {
    const input = ImportedItem.parse(await readJson(request));
    const result = await startImportedItem(env.DB, input, actorOf(request));
    return json(result, result.status === 'created' ? 201 : 200);
  });
