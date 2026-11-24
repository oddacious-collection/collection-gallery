/**
 * Synthetic JPEG and WebP files for tests. They have the exact structure a
 * real encoder writes (markers, chunks, headers with dimensions) but dummy
 * compressed data: the server never decodes pixels, it checks structure.
 * Real browser-encoded files are covered by the e2e photo pipeline test.
 */
import { buildRightsExif } from '../src/media/exif.ts';

const enc = new TextEncoder();

export const SENTINEL = 'GPS-SENTINEL-51.5007N-0.1246W SN-4242';

function seg(marker: number, body: Uint8Array): Uint8Array {
  const len = body.length + 2;
  return new Uint8Array([0xff, marker, len >> 8, len & 0xff, ...body]);
}

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** An APP1 EXIF segment carrying a GPS-looking sentinel (stands in for camera EXIF). */
export function cameraExifSegment(): Uint8Array {
  return seg(
    0xe1,
    join([
      enc.encode('Exif\0\0'),
      buildRightsExif({ artist: 'x', copyright: 'y' }),
      enc.encode(SENTINEL),
    ]),
  );
}

export interface JpegOptions {
  width: number;
  height: number;
  /** Extra segments inserted after SOI (APPn, COM …). */
  extra?: Uint8Array[];
  sofMarker?: number;
  trailing?: Uint8Array;
  /** Pad the scan data to make a file of roughly this many bytes. */
  minBytes?: number;
}

export function makeJpeg(o: JpegOptions): Uint8Array {
  const dqt = seg(0xdb, new Uint8Array(65).fill(1));
  const sof = seg(
    o.sofMarker ?? 0xc0,
    new Uint8Array([
      8,
      o.height >> 8,
      o.height & 0xff,
      o.width >> 8,
      o.width & 0xff,
      3,
      1,
      0x22,
      0,
      2,
      0x11,
      1,
      3,
      0x11,
      1,
    ]),
  );
  const dht = seg(0xc4, new Uint8Array([0x00, 1, ...new Array<number>(15).fill(0), 0x00]));
  const sos = seg(0xda, new Uint8Array([3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]));
  // Entropy-coded data with a stuffed 0xFF00 and a restart marker inside.
  const scanLength = Math.max(16, (o.minBytes ?? 0) - 200);
  const scan = new Uint8Array(scanLength).fill(0x55);
  scan.set([0xff, 0x00], 4);
  scan.set([0xff, 0xd0], 8);
  return join([
    new Uint8Array([0xff, 0xd8]),
    ...(o.extra ?? []),
    dqt,
    sof,
    dht,
    sos,
    scan,
    new Uint8Array([0xff, 0xd9]),
    ...(o.trailing ? [o.trailing] : []),
  ]);
}

function chunk(fourcc: string, data: Uint8Array): Uint8Array {
  const pad = data.length % 2;
  const out = new Uint8Array(8 + data.length + pad);
  out.set(enc.encode(fourcc), 0);
  new DataView(out.buffer).setUint32(4, data.length, true);
  out.set(data, 8);
  return out;
}

function riff(chunks: Uint8Array[], trailing?: Uint8Array): Uint8Array {
  const body = join(chunks);
  const head = new Uint8Array(12);
  head.set(enc.encode('RIFF'), 0);
  new DataView(head.buffer).setUint32(4, 4 + body.length, true);
  head.set(enc.encode('WEBP'), 8);
  return join([head, body, ...(trailing ? [trailing] : [])]);
}

export function vp8Chunk(width: number, height: number, payload = 32): Uint8Array {
  const data = new Uint8Array(10 + payload).fill(0x33);
  data.set([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a], 0);
  const v = new DataView(data.buffer);
  v.setUint16(6, width, true);
  v.setUint16(8, height, true);
  return chunk('VP8 ', data);
}

export function vp8lChunk(width: number, height: number, alpha = false): Uint8Array {
  const data = new Uint8Array(5 + 20).fill(0x11);
  data[0] = 0x2f;
  const bits = (width - 1) | ((height - 1) << 14) | ((alpha ? 1 : 0) << 28);
  new DataView(data.buffer).setUint32(1, bits >>> 0, true);
  return chunk('VP8L', data);
}

export function vp8xChunk(width: number, height: number, flags = 0): Uint8Array {
  const data = new Uint8Array(10);
  data[0] = flags;
  const v = new DataView(data.buffer);
  v.setUint16(4, (width - 1) & 0xffff, true);
  data[6] = ((width - 1) >> 16) & 0xff;
  v.setUint16(7, (height - 1) & 0xffff, true);
  data[9] = ((height - 1) >> 16) & 0xff;
  return chunk('VP8X', data);
}

export interface WebpOptions {
  width: number;
  height: number;
  lossless?: boolean;
  /** Raw extra chunks; a VP8X header is added with the given flags. */
  extended?: { flags: number; before?: Uint8Array[]; after?: Uint8Array[] };
  trailing?: Uint8Array;
  payload?: number;
}

export function makeWebp(o: WebpOptions): Uint8Array {
  const image = o.lossless ? vp8lChunk(o.width, o.height) : vp8Chunk(o.width, o.height, o.payload);
  if (!o.extended) return riff([image], o.trailing);
  return riff(
    [
      vp8xChunk(o.width, o.height, o.extended.flags),
      ...(o.extended.before ?? []),
      image,
      ...(o.extended.after ?? []),
    ],
    o.trailing,
  );
}

export function exifChunk(): Uint8Array {
  return chunk(
    'EXIF',
    join([buildRightsExif({ artist: 'a', copyright: 'b' }), enc.encode(SENTINEL)]),
  );
}

export function bytesContain(haystack: Uint8Array, needle: string): boolean {
  const n = enc.encode(needle);
  outer: for (let i = 0; i + n.length <= haystack.length; i++) {
    for (let j = 0; j < n.length; j++) if (haystack[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
}

export const SVG = enc.encode(
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);
export const HTML_TAIL = enc.encode('<html><script>alert(1)</script></html>');
