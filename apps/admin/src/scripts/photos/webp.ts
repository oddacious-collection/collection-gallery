/**
 * WebP encoding with libwebp compiled to WebAssembly (D-44): Safari can't
 * encode WebP from a canvas. Loaded only when the owner adds a photo; the
 * admin CSP allows WebAssembly compilation ('wasm-unsafe-eval') and nothing
 * else beyond 'self'.
 */
import type { WebpEncoder } from './process.ts';

export const WEBP_QUALITY = 80;

type Encode = (data: ImageData, options?: { quality?: number }) => Promise<ArrayBuffer>;

let encoder: Promise<Encode> | null = null;

export const encodeWebp: WebpEncoder = async (image) => {
  encoder ??= import('@jsquash/webp/encode').then((m) => m.default as Encode);
  const encode = await encoder;
  return new Uint8Array(await encode(image, { quality: WEBP_QUALITY }));
};
