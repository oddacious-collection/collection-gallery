/**
 * Makes the small real photos used to seed local data for e2e tests
 * (scripts/seed-local.ts): for each colour, a 400 × 300 JPEG (browser
 * canvas, metadata stripped) and the matching WebP (libwebp via
 * @jsquash/webp, the same encoder the admin uses). Run once and commit:
 *
 *   node tests/e2e/fixtures/make-seed-images.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { webkit } from '@playwright/test';
import { stripJpegMetadata } from '../../../packages/core/src/media/index.ts';

export const SEED_COLOURS = ['#8a5a2b', '#2b6f8a', '#5f8a2b', '#8a2b5f'] as const;
export const seedImagePath = (i: number, ext: 'jpg' | 'webp') =>
  path.join(import.meta.dirname, `seed-${i}.${ext}`);

async function main(): Promise<void> {
  const browser = await webkit.launch();
  const page = await browser.newPage();
  const pixels: Array<{ jpeg: string; rgba: number[] }> = [];
  for (const colour of SEED_COLOURS) {
    pixels.push(
      await page.evaluate(async (c) => {
        const canvas = document.createElement('canvas');
        canvas.width = 400;
        canvas.height = 300;
        const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
        ctx.fillStyle = c;
        ctx.fillRect(0, 0, 400, 300);
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.beginPath();
        ctx.arc(200, 150, 90, 0, Math.PI * 2);
        ctx.fill();
        const blob = await new Promise<Blob>((r) =>
          canvas.toBlob((b) => r(b as Blob), 'image/jpeg', 0.9),
        );
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let s = '';
        for (const b of bytes) s += String.fromCharCode(b);
        return { jpeg: btoa(s), rgba: Array.from(ctx.getImageData(0, 0, 400, 300).data) };
      }, colour),
    );
  }
  await browser.close();

  const require = createRequire(import.meta.url);
  const dir = path.dirname(require.resolve('@jsquash/webp/package.json'));
  const { init, default: encode } = (await import('@jsquash/webp/encode.js')) as unknown as {
    init: (m: WebAssembly.Module) => Promise<unknown>;
    default: (
      d: { data: Uint8ClampedArray; width: number; height: number },
      o: object,
    ) => Promise<ArrayBuffer>;
  };
  await init(
    await WebAssembly.compile(readFileSync(path.join(dir, 'codec/enc/webp_enc_simd.wasm'))),
  );

  for (const [i, p] of pixels.entries()) {
    writeFileSync(seedImagePath(i, 'jpg'), stripJpegMetadata(Buffer.from(p.jpeg, 'base64')));
    const webp = await encode(
      { data: new Uint8ClampedArray(p.rgba), width: 400, height: 300 },
      { quality: 75 },
    );
    writeFileSync(seedImagePath(i, 'webp'), new Uint8Array(webp));
  }
  console.log(`wrote ${pixels.length} JPEG + WebP pairs`);
}

if (import.meta.main) await main();
