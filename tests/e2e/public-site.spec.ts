/**
 * The public site with real (seeded) data: PUB-01/04/05/07/08/15, MED-10,
 * NFR-03 accessibility and INV-1/INV-3 on every page type. Needs
 * `npm run db:migrate:local && npm run db:seed:local` before the build runs.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { PUBLIC, expectNoCookies, expectSecurityHeaders } from './helpers.ts';
import {
  HIDDEN_SLUGS,
  PUBLIC_SLUGS,
  SEED_MANIFEST,
  SENTINELS,
  type SeedManifest,
} from './seed-data.ts';

const manifest = JSON.parse(
  readFileSync(path.join(import.meta.dirname, '../..', SEED_MANIFEST), 'utf8'),
) as SeedManifest;

const PAGES = [
  '/',
  '/items',
  '/category/meteorites',
  '/category/pallasites',
  '/item/seymchan-pallasite-slice',
  '/item/seymchan-pallasite-slice?in=meteorites',
  '/item/seymchan-pallasite-slice/photo/1',
  '/search?q=olivine',
  '/search',
];

function expectNoSentinels(text: string, where: string): void {
  for (const s of SENTINELS) expect(text.includes(s), `${where} contains ${s}`).toBe(false);
}

async function watchPage(page: Page) {
  const problems: string[] = [];
  page.on('request', (req) => {
    if (!req.url().startsWith(`${PUBLIC}/`)) problems.push(`third-party: ${req.url()}`);
  });
  page.on('console', (m) => {
    if (m.type() === 'error' || /content security policy/i.test(m.text())) problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(e.message));
  return problems;
}

test.describe('every public page type', () => {
  for (const url of PAGES) {
    test(`${url}: headers, accessibility, privacy, no leaks`, async ({
      page,
      context,
      request,
    }) => {
      const res = await request.get(`${PUBLIC}${url}`);
      expect(res.status()).toBe(200);
      expectSecurityHeaders(res, 'public');
      expectNoCookies(res);
      expectNoSentinels(await res.text(), url);

      const problems = await watchPage(page);
      await page.goto(`${PUBLIC}${url}`);
      await page.waitForLoadState('networkidle');
      const axe = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(axe.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
      expect(problems).toEqual([]);
      expect(await context.cookies()).toEqual([]);
      const storage = await page.evaluate(() => localStorage.length + sessionStorage.length);
      expect(storage).toBe(0);
      const inline = await page.evaluate(
        () => document.querySelectorAll('script:not([src]), style, [style]').length,
      );
      expect(inline).toBe(0);
      expectNoSentinels(await page.content(), `${url} (rendered)`);
    });
  }
});

test.describe('not found (PUB-15) and redirects', () => {
  test('every non-public item, unknown item and hidden category gets the identical 404', async ({
    request,
  }) => {
    const reference = await request.get(`${PUBLIC}/no-such-page`);
    expect(reference.status()).toBe(404);
    const body = await reference.text();
    for (const url of [
      ...HIDDEN_SLUGS.map((s) => `/item/${s}`),
      ...HIDDEN_SLUGS.map((s) => `/item/${s}/photo/1`),
      '/item/no-such-item',
      '/category/sentinel-hidden-category',
      '/category/no-such-category',
      '/item/seymchan-pallasite-slice/photo/9',
    ]) {
      const res = await request.get(`${PUBLIC}${url}`);
      expect(res.status(), url).toBe(404);
      expect(await res.text(), url).toBe(body);
      expectSecurityHeaders(res, 'public');
    }
  });

  test('an old slug answers 301 to the current one, keeping the list', async ({ request }) => {
    const res = await request.get(`${PUBLIC}/item/dune-first-edition-old?in=books`, {
      maxRedirects: 0,
    });
    expect(res.status()).toBe(301);
    expect(res.headers()['location']).toBe('/item/first-edition-dune?in=books');
  });
});

test.describe('photos (MED-10)', () => {
  test('public sizes are served with type, nosniff and ranges', async ({ request }) => {
    const key = manifest.mediaKeys['seymchan-pallasite-slice']?.variants[0] ?? '';
    const res = await request.get(`${PUBLIC}/media/${key}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/^image\/(webp|jpeg)$/);
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
    expectNoCookies(res);
    const part = await request.get(`${PUBLIC}/media/${key}`, { headers: { range: 'bytes=0-3' } });
    expect(part.status()).toBe(206);
    expect((await part.body()).length).toBe(4);
  });

  test('photos of non-public items, and every master, are 404', async ({ request }) => {
    for (const slug of HIDDEN_SLUGS) {
      for (const key of manifest.mediaKeys[slug]?.variants ?? []) {
        expect((await request.get(`${PUBLIC}/media/${key}`)).status(), `${slug} ${key}`).toBe(404);
      }
    }
    for (const slug of [...PUBLIC_SLUGS, ...HIDDEN_SLUGS]) {
      const original = manifest.mediaKeys[slug]?.original ?? '';
      expect((await request.get(`${PUBLIC}/media/${original}`)).status(), `${slug} master`).toBe(
        404,
      );
    }
  });
});

test.describe('search (PUB-08)', () => {
  test('finds public items by tag, category and prefix; never non-public ones', async ({
    request,
  }) => {
    const find = async (q: string) =>
      (await request.get(`${PUBLIC}/search?q=${encodeURIComponent(q)}`)).text();
    expect(await find('olivine')).toContain('/item/seymchan-pallasite-slice');
    expect(await find('pallas')).toContain('/item/seymchan-pallasite-slice');
    expect(await find('meteorites')).toContain('/item/campo-del-cielo-fragment');
    for (const q of ['sentinel', 'SENTINEL-PRIVATE-TITLE', 'hidden', '987654321']) {
      const html = await find(q);
      expect(html, q).toContain('No matches');
      for (const slug of HIDDEN_SLUGS) expect(html).not.toContain(`/item/${slug}`);
      // The page repeats the visitor's own query; nothing else may match a sentinel.
      expectNoSentinels(html.split(q).join(''), `search ${q}`);
    }
    // FTS syntax from visitors is just words.
    const res = await request.get(
      `${PUBLIC}/search?q=${encodeURIComponent('title:x OR "y" NEAR(z) *')}`,
    );
    expect(res.status()).toBe(200);
  });

  test('the feed fragment never contains non-public items', async ({ request }) => {
    for (const ctx of [
      '',
      'in=meteorites',
      'in=books',
      'in=sentinel-hidden-category',
      'q=sentinel',
    ]) {
      const res = await request.get(`${PUBLIC}/feed?${ctx}&offset=0&limit=5`);
      expect(res.status()).toBe(200);
      const html = await res.text();
      expectNoSentinels(html, `feed ${ctx}`);
      for (const slug of HIDDEN_SLUGS) expect(html).not.toContain(`/item/${slug}`);
    }
  });
});

test.describe('item page and feed (PUB-04, PUB-05)', () => {
  test('carousel arrows and keys move between photos', async ({ page }) => {
    await page.goto(`${PUBLIC}/item/seymchan-pallasite-slice`);
    const article = page.locator('article[data-item]').first();
    await expect(article.locator('[data-count]')).toHaveText('1 / 2');
    await article.getByRole('button', { name: 'Next photo' }).click();
    await expect(article.locator('[data-count]')).toHaveText('2 / 2');
    await article.getByRole('button', { name: 'Previous photo' }).click();
    await expect(article.locator('[data-count]')).toHaveText('1 / 2');
  });

  test('from a list: next item loads, the URL follows, Back returns to the list', async ({
    page,
  }) => {
    await page.goto(`${PUBLIC}/category/meteorites`);
    await page.getByRole('link', { name: 'Seymchan pallasite slice' }).click();
    await expect(page).toHaveURL(/\/item\/seymchan-pallasite-slice\?in=meteorites$/);
    await expect(page.locator('[data-feed] > article')).toHaveCount(3); // prefetched 2 ahead
    await page.getByRole('link', { name: /Next item/ }).click();
    await expect(page).toHaveURL(/\/item\/gibeon-iron-meteorite\?in=meteorites$/);
    await expect(page).toHaveTitle(/^Gibeon iron meteorite/);
    await expect(page.locator('[data-feed-pos]')).toHaveText('2 of 3');
    await page.keyboard.press('ArrowDown');
    await expect(page).toHaveURL(/\/item\/campo-del-cielo-fragment\?in=meteorites$/);
    await expect(page.locator('[data-feed-next]')).toBeHidden();
    await page.goBack();
    await expect(page).toHaveURL(/\/category\/meteorites$/);
  });

  test('works without JavaScript: plain previous/next links', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(`${PUBLIC}/item/gibeon-iron-meteorite?in=meteorites`);
    await expect(page.getByRole('link', { name: /Previous item/ })).toHaveAttribute(
      'href',
      '/item/seymchan-pallasite-slice?in=meteorites',
    );
    await expect(page.getByRole('link', { name: /Next item/ })).toHaveAttribute(
      'href',
      '/item/campo-del-cielo-fragment?in=meteorites',
    );
    await context.close();
  });

  test('link previews: Open Graph tags with a working absolute image', async ({
    page,
    request,
  }) => {
    await page.goto(`${PUBLIC}/item/seymchan-pallasite-slice`);
    const og = (p: string) => page.locator(`meta[property="og:${p}"]`).getAttribute('content');
    expect(await og('title')).toBe('Seymchan pallasite slice');
    expect(await og('url')).toBe(`${PUBLIC}/item/seymchan-pallasite-slice`);
    const image = (await og('image')) ?? '';
    expect(image.startsWith(`${PUBLIC}/media/`)).toBe(true);
    const res = await request.get(image);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('image/jpeg');
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      `${PUBLIC}/item/seymchan-pallasite-slice`,
    );
  });
});
