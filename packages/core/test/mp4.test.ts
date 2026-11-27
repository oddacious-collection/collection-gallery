/**
 * The video header check (D-60). Files are made with Mediabunny, the library
 * the uploader uses, from fake encoded packets (the check never decodes
 * pictures), then tampered with to prove each rule.
 */
import { describe, expect, it } from 'vitest';
import { Mp4Error, verifyMp4Header } from '../src/media/mp4.ts';
import { makeMp4 } from './video-fixtures.ts';

function reason(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof Mp4Error) return err.reason;
    throw err;
  }
  return 'ok';
}

function indexOf(bytes: Uint8Array, type: string, from = 0): number {
  for (let i = from; i < bytes.length - 4; i++) {
    if (String.fromCharCode(...bytes.subarray(i, i + 4)) === type) return i - 4;
  }
  return -1;
}

describe('video header check (D-60)', () => {
  it('accepts what the uploader writes: H.264 + AAC, 1080p, fast start, no metadata', async () => {
    const file = await makeMp4({ seconds: 3 });
    const info = verifyMp4Header(file, file.length);
    expect(info).toMatchObject({ width: 1920, height: 1080, hasAudio: true });
    expect(info.durationS).toBeCloseTo(3, 0);
    expect(info.headerBytes).toBeLessThan(file.length);
    // Only the header is needed, not the media data.
    expect(verifyMp4Header(file.subarray(0, info.headerBytes + 16), file.length).width).toBe(1920);
    // Portrait and silent videos too.
    const tall = await makeMp4({ width: 1080, height: 1920, audio: false });
    expect(verifyMp4Header(tall, tall.length)).toMatchObject({ width: 1080, hasAudio: false });
  });

  it('refuses descriptive metadata and real timestamps', async () => {
    const titled = await makeMp4({ title: 'SENTINEL-LOCATION' });
    expect(reason(() => verifyMp4Header(titled, titled.length))).toBe('has_metadata');
    const dated = await makeMp4({ keepTimes: true });
    expect(reason(() => verifyMp4Header(dated, dated.length))).toBe('has_metadata');
  });

  it('refuses hidden bytes in the media data, and a wrong declared size', async () => {
    const file = await makeMp4();
    // Grow mdat by 4 bytes that no sample points to.
    const mdat = indexOf(file, 'mdat');
    const grown = new Uint8Array(file.length + 4);
    grown.set(file);
    const view = new DataView(grown.buffer);
    view.setUint32(mdat, view.getUint32(mdat) + 4);
    expect(reason(() => verifyMp4Header(grown, grown.length))).toBe('hidden_data');
    expect(reason(() => verifyMp4Header(file, file.length + 1))).toBe('wrong_size');
    // Trailing data after mdat.
    const tail = new Uint8Array(file.length + 8);
    tail.set(file);
    expect(reason(() => verifyMp4Header(tail, tail.length))).toBe('wrong_size');
  });

  it('refuses unknown boxes, renamed boxes and over-long handler names', async () => {
    const file = await makeMp4();
    const hacked = file.slice();
    const stss = indexOf(hacked, 'stss');
    hacked.set([0x78, 0x79, 0x7a, 0x21], stss + 4); // "xyz!"
    expect(reason(() => verifyMp4Header(hacked, hacked.length))).toBe('has_metadata');
    const named = file.slice();
    const hdlr = indexOf(named, 'hdlr');
    named[hdlr + 8 + 24] = 0x01; // a control character in the handler name
    expect(reason(() => verifyMp4Header(named, named.length))).toBe('has_metadata');
  });

  it('refuses too long, too large and non-fast-start files', async () => {
    const long = await makeMp4({ seconds: 121, audio: false });
    expect(reason(() => verifyMp4Header(long, long.length))).toBe('too_long');
    const big = await makeMp4({ width: 3840, height: 2160 });
    expect(reason(() => verifyMp4Header(big, big.length))).toBe('too_large_picture');
    const notMp4 = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(reason(() => verifyMp4Header(notMp4, notMp4.length))).toBe('wrong_type');
    // mdat before moov.
    const file = await makeMp4();
    const ftypEnd = new DataView(file.buffer).getUint32(0);
    const moovAt = ftypEnd;
    const moovSize = new DataView(file.buffer).getUint32(moovAt);
    const swapped = new Uint8Array(file.length);
    swapped.set(file.subarray(0, ftypEnd));
    swapped.set(file.subarray(moovAt + moovSize), ftypEnd);
    swapped.set(file.subarray(moovAt, moovAt + moovSize), file.length - moovSize);
    expect(reason(() => verifyMp4Header(swapped, swapped.length))).toBe('not_fast_start');
  });

  it('refuses every place an iPhone or camera puts the location (M4 step 6)', async () => {
    const LOCATION = '+37.7749-122.4194+010.000/';
    // A box: 32-bit size, 4-byte type (latin-1, so "©xyz" is A9 78 79 7A), payload.
    const box = (type: string, ...parts: Uint8Array[]): Uint8Array => {
      const body = parts.reduce((n, p) => n + p.length, 0);
      const out = new Uint8Array(8 + body);
      new DataView(out.buffer).setUint32(0, out.length);
      for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i) & 0xff;
      let at = 8;
      for (const p of parts) {
        out.set(p, at);
        at += p.length;
      }
      return out;
    };
    const text = (s: string) => new TextEncoder().encode(s);
    const zeros = (n: number) => new Uint8Array(n);
    /** Appends `child` inside the box at `path` (e.g. ['moov', 'trak']), growing each parent. */
    const insert = (file: Uint8Array, path: string[], child: Uint8Array): Uint8Array => {
      const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
      const parents: number[] = [];
      let from = 0;
      let to = file.length;
      for (const type of path) {
        let at = from;
        while (at < to && String.fromCharCode(...file.subarray(at + 4, at + 8)) !== type) {
          at += view.getUint32(at);
        }
        if (at >= to) throw new Error(`no ${type}`);
        parents.push(at);
        from = at + 8;
        to = at + view.getUint32(at);
      }
      const out = new Uint8Array(file.length + child.length);
      out.set(file.subarray(0, to));
      out.set(child, to);
      out.set(file.subarray(to), to + child.length);
      const outView = new DataView(out.buffer);
      for (const p of parents) outView.setUint32(p, view.getUint32(p) + child.length);
      return out;
    };

    // Apple's QuickTime metadata: moov/meta with an mdta handler, a keys
    // table naming com.apple.quicktime.location.ISO6709, and its value in ilst.
    const keyName = text('com.apple.quicktime.location.ISO6709');
    const keyEntry = new Uint8Array(8 + keyName.length);
    new DataView(keyEntry.buffer).setUint32(0, keyEntry.length);
    keyEntry.set(text('mdta'), 4);
    keyEntry.set(keyName, 8);
    const keysCount = zeros(8);
    new DataView(keysCount.buffer).setUint32(4, 1);
    const appleMeta = box(
      'meta',
      zeros(4),
      box('hdlr', zeros(8), text('mdta'), zeros(13)),
      box('keys', keysCount, keyEntry),
      box('ilst', box('\u0000\u0000\u0000\u0001', box('data', zeros(8), text(LOCATION)))),
    );
    // The older QuickTime place: moov/udta/©xyz.
    const xyz = box('udta', box('©xyz', zeros(4), text(LOCATION)));

    const file = await makeMp4({ seconds: 2 });
    for (const [where, tampered] of [
      ['moov/meta', insert(file, ['moov'], appleMeta)],
      ['moov/udta/©xyz', insert(file, ['moov'], xyz)],
      ['moov/trak/udta/©xyz', insert(file, ['moov', 'trak'], xyz)],
      ['moov/trak/mdia/meta', insert(file, ['moov', 'trak', 'mdia'], appleMeta)],
    ] as const) {
      expect(
        reason(() => verifyMp4Header(tampered, tampered.length)),
        where,
      ).toBe('has_metadata');
    }
    // A clean file passes the same helper untouched (the test isn't refusing everything).
    expect(reason(() => verifyMp4Header(file, file.length))).toBe('ok');
  });
});
