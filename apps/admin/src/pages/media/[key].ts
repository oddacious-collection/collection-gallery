/**
 * GET /media/:key — a public-size photo file, for the admin's own previews.
 * Admin-only (behind Access); serves any item's photos, whatever its status.
 * The public site serves photos itself, with a visibility check (MED-10).
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getVariantObject } from '@cg/core/admin';

export const GET: APIRoute = async ({ params }) => {
  const object = await getVariantObject(env.DB, env, String(params['key']));
  if (!object) return new Response('Not found\n', { status: 404 });
  return new Response(object.body, {
    headers: {
      'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
      'content-length': String(object.size),
    },
  });
};
