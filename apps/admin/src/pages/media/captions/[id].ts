/**
 * GET /media/captions/:id — download a video's caption file exactly as it was
 * uploaded (MED-12, D-65): owner only, always as a plain-text attachment.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getCaptionsSource } from '@cg/core/admin';

export const GET: APIRoute = async ({ params }) => {
  const id = String(params['id']);
  const object = await getCaptionsSource(env.DB, env, id);
  if (!object) return new Response('Not found\n', { status: 404 });
  return new Response(object.body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': String(object.size),
      'content-disposition': `attachment; filename="captions-${id.toLowerCase()}.txt"`,
    },
  });
};
