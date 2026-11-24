/**
 * The on-device photo pipeline (MED-02, MED-05, D-43, D-44, D-48, TST-05) in
 * real browsers: Chromium, desktop Safari (WebKit) and iPhone Safari.
 *
 * The built admin can't be signed in to locally (no Cloudflare Access), so
 * this test serves a minimal copy of the item editor's photo section from an
 * intercepted origin, with:
 * - the REAL built admin script (apps/admin/dist, the code that deploys);
 * - the REAL admin security headers, CSP and Trusted Types included;
 * - the admin upload API stubbed: it plans with the same core function as the
 *   server and captures every uploaded file.
 * The captured files are then checked with the server's own verifier. The
 * server side (verification, storage, rights metadata) is covered by the core
 * unit tests in workerd.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';
import { securityHeaders } from '../../packages/core/src/headers.ts';
import { uploadPlan, verifyPart, type PlannedPart } from '../../packages/core/src/media/index.ts';
import { SENTINELS } from './fixtures/make-photo-fixture.ts';

const ORIGIN = 'http://admin.photo-harness.localhost';
const ITEM = '01J0000000000000000000ITEM';
const ASSETS = path.join(import.meta.dirname, '../../apps/admin/dist/client/_astro');
const FIXTURE = path.join(import.meta.dirname, 'fixtures/camera-photo.jpg');

test.describe.configure({ timeout: 180_000 });

/** The built editor script: the one that contains the photo uploader. */
function editorScript(): string {
  const name = readdirSync(ASSETS).find(
    (f) =>
      f.endsWith('.js') && readFileSync(path.join(ASSETS, f), 'utf8').includes('data-photo-input'),
  );
  if (!name) throw new Error('Build the admin first (npm run build).');
  return name;
}

const PAGE = (script: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Photo harness</title>
<script type="module" src="/_astro/${script}"></script></head>
<body><main>
<section data-photos data-item-id="${ITEM}">
  <label for="photo-input">Add photos</label>
  <input id="photo-input" type="file" accept="image/*" multiple data-photo-input>
  <ul data-photo-progress aria-live="polite"></ul>
</section>
</main></body></html>`;

interface Capture {
  plan: PlannedPart[] | null;
  files: Map<string, Buffer>;
  finalized: boolean;
  requests: string[];
  /** CSP / Trusted Types violations and page errors, across reloads. */
  violations: string[];
}

async function harness(page: Page): Promise<Capture> {
  const capture: Capture = {
    plan: null,
    files: new Map(),
    finalized: false,
    requests: [],
    violations: [],
  };
  const headers = securityHeaders({ host: 'admin', environment: 'local' });
  const script = editorScript();

  // Report every CSP / Trusted Types violation to the test. The page reloads
  // itself after a successful upload, so this goes through the console
  // rather than page state.
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(`CSP-VIOLATION ${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  page.on('console', (m) => {
    if (
      m.text().startsWith('CSP-VIOLATION') ||
      /Content Security Policy|Trusted Type/i.test(m.text())
    ) {
      capture.violations.push(m.text());
    }
  });
  page.on('pageerror', (e) => capture.violations.push(`pageerror: ${e.message}`));

  await page.route(`${ORIGIN}/**`, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    capture.requests.push(`${req.method()} ${url.pathname}`);
    const json = (status: number, body: unknown) =>
      route.fulfill({
        status,
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    if (url.pathname === '/') {
      return route.fulfill({
        status: 200,
        headers: { ...headers, 'content-type': 'text/html; charset=utf-8' },
        body: PAGE(script),
      });
    }
    if (url.pathname.startsWith('/_astro/')) {
      const file = path.join(ASSETS, path.basename(url.pathname));
      const type = file.endsWith('.wasm')
        ? 'application/wasm'
        : file.endsWith('.css')
          ? 'text/css'
          : 'text/javascript';
      return route.fulfill({
        status: 200,
        headers: { ...headers, 'content-type': type },
        body: readFileSync(file),
      });
    }
    // The CSRF contract every admin write must meet (SEC-04).
    if (req.method() !== 'GET') {
      expect(req.headers()['x-cg-request']).toBe('1');
    }
    if (req.method() === 'POST' && url.pathname === `/api/items/${ITEM}/media`) {
      const { width, height } = req.postDataJSON() as { width: number; height: number };
      capture.plan = uploadPlan(width, height);
      return json(201, {
        uploadId: 'harnessupload00000000000000'.slice(0, 26),
        parts: capture.plan,
      });
    }
    const put = /^\/api\/uploads\/[a-z0-9]{26}\/([a-z0-9]+)$/.exec(url.pathname);
    if (req.method() === 'PUT' && put?.[1]) {
      capture.files.set(put[1], req.postDataBuffer() ?? Buffer.alloc(0));
      return json(200, { name: put[1] });
    }
    if (req.method() === 'POST' && url.pathname.endsWith('/finalize')) {
      capture.finalized = true;
      return json(201, { mediaId: '01J0000000000000000000MEDIA' });
    }
    return route.fulfill({ status: 404, headers, body: 'Not found\n' });
  });
  await page.goto(`${ORIGIN}/`);
  return capture;
}

function contains(bytes: Buffer, text: string): boolean {
  return bytes.includes(Buffer.from(text, 'latin1'));
}

/** RGB at (x, y) of an image file, decoded by the browser. */
async function pixel(
  page: Page,
  bytes: Buffer,
  type: string,
  x: number,
  y: number,
): Promise<number[]> {
  return page.evaluate(
    async ({ b64, type, x, y }) => {
      const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([raw], { type }));
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext('2d') as CanvasRenderingContext2D;
      ctx.drawImage(bmp, 0, 0);
      return Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3));
    },
    { b64: bytes.toString('base64'), type, x, y },
  );
}

function near(rgb: number[], target: number[]): boolean {
  return rgb.every((v, i) => Math.abs(v - (target[i] ?? 0)) < 60);
}

test('a camera photo: rotated upright, every byte of metadata gone, all sizes made', async ({
  page,
}) => {
  const capture = await harness(page);
  await page.setInputFiles('input[data-photo-input]', FIXTURE);
  await expect.poll(() => capture.finalized, { timeout: 120_000 }).toBe(true);

  // Orientation 6 applied: 600×400 stored → 400×600 upright.
  expect(capture.plan?.map((p) => `${p.name} ${p.width}x${p.height}`)).toEqual([
    'original 400x600',
    'w400 267x400',
    'w600 400x600',
    'og 400x600',
  ]);
  for (const part of capture.plan ?? []) {
    const bytes = capture.files.get(part.name);
    expect(bytes, part.name).toBeDefined();
    // Exactly what the server accepts: right type, structure and size, NO metadata.
    expect(verifyPart(new Uint8Array(bytes as Buffer), part), part.name).toEqual({ ok: true });
    for (const s of SENTINELS)
      expect(contains(bytes as Buffer, s), `${part.name} contains ${s}`).toBe(false);
    for (const s of ['Exif', 'http://ns.adobe.com', 'GPS'])
      expect(contains(bytes as Buffer, s), `${part.name}: ${s}`).toBe(false);
  }

  // Pixels: green band on the right, red top-left, blue bottom-left. Decoded
  // in a separate page (the harness page reloads itself after an upload).
  const viewer = await page.context().newPage();
  for (const name of ['original', 'w600']) {
    const part = capture.plan?.find((p) => p.name === name) as PlannedPart;
    const bytes = capture.files.get(name) as Buffer;
    expect(
      near(await pixel(viewer, bytes, part.format, 390, 300), [0, 192, 0]),
      `${name} right`,
    ).toBe(true);
    expect(
      near(await pixel(viewer, bytes, part.format, 20, 20), [224, 0, 0]),
      `${name} top-left`,
    ).toBe(true);
    expect(
      near(await pixel(viewer, bytes, part.format, 20, 580), [0, 0, 224]),
      `${name} bottom-left`,
    ).toBe(true);
  }

  // The real admin CSP (with Trusted Types and only 'wasm-unsafe-eval' added) held.
  expect(capture.violations).toEqual([]);
});

test('a large photo is capped at 4608 px with every derivative size', async ({
  page,
  browserName,
}, testInfo) => {
  test.skip(
    testInfo.project.name === 'mobile-webkit',
    'covered on desktop; phone emulation adds nothing here',
  );
  void browserName;
  const capture = await harness(page);
  // A 6000×4000 JPEG made in the page and handed to the file input.
  await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 6000;
    c.height = 4000;
    const ctx = c.getContext('2d') as CanvasRenderingContext2D;
    const g = ctx.createLinearGradient(0, 0, 6000, 4000);
    g.addColorStop(0, '#345');
    g.addColorStop(1, '#fc8');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 6000, 4000);
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b as Blob), 'image/jpeg', 0.9));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'big.jpg', { type: 'image/jpeg' }));
    const input = document.querySelector('input[data-photo-input]') as HTMLInputElement;
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect.poll(() => capture.finalized, { timeout: 150_000 }).toBe(true);
  expect(capture.plan?.map((p) => `${p.name} ${p.width}x${p.height}`)).toEqual([
    'original 4608x3072',
    'w400 400x267',
    'w800 800x533',
    'w1200 1200x800',
    'w1600 1600x1067',
    'w2048 2048x1365',
    'og 1200x800',
  ]);
  for (const part of capture.plan ?? []) {
    expect(
      verifyPart(new Uint8Array(capture.files.get(part.name) as Buffer), part),
      part.name,
    ).toEqual({ ok: true });
  }
});

test('refused files: nothing is processed or sent', async ({ page }) => {
  const capture = await harness(page);
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  );
  const gif = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1');
  const heic = Buffer.concat([
    Buffer.from('\0\0\0\x18ftypheic\0\0\0\0mif1heic', 'latin1'),
    Buffer.alloc(64, 7),
  ]);
  await page.setInputFiles('input[data-photo-input]', [
    { name: 'drawing.svg', mimeType: 'image/svg+xml', buffer: svg },
    { name: 'anim.gif', mimeType: 'image/gif', buffer: gif },
    { name: 'IMG_0001.HEIC', mimeType: 'image/heic', buffer: heic },
  ]);
  const rows = page.locator('[data-photo-progress] li');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('never accepted');
  await expect(rows.nth(1)).toContainText('GIF files are not accepted');
  await expect(rows.nth(2)).toContainText('HEIC');
  await expect(page.locator('input[data-photo-input]')).toBeEnabled();
  expect(capture.requests.filter((r) => r.includes('/api/'))).toEqual([]);
  expect(capture.violations).toEqual([]);
});
