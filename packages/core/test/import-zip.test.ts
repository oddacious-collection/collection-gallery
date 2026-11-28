/** Reading single files out of a large zip (D-70, D-72). */
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ZipError, bytesSource, crc32, readZipDirectory, readZipEntry } from '../src/import/zip.ts';

const enc = (s: string) => new TextEncoder().encode(s);

function must<T>(x: T | undefined): T {
  if (x === undefined) throw new Error('missing');
  return x;
}

function reason(e: unknown): string {
  return e instanceof ZipError ? e.reason : String(e);
}

/** A one-file ZIP64 archive, built by hand (fflate doesn't write ZIP64). */
function zip64(name: string, data: Uint8Array): Uint8Array {
  const n = enc(name);
  const crc = crc32(data);
  const parts: Uint8Array[] = [];
  const le = (bytes: number, value: number) => {
    const b = new Uint8Array(bytes);
    let v = value;
    for (let i = 0; i < bytes; i++) {
      b[i] = v % 256;
      v = Math.floor(v / 256);
    }
    return b;
  };
  const cat = (...xs: Uint8Array[]) => {
    const out = new Uint8Array(xs.reduce((s, x) => s + x.length, 0));
    let o = 0;
    for (const x of xs) {
      out.set(x, o);
      o += x.length;
    }
    return out;
  };
  // Local header (sizes in a zip64 extra), then the data.
  const localExtra = cat(le(2, 1), le(2, 16), le(8, data.length), le(8, data.length));
  const local = cat(
    le(4, 0x04034b50),
    le(2, 45),
    le(2, 0),
    le(2, 0),
    le(4, 0),
    le(4, crc),
    le(4, 0xffffffff),
    le(4, 0xffffffff),
    le(2, n.length),
    le(2, localExtra.length),
    n,
    localExtra,
  );
  parts.push(local, data);
  const dirOffset = local.length + data.length;
  const cdExtra = cat(le(2, 1), le(2, 24), le(8, data.length), le(8, data.length), le(8, 0));
  const cd = cat(
    le(4, 0x02014b50),
    le(2, 45),
    le(2, 45),
    le(2, 0),
    le(2, 0),
    le(4, 0),
    le(4, crc),
    le(4, 0xffffffff),
    le(4, 0xffffffff),
    le(2, n.length),
    le(2, cdExtra.length),
    le(2, 0),
    le(2, 0),
    le(2, 0),
    le(4, 0),
    le(4, 0xffffffff),
    n,
    cdExtra,
  );
  parts.push(cd);
  const recOffset = dirOffset + cd.length;
  const rec = cat(
    le(4, 0x06064b50),
    le(8, 44),
    le(2, 45),
    le(2, 45),
    le(4, 0),
    le(4, 0),
    le(8, 1),
    le(8, 1),
    le(8, cd.length),
    le(8, dirOffset),
  );
  const locator = cat(le(4, 0x07064b50), le(4, 0), le(8, recOffset), le(4, 1));
  const eocd = cat(
    le(4, 0x06054b50),
    le(2, 0),
    le(2, 0),
    le(2, 0xffff),
    le(2, 0xffff),
    le(4, 0xffffffff),
    le(4, 0xffffffff),
    le(2, 0),
  );
  parts.push(rec, locator, eocd);
  return cat(...parts);
}

describe('zip reader', () => {
  it('lists entries and reads stored and deflated files, checked by CRC', async () => {
    const big = new Uint8Array(200_000).map((_, i) => (i * 7) % 251);
    const zip = zipSync({
      'your_instagram_activity/media/posts_1.json': [enc('[{"media":[]}]'), { level: 6 }],
      'media/posts/1.jpg': [big, { level: 0 }],
      'media/reels/202609/1.mp4': [big, { level: 9 }],
    });
    const src = bytesSource(zip);
    const entries = await readZipDirectory(src);
    expect(entries.map((e) => e.name)).toEqual([
      'your_instagram_activity/media/posts_1.json',
      'media/posts/1.jpg',
      'media/reels/202609/1.mp4',
    ]);
    const [json, stored, deflated] = entries;
    expect(stored?.method).toBe(0);
    expect(deflated?.method).toBe(8);
    expect(new TextDecoder().decode(await readZipEntry(src, must(json)))).toBe('[{"media":[]}]');
    expect(await readZipEntry(src, must(stored))).toEqual(big);
    expect(await readZipEntry(src, must(deflated))).toEqual(big);
  });

  it('reads ZIP64 archives (exports over 4 GB)', async () => {
    const data = enc('fake mp4 bytes');
    const src = bytesSource(zip64('media/posts/big.mp4', data));
    const [entry] = await readZipDirectory(src);
    expect(entry).toMatchObject({ name: 'media/posts/big.mp4', size: data.length });
    expect(await readZipEntry(src, must(entry))).toEqual(data);
  });

  it('refuses non-zips, damaged data and unsupported entries', async () => {
    await expect(
      readZipDirectory(bytesSource(enc('hello world, not a zip at all'))),
    ).rejects.toSatisfy((e) => reason(e) === 'not_a_zip');
    const zip = zipSync({ 'a.txt': [enc('some text here, repeated, repeated'), { level: 0 }] });
    const src = bytesSource(zip);
    const [entry] = await readZipDirectory(src);
    // Flip a byte of the file's data: the CRC catches it.
    const broken = zip.slice();
    const at = 30 + 'a.txt'.length + 2;
    broken[at] = (broken[at] ?? 0) ^ 0xff;
    await expect(readZipEntry(bytesSource(broken), must(entry))).rejects.toSatisfy(
      (e) => reason(e) === 'checksum',
    );
    await expect(readZipEntry(src, { ...must(entry), encrypted: true })).rejects.toSatisfy(
      (e) => reason(e) === 'encrypted',
    );
    await expect(readZipEntry(src, { ...must(entry), method: 12 })).rejects.toSatisfy(
      (e) => reason(e) === 'unsupported_method',
    );
  });
});
