/**
 * TST-03 (pipeline level), SEC-04 CSRF, SEC-07 headers on admin responses,
 * SEC-12 generic errors, fail-closed configuration.
 */
import { createExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER, createAdminPipeline } from '../src/admin/index.ts';
import { ADMIN_ORIGIN, adminEnv, createIssuer, type TestIssuer } from './helpers.ts';

let issuer: TestIssuer;
beforeAll(async () => {
  issuer = await createIssuer();
});

function pipeline(
  app: ReturnType<typeof vi.fn<(req: Request) => Promise<Response>>> = vi.fn(
    async (_req: Request) => new Response('admin ok'),
  ),
) {
  return { app, handler: createAdminPipeline(app, { keys: issuer.keys }) };
}

async function send(
  handler: ReturnType<typeof pipeline>['handler'],
  init: RequestInit & { token?: string | null; env?: Record<string, unknown> } = {},
) {
  const headers = new Headers(init.headers);
  if (init.token !== null)
    headers.set('Cf-Access-Jwt-Assertion', init.token ?? (await issuer.sign()));
  const request = new Request(`${ADMIN_ORIGIN}/`, { ...init, headers });
  return handler(request, init.env ?? adminEnv(), createExecutionContext());
}

describe('admin pipeline', () => {
  it('passes the verified email to the app and ignores a spoofed actor header', async () => {
    let seen: string | null = null;
    const { handler } = pipeline(
      vi.fn(async (req: Request) => {
        seen = req.headers.get('x-cg-actor');
        return new Response('ok');
      }),
    );
    const res = await send(handler, { headers: { 'x-cg-actor': 'attacker@example.test' } });
    expect(res.status).toBe(200);
    expect(seen).toBe('owner@example.test');
  });

  it('serves an authenticated GET with security headers and no caching', async () => {
    const { app, handler } = pipeline();
    const res = await send(handler);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('admin ok');
    expect(app).toHaveBeenCalledOnce();
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('content-security-policy')).toContain(
      "require-trusted-types-for 'script'",
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
  });

  it.each([
    ['no token', null],
    ['garbage token', 'abc.def.ghi'],
  ])('returns a generic 403 for %s without reaching the app', async (_n, token) => {
    const { app, handler } = pipeline();
    const res = await send(handler, { token });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('Forbidden\n');
    expect(app).not.toHaveBeenCalled();
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('strict-transport-security')).toBeTruthy();
  });

  it('returns 403 for a valid token belonging to someone else', async () => {
    const { app, handler } = pipeline();
    const res = await send(handler, {
      token: await issuer.sign({ email: 'intruder@example.test' }),
    });
    expect(res.status).toBe(403);
    expect(app).not.toHaveBeenCalled();
  });

  it('rejects unknown methods with 405', async () => {
    const { app, handler } = pipeline();
    const res = await send(handler, { method: 'OPTIONS' });
    expect(res.status).toBe(405);
    expect(app).not.toHaveBeenCalled();
  });

  describe('CSRF (SEC-04)', () => {
    const good = { Origin: ADMIN_ORIGIN, [CSRF_HEADER]: '1', 'Sec-Fetch-Site': 'same-origin' };

    it('allows a same-origin POST carrying the custom header', async () => {
      const { handler } = pipeline();
      const res = await send(handler, { method: 'POST', headers: good });
      expect(res.status).toBe(200);
    });

    it.each([
      ['no Origin', { [CSRF_HEADER]: '1' }],
      ['foreign Origin', { ...good, Origin: 'https://evil.example' }],
      ['no custom header', { Origin: ADMIN_ORIGIN }],
      ['cross-site fetch metadata', { ...good, 'Sec-Fetch-Site': 'cross-site' }],
    ])('rejects a POST with %s', async (_n, headers) => {
      const { app, handler } = pipeline();
      const res = await send(handler, { method: 'POST', headers });
      expect(res.status).toBe(403);
      expect(app).not.toHaveBeenCalled();
    });
  });

  it('fails closed with a generic 500 when configuration is invalid', async () => {
    const { app, handler } = pipeline();
    const res = await send(handler, { env: adminEnv({ ADMIN_EMAIL: undefined }) });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('Something went wrong\n');
    expect(app).not.toHaveBeenCalled();
  });

  it('hides internal errors behind a generic 500', async () => {
    const { handler } = pipeline(
      vi.fn(async () => {
        throw new Error('secret internal detail');
      }),
    );
    const res = await send(handler);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('secret');
  });

  it('strips any Set-Cookie the app sets (SEC-08: only Access sets a cookie)', async () => {
    const { handler } = pipeline(
      vi.fn(async () => {
        const r = new Response('x');
        r.headers.append('Set-Cookie', 'session=1; Path=/');
        return r;
      }),
    );
    const res = await send(handler);
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});
