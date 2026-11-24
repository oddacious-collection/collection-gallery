/** Image formats, metadata and the upload plan (MED-01 to MED-07, D-43, TST-05). */
import { describe, expect, it } from 'vitest';
import {
  FormatError,
  TAG_ARTIST,
  TAG_COPYRIGHT,
  addJpegRights,
  addWebpRights,
  buildRightsExif,
  hasOnlyRightsMetadata,
  isRightsOnly,
  masterSize,
  parseJpeg,
  parseWebp,
  readExif,
  rightsFor,
  sniffInput,
  stripJpegMetadata,
  uploadPlan,
  verifyPart,
  webpHasOnlyRightsMetadata,
  type PlannedPart,
} from '../src/media/index.ts';
import {
  HTML_TAIL,
  SENTINEL,
  SVG,
  bytesContain,
  cameraExifSegment,
  exifChunk,
  makeJpeg,
  makeWebp,
} from './image-fixtures.ts';

const enc = new TextEncoder();
const RIGHTS = rightsFor('Insignificant Nobody', 2026);

function reason(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof FormatError) return err.reason;
    throw err;
  }
  return 'no error';
}

describe('JPEG', () => {
  it('reads the size of a plain file and finds no metadata', () => {
    const info = parseJpeg(makeJpeg({ width: 4032, height: 3024 }));
    expect(info).toMatchObject({ width: 4032, height: 3024, components: 3, metadata: [] });
  });

  it('strips every APPn and COM segment, sentinel included, keeping the image', () => {
    const withMeta = makeJpeg({
      width: 800,
      height: 600,
      extra: [
        new Uint8Array([0xff, 0xe0, 0, 16, ...enc.encode('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]),
        cameraExifSegment(),
        new Uint8Array([0xff, 0xe2, 0, 12, ...enc.encode('ICC_PROFIL')]),
        new Uint8Array([0xff, 0xfe, 0, 7, ...enc.encode('SN-42')]),
      ],
    });
    expect(parseJpeg(withMeta).metadata.map((m) => m.marker)).toEqual([0xe0, 0xe1, 0xe2, 0xfe]);
    expect(bytesContain(withMeta, SENTINEL)).toBe(true);

    const clean = stripJpegMetadata(withMeta);
    const info = parseJpeg(clean);
    expect(info.metadata).toEqual([]);
    expect([info.width, info.height]).toEqual([800, 600]);
    expect(bytesContain(clean, SENTINEL)).toBe(false);
    expect(bytesContain(clean, 'SN-42')).toBe(false);
    expect(clean).toEqual(makeJpeg({ width: 800, height: 600 }));
  });

  it('rejects trailing data (polyglots), odd markers and truncation', () => {
    expect(reason(() => parseJpeg(makeJpeg({ width: 10, height: 10, trailing: HTML_TAIL })))).toBe(
      'trailing_data',
    );
    expect(reason(() => parseJpeg(makeJpeg({ width: 10, height: 10, sofMarker: 0xc3 })))).toBe(
      'unsupported_marker',
    );
    const full = makeJpeg({ width: 10, height: 10 });
    expect(reason(() => parseJpeg(full.subarray(0, full.length - 2)))).toBe('truncated');
    expect(reason(() => parseJpeg(SVG))).toBe('not_jpeg');
    expect(reason(() => parseJpeg(makeJpeg({ width: 0, height: 10 })))).toBe('bad_dimensions');
  });

  it('adds exactly the rights metadata, and only to a clean file', () => {
    const out = addJpegRights(makeJpeg({ width: 1200, height: 900 }), RIGHTS);
    expect(hasOnlyRightsMetadata(out)).toBe(true);
    expect(parseJpeg(out)).toMatchObject({ width: 1200, height: 900 });
    expect(bytesContain(out, 'Copyright 2026 Insignificant Nobody')).toBe(true);
    expect(() =>
      addJpegRights(makeJpeg({ width: 9, height: 9, extra: [cameraExifSegment()] }), RIGHTS),
    ).toThrow(FormatError);
    expect(
      hasOnlyRightsMetadata(makeJpeg({ width: 9, height: 9, extra: [cameraExifSegment()] })),
    ).toBe(false);
  });
});

describe('WebP', () => {
  it('reads lossy, lossless and extended files', () => {
    expect(parseWebp(makeWebp({ width: 2048, height: 1536 }))).toMatchObject({
      width: 2048,
      height: 1536,
    });
    expect(parseWebp(makeWebp({ width: 400, height: 300, lossless: true }))).toMatchObject({
      width: 400,
      height: 300,
    });
    expect(parseWebp(makeWebp({ width: 800, height: 600, extended: { flags: 0 } }))).toMatchObject({
      width: 800,
      metadata: [],
    });
  });

  it('reports metadata chunks and rejects trailing data, animation and size mismatches', () => {
    const withExif = makeWebp({
      width: 8,
      height: 8,
      extended: { flags: 0x08, after: [exifChunk()] },
    });
    expect(parseWebp(withExif).metadata.map((c) => c.fourcc)).toEqual(['EXIF']);
    expect(reason(() => parseWebp(makeWebp({ width: 8, height: 8, trailing: HTML_TAIL })))).toBe(
      'trailing_data',
    );
    expect(
      reason(() => parseWebp(makeWebp({ width: 8, height: 8, extended: { flags: 0x02 } }))),
    ).toBe('animated');
    expect(
      reason(() =>
        parseWebp(makeWebp({ width: 8, height: 8, extended: { flags: 0, after: [exifChunk()] } })),
      ),
    ).toBe('undeclared_metadata');
    expect(reason(() => parseWebp(SVG))).toBe('not_webp');
  });

  it('adds the rights metadata by converting to the extended layout', () => {
    for (const src of [
      makeWebp({ width: 1600, height: 1200 }),
      makeWebp({ width: 1600, height: 1200, lossless: true }),
      makeWebp({ width: 1600, height: 1200, extended: { flags: 0 } }),
    ]) {
      const out = addWebpRights(src, RIGHTS);
      const info = parseWebp(out);
      expect([info.width, info.height]).toEqual([1600, 1200]);
      expect(info.chunks[0]?.fourcc).toBe('VP8X');
      expect(webpHasOnlyRightsMetadata(out)).toBe(true);
    }
  });
});

describe('EXIF rights block (MED-07)', () => {
  it('holds only artist and copyright, in printable ASCII', () => {
    const tiff = buildRightsExif(rightsFor('Ödön Nobody ©', 2027));
    const s = readExif(tiff);
    expect(s.tags).toEqual([TAG_ARTIST, TAG_COPYRIGHT]);
    expect(s.text.get(TAG_ARTIST)).toBe('Odon Nobody');
    expect(s.text.get(TAG_COPYRIGHT)).toBe('Copyright 2027 Odon Nobody');
    expect(s.hasNextIfd).toBe(false);
    expect(isRightsOnly(tiff)).toBe(true);
  });
});

describe('sniffInput (MED-01)', () => {
  const ftyp = (brand: string, compat = '') =>
    enc.encode(
      `\0\0\0\x18ftyp${brand}\0\0\0\0${compat.padEnd(8, ' ')}`.slice(0, 24).padEnd(32, '\0'),
    );
  it.each([
    [makeJpeg({ width: 1, height: 1 }), 'jpeg'],
    [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), 'png'],
    [makeWebp({ width: 1, height: 1 }), 'webp'],
    [enc.encode('GIF89a....'), 'gif'],
    [SVG, 'markup'],
    [enc.encode('﻿ \n<svg/>'), 'markup'],
    [enc.encode('<!doctype html><p>'), 'markup'],
    [ftyp('heic', 'mif1heic'), 'heic'],
    [ftyp('mif1', 'mif1avif'), 'avif'],
    [ftyp('avif'), 'avif'],
    [ftyp('qt  '), 'video'],
    [ftyp('isom', 'isomavc1'), 'video'],
    [enc.encode('%PDF-1.7'), 'unknown'],
    [new Uint8Array([]), 'unknown'],
  ])('%#: → %s', (bytes, kind) => {
    expect(sniffInput(bytes)).toBe(kind);
  });
});

describe('uploadPlan (D-43, MED-05)', () => {
  it('a 12 MP iPhone photo: master as is, five WebP sizes and a 1200 px JPEG', () => {
    const plan = uploadPlan(4032, 3024);
    expect(plan.map((p) => `${p.name} ${p.format} ${p.width}x${p.height}`)).toEqual([
      'original image/jpeg 4032x3024',
      'w400 image/webp 400x300',
      'w800 image/webp 800x600',
      'w1200 image/webp 1200x900',
      'w1600 image/webp 1600x1200',
      'w2048 image/webp 2048x1536',
      'og image/jpeg 1200x900',
    ]);
  });

  it('caps the master at 4608 px and 16 MP, never upscaling', () => {
    expect(masterSize(8064, 6048)).toEqual({ width: 4608, height: 3456 });
    const square = masterSize(6048, 6048);
    expect(square.width * square.height).toBeLessThanOrEqual(16_000_000);
    expect(masterSize(1080, 1350)).toEqual({ width: 1080, height: 1350 });
    // A master size is always a valid plan.
    for (const [w, h] of [
      [8064, 6048],
      [6048, 6048],
      [3000, 9000],
      [12000, 1000],
    ] as const) {
      const m = masterSize(w, h);
      expect(() => uploadPlan(m.width, m.height)).not.toThrow();
    }
  });

  it('small photos get only the sizes that fit, plus their own size', () => {
    expect(uploadPlan(1080, 1350).map((p) => `${p.name} ${p.width}x${p.height}`)).toEqual([
      'original 1080x1350',
      'w400 320x400',
      'w800 640x800',
      'w1200 960x1200',
      'w1350 1080x1350',
      'og 960x1200',
    ]);
  });

  it('refuses sizes that are too small or not a master size', () => {
    expect(() => uploadPlan(150, 100)).toThrow('too_small');
    expect(() => uploadPlan(8064, 6048)).toThrow('too_large');
    expect(() => uploadPlan(0, 100)).toThrow('too_small');
    expect(() => uploadPlan(1.5, 100)).toThrow('too_small');
  });
});

describe('verifyPart (MED-03, TST-05)', () => {
  const plan = uploadPlan(4032, 3024);
  const original = plan[0] as PlannedPart;
  const w800 = plan[2] as PlannedPart;

  it('accepts exactly the planned file', () => {
    expect(verifyPart(makeJpeg({ width: 4032, height: 3024 }), original)).toEqual({ ok: true });
    expect(verifyPart(makeWebp({ width: 800, height: 600 }), w800)).toEqual({ ok: true });
  });

  it.each([
    ['SVG', SVG, 'wrong_type'],
    ['a WebP where a JPEG belongs', makeWebp({ width: 4032, height: 3024 }), 'wrong_type'],
    [
      'camera EXIF (GPS)',
      makeJpeg({ width: 4032, height: 3024, extra: [cameraExifSegment()] }),
      'has_metadata',
    ],
    [
      'a JPEG + HTML polyglot',
      makeJpeg({ width: 4032, height: 3024, trailing: HTML_TAIL }),
      'malformed',
    ],
    ['the wrong size', makeJpeg({ width: 4000, height: 3000 }), 'wrong_size'],
    ['an empty file', new Uint8Array(0), 'empty'],
  ])('rejects %s', (_label, bytes, why) => {
    expect(verifyPart(bytes, original)).toMatchObject({ ok: false, reason: why });
  });

  it('rejects WebP with metadata or trailing data, and oversize files', () => {
    expect(
      verifyPart(
        makeWebp({ width: 800, height: 600, extended: { flags: 0x08, after: [exifChunk()] } }),
        w800,
      ),
    ).toMatchObject({ reason: 'has_metadata' });
    expect(
      verifyPart(makeWebp({ width: 800, height: 600, trailing: HTML_TAIL }), w800),
    ).toMatchObject({
      reason: 'malformed',
    });
    expect(
      verifyPart(makeWebp({ width: 800, height: 600 }), { ...w800, maxBytes: 10 }),
    ).toMatchObject({
      reason: 'too_large',
    });
  });
});
