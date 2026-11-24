/**
 * A strict structural walk of a JPEG file (MED-02/03, ABU-02). It doesn't
 * decode pixels; it checks that the file is exactly one well-formed baseline
 * or progressive image and nothing else:
 *
 * - starts with SOI and ends at EOI, with no trailing bytes (polyglots);
 * - only the markers a plain encoder writes (SOF0/1/2, DHT, DQT, DRI, SOS,
 *   RSTn inside scans); anything else is rejected;
 * - metadata segments (APP0–APP15, COM) are reported, so the client can strip
 *   them and the server can refuse files that still carry any.
 */
import { FormatError, concat, u16be } from './bytes.ts';
import { buildRightsExif, isRightsOnly, type RightsMetadata } from './exif.ts';

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const COM = 0xfe;
const APP0 = 0xe0;
const APP15 = 0xef;
const ALLOWED_SOF = new Set([0xc0, 0xc1, 0xc2]);
const ALLOWED_TABLES = new Set([0xc4, 0xdb, 0xdd]); // DHT, DQT, DRI
const EXIF_ID = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"

export interface JpegSegment {
  marker: number;
  /** Byte range of the whole segment, marker included. */
  start: number;
  end: number;
}

export interface JpegInfo {
  width: number;
  height: number;
  components: number;
  /** APPn and COM segments, in file order. */
  metadata: JpegSegment[];
  /** Every range to keep when stripping metadata (SOI .. EOI, minus metadata). */
  keep: Array<[number, number]>;
}

export function isJpeg(b: Uint8Array): boolean {
  return b.length >= 3 && b[0] === 0xff && b[1] === SOI && b[2] === 0xff;
}

export function parseJpeg(b: Uint8Array): JpegInfo {
  if (!isJpeg(b)) throw new FormatError('not_jpeg');
  const metadata: JpegSegment[] = [];
  const keep: Array<[number, number]> = [[0, 2]];
  let size: { width: number; height: number; components: number } | null = null;
  let scans = 0;
  let pos = 2;

  for (;;) {
    if (pos >= b.length) throw new FormatError('truncated');
    if (b[pos] !== 0xff) throw new FormatError('bad_marker');
    const start = pos;
    while (b[pos] === 0xff) pos++; // fill bytes
    const marker = b[pos++];
    if (marker === undefined) throw new FormatError('truncated');

    if (marker === EOI) {
      if (pos !== b.length) throw new FormatError('trailing_data');
      if (!size || scans === 0) throw new FormatError('no_image');
      keep.push([start, pos]);
      return { ...size, metadata, keep };
    }
    if (marker === SOI || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      throw new FormatError('bad_marker');
    }

    const length = u16be(b, pos);
    if (length < 2) throw new FormatError('bad_segment');
    const end = pos + length;
    if (end > b.length) throw new FormatError('truncated');
    const segment: JpegSegment = { marker, start, end };

    if ((marker >= APP0 && marker <= APP15) || marker === COM) {
      metadata.push(segment);
    } else if (ALLOWED_SOF.has(marker)) {
      if (size) throw new FormatError('multiple_frames');
      if (length < 8) throw new FormatError('bad_segment');
      const height = u16be(b, pos + 3);
      const width = u16be(b, pos + 5);
      const components = b[pos + 7] ?? 0;
      if (width === 0 || height === 0) throw new FormatError('bad_dimensions');
      if (components !== 1 && components !== 3) throw new FormatError('bad_components');
      size = { width, height, components };
      keep.push([start, end]);
    } else if (ALLOWED_TABLES.has(marker)) {
      keep.push([start, end]);
    } else if (marker === SOS) {
      if (!size) throw new FormatError('scan_before_frame');
      scans++;
      // Entropy-coded data runs until the next marker that isn't a stuffed
      // 0xFF00 or a restart marker.
      let i = end;
      for (;;) {
        if (i + 1 >= b.length) throw new FormatError('truncated');
        if (b[i] === 0xff) {
          const next = b[i + 1] ?? 0;
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
            i += 2;
            continue;
          }
          if (next === 0xff) {
            i += 1;
            continue;
          }
          break;
        }
        i++;
      }
      keep.push([start, i]);
      pos = i;
      continue;
    } else {
      throw new FormatError('unsupported_marker');
    }
    pos = end;
  }
}

/** The same image with every APPn and COM segment removed. */
export function stripJpegMetadata(b: Uint8Array): Uint8Array {
  const info = parseJpeg(b);
  return concat(info.keep.map(([s, e]) => b.subarray(s, e)));
}

/**
 * Adds our rights metadata (MED-07) as one APP1 EXIF segment right after SOI.
 * The input must carry no metadata at all.
 */
export function addJpegRights(b: Uint8Array, rights: RightsMetadata): Uint8Array {
  const info = parseJpeg(b);
  if (info.metadata.length > 0) throw new FormatError('has_metadata');
  const tiff = buildRightsExif(rights);
  const length = 2 + EXIF_ID.length + tiff.length;
  const app1 = concat([
    new Uint8Array([0xff, 0xe1, (length >>> 8) & 0xff, length & 0xff, ...EXIF_ID]),
    tiff,
  ]);
  return concat([b.subarray(0, 2), app1, b.subarray(2)]);
}

/** The TIFF block of an APP1 EXIF segment. */
function exifOf(b: Uint8Array, seg: JpegSegment): Uint8Array | null {
  if (seg.marker !== 0xe1) return null;
  const body = b.subarray(seg.start + 4, seg.end);
  if (EXIF_ID.some((v, i) => body[i] !== v)) return null;
  return body.subarray(EXIF_ID.length);
}

/** True if the file's only metadata is exactly our rights EXIF segment. */
export function hasOnlyRightsMetadata(b: Uint8Array): boolean {
  const { metadata } = parseJpeg(b);
  if (metadata.length !== 1) return false;
  const [seg] = metadata;
  const tiff = seg ? exifOf(b, seg) : null;
  return tiff !== null && isRightsOnly(tiff);
}
