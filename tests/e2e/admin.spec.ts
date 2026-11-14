/**
 * Admin Worker, built and running in local workerd with no Cloudflare Access
 * in front. TST-03 AC: every route — pages, endpoints and static assets —
 * rejects requests with no or invalid Access JWT, with generic errors and full
 * security headers. (The valid-token path is covered by the core unit tests,
 * which sign tokens with a local key.)
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { ADMIN, expectSecurityHeaders } from './helpers.ts';

// An unsigned (`alg: none`) token claiming to be the local test admin. Built at
// runtime so secret scanners don't mistake a test fixture for a real JWT.
const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const FORGED = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ email: 'owner@example.com', exp: 9999999999 })}.`;

const routes = ['/', '/robots.txt', '/no-such-page', '/_astro/', '/.well-known/x'];

test.describe('admin rejects unauthenticated requests (TST-03)', () => {
  for (const path of routes) {
    test(`GET ${path} without a token → 403`, async ({ request }) => {
      const res = await request.get(`${ADMIN}${path}`);
      expect(res.status()).toBe(403);
      expect(await res.text()).toBe('Forbidden\n');
      expectSecurityHeaders(res, 'admin');
    });
  }

  test('real built static assets are not served without a token', async ({ request }) => {
    // run_worker_first: assets go through the JWT check too (SEC-03).
    const dir = path.join(import.meta.dirname, '../../apps/admin/dist/client/_astro');
    const assets = readdirSync(dir);
    expect(assets.length).toBeGreaterThan(0);
    for (const name of assets) {
      const res = await request.get(`${ADMIN}/_astro/${name}`);
      expect(res.status(), name).toBe(403);
    }
  });

  test('a forged (unsigned) token → 403', async ({ request }) => {
    const res = await request.get(`${ADMIN}/`, {
      headers: { 'Cf-Access-Jwt-Assertion': FORGED },
    });
    expect(res.status()).toBe(403);
    expectSecurityHeaders(res, 'admin');
  });

  test('a state-changing request without a token → 403', async ({ request }) => {
    const res = await request.post(`${ADMIN}/`, { data: 'x' });
    expect(res.status()).toBe(403);
  });

  test('the browser sees a generic page, no cookies, nothing cacheable', async ({
    page,
    context,
  }) => {
    const res = await page.goto(`${ADMIN}/`);
    expect(res?.status()).toBe(403);
    expect(await res?.headerValue('cache-control')).toBe('no-store');
    await expect(page.locator('body')).toHaveText('Forbidden');
    expect(await context.cookies()).toEqual([]);
  });
});
