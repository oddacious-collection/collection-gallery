/** Public pipeline: headers (TST-04), no cookies (INV-3/SEC-08), read-only methods. */
import { createExecutionContext } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { createPublicPipeline } from '../src/public/index.ts';
import { PUBLIC_ORIGIN, publicEnv } from './helpers.ts';

function run(
  app: () => Promise<Response>,
  init: RequestInit = {},
  env: Record<string, unknown> = publicEnv(),
) {
  return createPublicPipeline(app)(
    new Request(`${PUBLIC_ORIGIN}/`, init),
    env,
    createExecutionContext(),
  );
}

describe('public pipeline', () => {
  it('applies security headers', async () => {
    const res = await run(async () => new Response('hello'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    // Public CSP has no Trusted Types requirement (admin only).
    expect(res.headers.get('content-security-policy')).not.toContain('trusted-types');
  });

  it('strips every Set-Cookie header', async () => {
    const res = await run(async () => {
      const r = new Response('x');
      r.headers.append('Set-Cookie', 'a=1');
      r.headers.append('Set-Cookie', 'b=2; Domain=example.test');
      return r;
    });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('marks staging as not indexable, but not production', async () => {
    const staging = await run(async () => new Response('x'));
    expect(staging.headers.get('x-robots-tag')).toContain('noindex');
    const prod = await run(
      async () => new Response('x'),
      {},
      publicEnv({ ENVIRONMENT: 'production' }),
    );
    expect(prod.headers.get('x-robots-tag')).toBeNull();
  });

  it.each(['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])('rejects %s with 405', async (method) => {
    const app = vi.fn(async () => new Response('x'));
    const res = await run(app, { method });
    expect(res.status).toBe(405);
    expect(app).not.toHaveBeenCalled();
  });

  it('fails closed on invalid configuration', async () => {
    const app = vi.fn(async () => new Response('x'));
    const res = await run(app, {}, publicEnv({ PUBLIC_ORIGIN: 'http://example.test' }));
    expect(res.status).toBe(500);
    expect(app).not.toHaveBeenCalled();
  });
});
