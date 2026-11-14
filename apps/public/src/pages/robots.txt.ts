import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

// Staging and local must never be crawled. Production rules (including the
// AI-crawler list, RGT-06) arrive in M5.
export const GET: APIRoute = () => {
  const body =
    env.ENVIRONMENT === 'production' ? 'User-agent: *\nAllow: /\n' : 'User-agent: *\nDisallow: /\n';
  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
