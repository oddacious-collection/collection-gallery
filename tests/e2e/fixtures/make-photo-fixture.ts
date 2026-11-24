/**
 * Makes `camera-photo.jpg`: a small JPEG carrying the kind of metadata a phone
 * camera writes, with recognisable sentinel values, for the photo pipeline
 * e2e test (MED-02, TST-05). Run once and commit the output:
 *
 *   node tests/e2e/fixtures/make-photo-fixture.ts
 *
 * The pixels: 600 × 400 stored, with an EXIF orientation of 6 ("rotate 90°
 * clockwise to display"). Stored top band green, left half red, right half
 * blue. Displayed upright it is 400 × 600, with the green band on the RIGHT,
 * red at the top-left and blue at the bottom-left.
 *
 * The metadata (none of it may survive processing):
 * - EXIF IFD0: Make, Model, Orientation, Software, DateTime;
 * - Exif IFD: DateTimeOriginal, BodySerialNumber, LensSerialNumber;
 * - GPS IFD: latitude and longitude;
 * - an XMP packet and a JPEG comment.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { webkit } from '@playwright/test';

export const SENTINELS = [
  'SentinelCam',
  'SENTINEL-MODEL-4242',
  'SENTINEL-SERIAL-4242',
  'SENTINEL-LENS-4242',
  'SentinelSoftware',
  '2019:05:06 07:08:09',
  'XMP-SENTINEL-GPS',
  'COMMENT-SENTINEL',
];

type Entry =
  | { tag: number; type: 'ascii'; value: string }
  | { tag: number; type: 'short'; value: number }
  | { tag: number; type: 'long'; value: number }
  | { tag: number; type: 'rational'; value: Array<[number, number]> };

/** A little-endian TIFF with IFD0 and optional Exif and GPS sub-IFDs. */
function tiff(ifd0: Entry[], exif: Entry[], gps: Entry[]): Buffer {
  const chunks: Buffer[] = [];
  const ifd0At = 8;
  const ifdSize = (n: number) => 2 + n * 12 + 4;
  // Layout: header, IFD0, Exif IFD, GPS IFD, then all out-of-line values.
  const ifd0Entries = [
    ...ifd0,
    { tag: 0x8769, type: 'long', value: 0 },
    { tag: 0x8825, type: 'long', value: 0 },
  ] as Entry[];
  const exifAt = ifd0At + ifdSize(ifd0Entries.length);
  const gpsAt = exifAt + ifdSize(exif.length);
  let dataAt = gpsAt + ifdSize(gps.length);
  const data: Buffer[] = [];

  function ifd(entries: Entry[]): Buffer {
    const sorted = [...entries].sort((a, b) => a.tag - b.tag);
    const b = Buffer.alloc(ifdSize(sorted.length));
    b.writeUInt16LE(sorted.length, 0);
    sorted.forEach((e, i) => {
      const at = 2 + i * 12;
      b.writeUInt16LE(e.tag, at);
      if (e.type === 'ascii') {
        const v = Buffer.from(`${e.value}\0`, 'latin1');
        b.writeUInt16LE(2, at + 2);
        b.writeUInt32LE(v.length, at + 4);
        if (v.length <= 4) v.copy(b, at + 8);
        else {
          b.writeUInt32LE(dataAt, at + 8);
          const padded = v.length % 2 ? Buffer.concat([v, Buffer.alloc(1)]) : v;
          data.push(padded);
          dataAt += padded.length;
        }
      } else if (e.type === 'short') {
        b.writeUInt16LE(3, at + 2);
        b.writeUInt32LE(1, at + 4);
        b.writeUInt16LE(e.value, at + 8);
      } else if (e.type === 'long') {
        b.writeUInt16LE(4, at + 2);
        b.writeUInt32LE(1, at + 4);
        const value = e.tag === 0x8769 ? exifAt : e.tag === 0x8825 ? gpsAt : e.value;
        b.writeUInt32LE(value, at + 8);
      } else {
        b.writeUInt16LE(5, at + 2);
        b.writeUInt32LE(e.value.length, at + 4);
        b.writeUInt32LE(dataAt, at + 8);
        const v = Buffer.alloc(e.value.length * 8);
        e.value.forEach(([n, d], j) => {
          v.writeUInt32LE(n, j * 8);
          v.writeUInt32LE(d, j * 8 + 4);
        });
        data.push(v);
        dataAt += v.length;
      }
    });
    return b;
  }

  const header = Buffer.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0]);
  chunks.push(header, ifd(ifd0Entries), ifd(exif), ifd(gps));
  return Buffer.concat([...chunks, ...data]);
}

function segment(marker: number, body: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

async function main(): Promise<void> {
  const browser = await webkit.launch();
  const page = await browser.newPage();
  const base64 = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 600;
    c.height = 400;
    const ctx = c.getContext('2d') as CanvasRenderingContext2D;
    ctx.fillStyle = '#e00000';
    ctx.fillRect(0, 0, 300, 400);
    ctx.fillStyle = '#0000e0';
    ctx.fillRect(300, 0, 300, 400);
    ctx.fillStyle = '#00c000';
    ctx.fillRect(0, 0, 600, 100);
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b as Blob), 'image/jpeg', 0.95));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  });
  await browser.close();
  const plain = Buffer.from(base64, 'base64');

  // Drop whatever the browser wrote after SOI up to the first non-APP segment.
  let at = 2;
  while (plain[at] === 0xff && (plain[at + 1] ?? 0) >= 0xe0 && (plain[at + 1] ?? 0) <= 0xef) {
    at += 2 + plain.readUInt16BE(at + 2);
  }
  const exif = tiff(
    [
      { tag: 0x010f, type: 'ascii', value: 'SentinelCam' },
      { tag: 0x0110, type: 'ascii', value: 'SENTINEL-MODEL-4242' },
      { tag: 0x0112, type: 'short', value: 6 },
      { tag: 0x0131, type: 'ascii', value: 'SentinelSoftware' },
      { tag: 0x0132, type: 'ascii', value: '2019:05:06 07:08:09' },
    ],
    [
      { tag: 0x9003, type: 'ascii', value: '2019:05:06 07:08:09' },
      { tag: 0xa431, type: 'ascii', value: 'SENTINEL-SERIAL-4242' },
      { tag: 0xa435, type: 'ascii', value: 'SENTINEL-LENS-4242' },
    ],
    [
      { tag: 0x0001, type: 'ascii', value: 'N' },
      {
        tag: 0x0002,
        type: 'rational',
        value: [
          [51, 1],
          [30, 1],
          [2647, 100],
        ],
      },
      { tag: 0x0003, type: 'ascii', value: 'W' },
      {
        tag: 0x0004,
        type: 'rational',
        value: [
          [0, 1],
          [7, 1],
          [3955, 100],
        ],
      },
    ],
  );
  const xmp = Buffer.from(
    'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description exif:GPSLatitude="XMP-SENTINEL-GPS"/></rdf:RDF></x:xmpmeta>',
    'latin1',
  );
  const out = Buffer.concat([
    plain.subarray(0, 2),
    segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), exif])),
    segment(0xe1, xmp),
    segment(0xfe, Buffer.from('COMMENT-SENTINEL', 'latin1')),
    plain.subarray(at),
  ]);
  const file = path.join(import.meta.dirname, 'camera-photo.jpg');
  writeFileSync(file, out);
  console.log(`wrote ${file} (${out.length} bytes)`);
}

if (import.meta.main) await main();
