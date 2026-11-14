import type { APIRoute } from 'astro';

// Admin is never crawlable (it is also behind Access).
export const GET: APIRoute = () =>
  new Response('User-agent: *\nDisallow: /\n', {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
