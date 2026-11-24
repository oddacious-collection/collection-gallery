/**
 * GET/HEAD /media/:key — a public photo file (MED-10). Served only while its
 * item is publicly visible and the photo isn't removed; otherwise the same
 * 404 as an unknown key. No edge caching in M1 (D-45).
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { servePublicMedia } from '@cg/core/public';

const notFound = () =>
  new Response('Not found\n', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });

export const GET: APIRoute = async ({ params, request }) =>
  (await servePublicMedia(env.DB, env.MEDIA_PUBLIC, String(params['key']), request)) ?? notFound();

export const HEAD = GET;
