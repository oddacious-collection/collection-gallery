/**
 * Public Worker, built and running in local workerd.
 * TST-04 headers, INV-3 privacy (no cookies, storage or third-party requests),
 * NFR-03 accessibility (axe), SEC-07 CSP with no violations.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { PUBLIC, expectNoCookies, expectSecurityHeaders } from './helpers.ts';

test.describe('public site', () => {
  test('home page renders hello world', async ({ page }) => {
    const res = await page.goto(`${PUBLIC}/`);
    expect(res?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Collection Gallery');
    await expect(page.getByText('Hello, world')).toBeVisible();
  });

  test('home page has no accessibility violations', async ({ page }) => {
    await page.goto(`${PUBLIC}/`);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('no cookies, no storage, no third-party requests, no CSP violations', async ({
    page,
    context,
  }) => {
    const foreign: string[] = [];
    page.on('request', (req) => {
      if (!req.url().startsWith(`${PUBLIC}/`)) foreign.push(req.url());
    });
    const cspErrors: string[] = [];
    page.on('console', (msg) => {
      if (/content security policy/i.test(msg.text())) cspErrors.push(msg.text());
    });

    await page.goto(`${PUBLIC}/`);
    await page.waitForLoadState('networkidle');

    expect(foreign).toEqual([]);
    expect(cspErrors).toEqual([]);
    expect(await context.cookies()).toEqual([]);
    const storage = await page.evaluate(async () => ({
      local: localStorage.length,
      session: sessionStorage.length,
      idb: 'databases' in indexedDB ? (await indexedDB.databases()).length : 0,
    }));
    expect(storage).toEqual({ local: 0, session: 0, idb: 0 });
  });

  test('pages contain no inline scripts or style attributes', async ({ page }) => {
    await page.goto(`${PUBLIC}/`);
    const inline = await page.evaluate(() => ({
      scripts: [...document.querySelectorAll('script:not([src])')].length,
      styleAttrs: document.querySelectorAll('[style]').length,
      styleTags: document.querySelectorAll('style').length,
    }));
    expect(inline).toEqual({ scripts: 0, styleAttrs: 0, styleTags: 0 });
  });
});

test.describe('public headers on every route type (TST-04)', () => {
  test('HTML page', async ({ request }) => {
    const res = await request.get(`${PUBLIC}/`);
    expect(res.status()).toBe(200);
    expectSecurityHeaders(res, 'public');
    expectNoCookies(res);
  });

  test('not-found page', async ({ request, page }) => {
    const res = await request.get(`${PUBLIC}/no-such-page`);
    expect(res.status()).toBe(404);
    expectSecurityHeaders(res, 'public');
    expectNoCookies(res);
    await page.goto(`${PUBLIC}/no-such-page`);
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(axe.violations).toEqual([]);
  });

  test('text endpoint (robots.txt blocks crawlers outside production)', async ({ request }) => {
    const res = await request.get(`${PUBLIC}/robots.txt`);
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('Disallow: /');
    expectSecurityHeaders(res, 'public');
  });

  test('static asset (served from _headers, without the Worker)', async ({ request, page }) => {
    await page.goto(`${PUBLIC}/`);
    const href = await page.locator('link[rel="stylesheet"]').first().getAttribute('href');
    expect(href).toMatch(/^\/_astro\//);
    const res = await request.get(`${PUBLIC}${href}`);
    expect(res.status()).toBe(200);
    expectSecurityHeaders(res, 'public');
    expect(res.headers()['cache-control']).toContain('immutable');
  });

  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    test(`${method} is rejected`, async ({ request }) => {
      const res = await request.fetch(`${PUBLIC}/`, { method });
      // Exactly 405 from the pipeline (a 403 would mean something else refused it).
      expect(res.status()).toBe(405);
      expectNoCookies(res);
    });
  }

  test('the _headers file is not served', async ({ request }) => {
    const res = await request.get(`${PUBLIC}/_headers`);
    expect(res.status()).toBe(404);
  });
});
