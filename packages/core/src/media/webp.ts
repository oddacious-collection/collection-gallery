/**
 * A strict structural walk of a still WebP file (MED-03, ABU-02): one RIFF
 * container of exactly the file's length (no trailing bytes), holding one
 * image (VP8, VP8L, or VP8X + optional ALPH + VP8). Metadata chunks (EXIF,
 * XMP, ICCP) are reported; animation and unknown chunks are rejected.
 */
import { FormatError, ascii, concat, setU24le, setU32le, u16le, u24le, u32le } from './bytes.ts';
import { buildRightsExif, isRightsOnly, type RightsMetadata } from './exif.ts';

const VP8X_ICC = 0x20;
const VP8X_ALPHA = 0x10;
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;
const VP8X_ANIM = 0x02;
const METADATA_CHUNKS = new Set(['EXIF', 'XMP ', 'ICCP']);

export interface WebpChunk {
  fourcc: string;
  /** Range of the whole chunk (header, data and padding). */
  start: number;
  end: number;
  dataStart: number;
  dataEnd: number;
}

export interface WebpInfo {
  width: number;
  height: number;
  hasAlpha: boolean;
  chunks: WebpChunk[];
  metadata: WebpChunk[];
}

export function isWebp(b: Uint8Array): boolean {
  return b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP';
}

function vp8Size(b: Uint8Array, c: WebpChunk): { width: number; height: number } {
  const d = c.dataStart;
  if (c.dataEnd - d < 10) throw new FormatError('truncated');
  if (((b[d] ?? 1) & 1) !== 0) throw new FormatError('not_keyframe');
  if (b[d + 3] !== 0x9d || b[d + 4] !== 0x01 || b[d + 5] !== 0x2a) {
    throw new FormatError('bad_vp8');
  }
  return { width: u16le(b, d + 6) & 0x3fff, height: u16le(b, d + 8) & 0x3fff };
}

function vp8lSize(b: Uint8Array, c: WebpChunk): { width: number; height: number; alpha: boolean } {
  const d = c.dataStart;
  if (c.dataEnd - d < 5) throw new FormatError('truncated');
  if (b[d] !== 0x2f) throw new FormatError('bad_vp8l');
  const bits = u32le(b, d + 1);
  if (bits >>> 29 !== 0) throw new FormatError('bad_vp8l');
  return {
    width: (bits & 0x3fff) + 1,
    height: ((bits >>> 14) & 0x3fff) + 1,
    alpha: ((bits >>> 28) & 1) === 1,
  };
}

export function parseWebp(b: Uint8Array): WebpInfo {
  if (!isWebp(b)) throw new FormatError('not_webp');
  if (u32le(b, 4) + 8 !== b.length) throw new FormatError('trailing_data');
  const chunks: WebpChunk[] = [];
  let pos = 12;
  while (pos < b.length) {
    if (pos + 8 > b.length) throw new FormatError('truncated');
    const size = u32le(b, pos + 4);
    const dataEnd = pos + 8 + size;
    const end = dataEnd + (size % 2);
    if (end > b.length) throw new FormatError('truncated');
    chunks.push({ fourcc: ascii(b, pos, 4), start: pos, end, dataStart: pos + 8, dataEnd });
    pos = end;
  }

  const metadata = chunks.filter((c) => METADATA_CHUNKS.has(c.fourcc));
  const image = chunks.filter((c) => !METADATA_CHUNKS.has(c.fourcc));
  const names = image.map((c) => c.fourcc).join(',');
  let width: number;
  let height: number;
  let hasAlpha = false;

  const [first] = chunks;
  if (!first) throw new FormatError('no_image');
  if (names === 'VP8 ' || names === 'VP8L') {
    if (metadata.length > 0) throw new FormatError('metadata_without_vp8x');
    const img = image[0] as WebpChunk;
    if (img.fourcc === 'VP8L') {
      const s = vp8lSize(b, img);
      ({ width, height } = s);
      hasAlpha = s.alpha;
    } else {
      ({ width, height } = vp8Size(b, img));
    }
  } else if (names === 'VP8X,VP8 ' || names === 'VP8X,ALPH,VP8 ' || names === 'VP8X,VP8L') {
    if (first.fourcc !== 'VP8X') throw new FormatError('bad_layout');
    if (first.dataEnd - first.dataStart !== 10) throw new FormatError('bad_vp8x');
    const flags = b[first.dataStart] ?? 0;
    if (flags & VP8X_ANIM) throw new FormatError('animated');
    width = u24le(b, first.dataStart + 4) + 1;
    height = u24le(b, first.dataStart + 7) + 1;
    hasAlpha = (flags & VP8X_ALPHA) !== 0;
    const img = image[image.length - 1] as WebpChunk;
    const inner = img.fourcc === 'VP8L' ? vp8lSize(b, img) : vp8Size(b, img);
    if (inner.width !== width || inner.height !== height) throw new FormatError('size_mismatch');
    const declared = { ICCP: VP8X_ICC, EXIF: VP8X_EXIF, 'XMP ': VP8X_XMP } as const;
    for (const m of metadata) {
      if (!(flags & declared[m.fourcc as keyof typeof declared])) {
        throw new FormatError('undeclared_metadata');
      }
    }
  } else {
    throw new FormatError('unsupported_chunks');
  }
  if (width === 0 || height === 0) throw new FormatError('bad_dimensions');
  return { width, height, hasAlpha, chunks, metadata };
}

/**
 * Adds our rights metadata (MED-07) as an EXIF chunk, converting a simple
 * (VP8/VP8L) file to the extended (VP8X) layout the spec requires for it.
 * The input must carry no metadata at all.
 */
export function addWebpRights(b: Uint8Array, rights: RightsMetadata): Uint8Array {
  const info = parseWebp(b);
  if (info.metadata.length > 0) throw new FormatError('has_metadata');
  const tiff = buildRightsExif(rights);
  const exif = new Uint8Array(8 + tiff.length + (tiff.length % 2));
  exif.set([0x45, 0x58, 0x49, 0x46], 0); // "EXIF"
  setU32le(exif, 4, tiff.length);
  exif.set(tiff, 8);

  let body: Uint8Array;
  const [first] = info.chunks;
  if (first?.fourcc === 'VP8X') {
    body = b.slice(12);
    body[8] = (body[8] ?? 0) | VP8X_EXIF;
  } else {
    const vp8x = new Uint8Array(18);
    vp8x.set([0x56, 0x50, 0x38, 0x58], 0); // "VP8X"
    setU32le(vp8x, 4, 10);
    vp8x[8] = VP8X_EXIF | (info.hasAlpha ? VP8X_ALPHA : 0);
    setU24le(vp8x, 12, info.width - 1);
    setU24le(vp8x, 15, info.height - 1);
    body = concat([vp8x, b.subarray(12)]);
  }
  const header = new Uint8Array(12);
  header.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  setU32le(header, 4, 4 + body.length + exif.length);
  header.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
  return concat([header, body, exif]);
}

/** True if the file's only metadata is exactly our rights EXIF chunk. */
export function webpHasOnlyRightsMetadata(b: Uint8Array): boolean {
  const { metadata } = parseWebp(b);
  if (metadata.length !== 1 || metadata[0]?.fourcc !== 'EXIF') return false;
  const m = metadata[0];
  return isRightsOnly(b.subarray(m.dataStart, m.dataEnd));
}
