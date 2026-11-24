/**
 * What kind of file the owner picked, from its first bytes (MED-01). The file
 * name and the browser's MIME type are never trusted.
 */
import { ascii } from './bytes.ts';
import { isJpeg } from './jpeg.ts';
import { isWebp } from './webp.ts';

export type InputKind =
  'jpeg' | 'png' | 'webp' | 'avif' | 'heic' | 'gif' | 'video' | 'markup' | 'unknown';

/** Image inputs we accept (MED-01). Everything else is refused with a reason. */
export const ACCEPTED_IMAGE_INPUTS: ReadonlySet<InputKind> = new Set([
  'jpeg',
  'png',
  'webp',
  'avif',
  'heic',
]);

/** Bytes needed to recognise every kind (the ftyp box with a few brands). */
export const SNIFF_BYTES = 64;

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);
const AVIF_BRANDS = new Set(['avif', 'avis']);
const VIDEO_BRANDS = new Set(['isom', 'iso2', 'mp41', 'mp42', 'qt  ', 'avc1', 'M4V ', 'dash']);

function ftypBrands(b: Uint8Array): string[] | null {
  if (b.length < 16 || ascii(b, 4, 4) !== 'ftyp') return null;
  const size = Math.min(
    ((b[0] ?? 0) << 24) | ((b[1] ?? 0) << 16) | ((b[2] ?? 0) << 8) | (b[3] ?? 0),
    b.length,
  );
  const brands = [ascii(b, 8, 4)];
  for (let at = 16; at + 4 <= size; at += 4) brands.push(ascii(b, at, 4));
  return brands;
}

export function sniffInput(b: Uint8Array): InputKind {
  if (isJpeg(b)) return 'jpeg';
  if (
    b.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)
  ) {
    return 'png';
  }
  if (isWebp(b)) return 'webp';
  if (ascii(b, 0, 4) === 'GIF8') return 'gif';
  const brands = ftypBrands(b);
  if (brands) {
    if (brands.some((x) => AVIF_BRANDS.has(x))) return 'avif';
    if (brands.some((x) => HEIC_BRANDS.has(x))) return 'heic';
    if (brands.some((x) => VIDEO_BRANDS.has(x))) return 'video';
    return 'unknown';
  }
  // SVG, HTML, XML: text that starts (after a BOM and whitespace) with "<".
  let i = 0;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
  while (i < b.length && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0d)) i++;
  if (b[i] === 0x3c) return 'markup';
  return 'unknown';
}
