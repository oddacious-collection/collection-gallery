/**
 * The only metadata we ever write (MED-07): creator and copyright notice, as
 * a minimal little-endian TIFF/EXIF block with two ASCII tags in IFD0. No GPS,
 * no camera, no dates (D-43).
 *
 * Also a small reader, so the server and tests can check that stored files
 * carry exactly these tags and nothing else.
 */
import { FormatError, ascii, concat, setU16le, setU32le, u16le, u32le } from './bytes.ts';

export const TAG_ARTIST = 0x013b;
export const TAG_COPYRIGHT = 0x8298;
const TYPE_ASCII = 2;

/** Printable ASCII only (EXIF ASCII tags); anything else is dropped. */
export function exifAscii(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .trim();
}

export interface RightsMetadata {
  artist: string;
  copyright: string;
}

/** The rights metadata for an upload: the pen name (D-49) and the year. */
export function rightsFor(ownerName: string, year: number): RightsMetadata {
  const name = exifAscii(ownerName) || 'Unknown';
  return { artist: name, copyright: `Copyright ${year} ${name}` };
}

/** A TIFF block ("II*\0"...) with IFD0 = Artist, Copyright. */
export function buildRightsExif(rights: RightsMetadata): Uint8Array {
  const entries: Array<[number, Uint8Array]> = [
    [TAG_ARTIST, new TextEncoder().encode(`${exifAscii(rights.artist)}\0`)],
    [TAG_COPYRIGHT, new TextEncoder().encode(`${exifAscii(rights.copyright)}\0`)],
  ];
  const headerSize = 8;
  const ifdSize = 2 + entries.length * 12 + 4;
  const head = new Uint8Array(headerSize + ifdSize);
  head.set([0x49, 0x49, 0x2a, 0x00], 0);
  setU32le(head, 4, headerSize);
  setU16le(head, headerSize, entries.length);
  const data: Uint8Array[] = [];
  let dataOffset = headerSize + ifdSize;
  entries.forEach(([tag, value], i) => {
    const at = headerSize + 2 + i * 12;
    setU16le(head, at, tag);
    setU16le(head, at + 2, TYPE_ASCII);
    setU32le(head, at + 4, value.length);
    if (value.length <= 4) {
      head.set(value, at + 8);
    } else {
      setU32le(head, at + 8, dataOffset);
      const padded = value.length % 2 ? concat([value, new Uint8Array(1)]) : value;
      data.push(padded);
      dataOffset += padded.length;
    }
  });
  setU32le(head, headerSize + 2 + entries.length * 12, 0); // no IFD1
  return concat([head, ...data]);
}

export interface ExifSummary {
  /** Every tag in IFD0, in file order. */
  tags: number[];
  /** ASCII tag values. */
  text: Map<number, string>;
  /** True if IFD0 links to another IFD (IFD1, thumbnails). */
  hasNextIfd: boolean;
}

/** Reads IFD0 of a TIFF block (either byte order). */
export function readExif(tiff: Uint8Array): ExifSummary {
  const order = ascii(tiff, 0, 2);
  if (order !== 'II' && order !== 'MM') throw new FormatError('exif_header');
  const le = order === 'II';
  const r16 = (at: number) => (le ? u16le(tiff, at) : ((tiff[at] ?? 0) << 8) | (tiff[at + 1] ?? 0));
  const r32 = (at: number) =>
    le
      ? u32le(tiff, at)
      : (tiff[at] ?? 0) * 2 ** 24 +
        (((tiff[at + 1] ?? 0) << 16) | ((tiff[at + 2] ?? 0) << 8) | (tiff[at + 3] ?? 0));
  if (r16(2) !== 42) throw new FormatError('exif_header');
  const ifd = r32(4);
  if (ifd + 2 > tiff.length) throw new FormatError('truncated');
  const count = r16(ifd);
  if (ifd + 2 + count * 12 + 4 > tiff.length) throw new FormatError('truncated');
  const tags: number[] = [];
  const text = new Map<number, string>();
  for (let i = 0; i < count; i++) {
    const at = ifd + 2 + i * 12;
    const tag = r16(at);
    tags.push(tag);
    if (r16(at + 2) === TYPE_ASCII) {
      const n = r32(at + 4);
      const off = n <= 4 ? at + 8 : r32(at + 8);
      if (off + n > tiff.length) throw new FormatError('truncated');
      let s = ascii(tiff, off, n);
      while (s.endsWith('\0')) s = s.slice(0, -1);
      text.set(tag, s);
    }
  }
  return { tags, text, hasNextIfd: r32(ifd + 2 + count * 12) !== 0 };
}

/**
 * True if a TIFF block is exactly our rights metadata: byte for byte what
 * `buildRightsExif` writes for its two values, so nothing can hide in padding,
 * extra IFDs or bytes after the tags.
 */
export function isRightsOnly(tiff: Uint8Array): boolean {
  try {
    const s = readExif(tiff);
    const artist = s.text.get(TAG_ARTIST);
    const copyright = s.text.get(TAG_COPYRIGHT);
    if (artist === undefined || copyright === undefined) return false;
    const expected = buildRightsExif({ artist, copyright });
    return expected.length === tiff.length && expected.every((v, i) => tiff[i] === v);
  } catch {
    return false;
  }
}
