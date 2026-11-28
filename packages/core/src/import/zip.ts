/**
 * Reading single files out of a large zip without loading it all (D-70): the
 * Instagram export can be gigabytes, so the importer reads the central
 * directory at the end of the file, then each entry on its own, from any
 * random-access source (a browser `File`, or bytes in tests).
 *
 * Supports stored and deflated entries, ZIP64 (archives over 4 GB or 65,535
 * entries), and checks every entry's CRC-32 and size. Encrypted entries and
 * other compression methods are refused with a clear reason. Deflate comes
 * from fflate (D-72).
 */
import { inflateSync } from 'fflate';

export interface RandomAccess {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface ZipEntry {
  name: string;
  method: number;
  encrypted: boolean;
  crc32: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

export type ZipReason =
  'not_a_zip' | 'damaged' | 'encrypted' | 'unsupported_method' | 'too_large' | 'checksum';

export class ZipError extends Error {
  override readonly name = 'ZipError';
  readonly reason: ZipReason;
  constructor(reason: ZipReason, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.reason = reason;
  }
}

/** The largest single file read into memory (a 2-minute 1080p video is ~75 MB). */
export const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_DIRECTORY_BYTES = 64 * 1024 * 1024;
const EOCD_MAX_SEARCH = 22 + 0xffff;

const u16 = (b: Uint8Array, o: number) => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
const u32 = (b: Uint8Array, o: number) => (u16(b, o) | (u16(b, o + 2) << 16)) >>> 0;
const u64 = (b: Uint8Array, o: number) => u32(b, o) + u32(b, o + 4) * 0x1_0000_0000;

const utf8 = new TextDecoder('utf-8');

/** Lists every entry in the archive. */
export async function readZipDirectory(src: RandomAccess): Promise<ZipEntry[]> {
  if (src.size < 22) throw new ZipError('not_a_zip');
  const tailLen = Math.min(src.size, EOCD_MAX_SEARCH);
  const tailStart = src.size - tailLen;
  const tail = await src.read(tailStart, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('not_a_zip');

  let count = u16(tail, eocd + 10);
  let dirSize = u32(tail, eocd + 12);
  let dirOffset = u32(tail, eocd + 16);
  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) {
    // ZIP64: the locator sits just before the end-of-directory record.
    const loc = eocd - 20;
    if (loc < 0 || u32(tail, loc) !== 0x07064b50) throw new ZipError('damaged', 'zip64 locator');
    const recOffset = u64(tail, loc + 8);
    const rec = await src.read(recOffset, 56);
    if (u32(rec, 0) !== 0x06064b50) throw new ZipError('damaged', 'zip64 record');
    count = u64(rec, 32);
    dirSize = u64(rec, 40);
    dirOffset = u64(rec, 48);
  }
  if (dirSize > MAX_DIRECTORY_BYTES || dirOffset + dirSize > src.size) {
    throw new ZipError('damaged', 'directory');
  }

  const dir = await src.read(dirOffset, dirSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > dir.length || u32(dir, p) !== 0x02014b50) throw new ZipError('damaged', 'entry');
    const flags = u16(dir, p + 8);
    const nameLen = u16(dir, p + 28);
    const extraLen = u16(dir, p + 30);
    const commentLen = u16(dir, p + 32);
    let compressedSize = u32(dir, p + 20);
    let size = u32(dir, p + 24);
    let localHeaderOffset = u32(dir, p + 42);
    const name = utf8.decode(dir.subarray(p + 46, p + 46 + nameLen));
    // ZIP64 extra field: the 64-bit values for the fields that overflowed.
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = u16(dir, e);
      const len = u16(dir, e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) {
          size = u64(dir, q);
          q += 8;
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = u64(dir, q);
          q += 8;
        }
        if (localHeaderOffset === 0xffffffff) localHeaderOffset = u64(dir, q);
      }
      e += 4 + len;
    }
    entries.push({
      name,
      method: u16(dir, p + 10),
      encrypted: (flags & 1) === 1,
      crc32: u32(dir, p + 16),
      compressedSize,
      size,
      localHeaderOffset,
    });
    p = extraEnd + commentLen;
  }
  return entries;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** One entry's contents, checked against its size and CRC-32. */
export async function readZipEntry(src: RandomAccess, entry: ZipEntry): Promise<Uint8Array> {
  if (entry.encrypted) throw new ZipError('encrypted', entry.name);
  if (entry.size > MAX_ENTRY_BYTES || entry.compressedSize > MAX_ENTRY_BYTES) {
    throw new ZipError('too_large', entry.name);
  }
  const header = await src.read(entry.localHeaderOffset, 30);
  if (u32(header, 0) !== 0x04034b50) throw new ZipError('damaged', entry.name);
  const start = entry.localHeaderOffset + 30 + u16(header, 26) + u16(header, 28);
  if (start + entry.compressedSize > src.size) throw new ZipError('damaged', entry.name);
  const raw = await src.read(start, entry.compressedSize);
  let out: Uint8Array;
  if (entry.method === 0) {
    out = raw;
  } else if (entry.method === 8) {
    try {
      out = inflateSync(raw, { out: new Uint8Array(entry.size) });
    } catch {
      throw new ZipError('damaged', entry.name);
    }
  } else {
    throw new ZipError('unsupported_method', `${entry.name} (${entry.method})`);
  }
  if (out.length !== entry.size || crc32(out) !== entry.crc32) {
    throw new ZipError('checksum', entry.name);
  }
  return out;
}

/** A random-access view of bytes in memory (tests, small files). */
export function bytesSource(bytes: Uint8Array): RandomAccess {
  return {
    size: bytes.length,
    read: async (offset, length) => bytes.subarray(offset, offset + length),
  };
}
