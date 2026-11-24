/**
 * GET /media/original/:id — download a photo's private master (MED-04):
 * owner only, always as an attachment, never shown inline.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getOriginalObject } from '@cg/core/admin';

export const GET: APIRoute = async ({ params }) => {
  const id = String(params['id']);
  const object = await getOriginalObject(env.DB, env, id);
  if (!object) return new Response('Not found\n', { status: 404 });
  return new Response(object.body, {
    headers: {
      'content-type': 'image/jpeg',
      'content-length': String(object.size),
      'content-disposition': `attachment; filename="photo-${id.toLowerCase()}.jpg"`,
    },
  });
};
