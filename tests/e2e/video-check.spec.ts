/**
 * The video device check page (M4 step 2, D-61) under the REAL admin security
 * headers: the built script (Mediabunny included) loads and finishes its
 * capability report with no CSP or Trusted Types violation. Which codecs a
 * browser reports depends on the browser build (Playwright's own Chromium
 * lacks H.264), so only that the report completes is checked here; the real
 * answers come from the owner's devices.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Route } from '@playwright/test';
import { securityHeaders } from '../../packages/core/src/headers.ts';

const ORIGIN = 'http://admin.video-harness.localhost';
const ASSETS = path.join(import.meta.dirname, '../../apps/admin/dist/client/_astro');

function checkScript(): string {
  const name = readdirSync(ASSETS).find(
    (f) =>
      f.endsWith('.js') &&
      readFileSync(path.join(ASSETS, f), 'utf8').includes('Screen wake lock API'),
  );
  if (!name) throw new Error('Build the admin first (npm run build).');
  return name;
}

const PAGE = (script: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Video harness</title>
<script type="module" src="/_astro/${script}"></script></head>
<body><main>
<pre id="caps">Checking…</pre>
<input id="clip" type="file"><input id="trim" type="checkbox">
<button id="run" disabled>Process</button><button id="stop" hidden>Stop</button>
<progress id="progress" hidden></progress><pre id="result"></pre>
<p id="download-row" hidden><a id="download">Download</a></p>
</main></body></html>`;

test('the video check page reports capabilities under the admin CSP and Trusted Types', async ({
  page,
}) => {
  const headers = securityHeaders({ host: 'admin', environment: 'local' });
  const script = checkScript();
  const violations: string[] = [];
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(`CSP-VIOLATION ${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  page.on('console', (m) => {
    if (
      m.text().startsWith('CSP-VIOLATION') ||
      /Content Security Policy|Trusted Type/i.test(m.text())
    )
      violations.push(m.text());
  });
  page.on('pageerror', (e) => violations.push(`pageerror: ${e.message}`));
  await page.route(`${ORIGIN}/**`, async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({
        status: 200,
        headers: { ...headers, 'content-type': 'text/html; charset=utf-8' },
        body: PAGE(script),
      });
    }
    const file = path.join(ASSETS, path.basename(url.pathname));
    return route.fulfill({
      status: 200,
      headers: {
        ...headers,
        'content-type': file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
      },
      body: readFileSync(file),
    });
  });

  await page.goto(`${ORIGIN}/`);
  await expect(page.locator('#caps')).toContainText('Screen wake lock API', { timeout: 30_000 });
  await expect(page.locator('#caps')).toContainText('Decode HEVC 1080p');
  expect(violations).toEqual([]);
});
