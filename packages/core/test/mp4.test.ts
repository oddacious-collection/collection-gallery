/**
 * The video header check (D-60). Files are made with Mediabunny, the library
 * the uploader uses, from fake encoded packets (the check never decodes
 * pictures), then tampered with to prove each rule.
 */
import {
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
} from 'mediabunny';
import { describe, expect, it } from 'vitest';
import { Mp4Error, verifyMp4Header } from '../src/media/mp4.ts';

const AVCC = new Uint8Array([
  1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 4, 0x68, 0xee, 0x3c, 0x80,
]);

interface Make {
  width?: number;
  height?: number;
  seconds?: number;
  audio?: boolean;
  /** Leave Mediabunny's default creation time (the current time) in place. */
  keepTimes?: boolean;
  /** Extra descriptive tags (become udta/meta boxes). */
  title?: string;
}

async function makeMp4(o: Make = {}): Promise<Uint8Array> {
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });
  output.setMetadataTags({
    ...(o.keepTimes ? {} : { creationTime: null }),
    ...(o.title ? { title: o.title } : {}),
  });
  const video = new EncodedVideoPacketSource('avc');
  output.addVideoTrack(video, { frameRate: 30 });
  const audio = o.audio === false ? null : new EncodedAudioPacketSource('aac');
  if (audio) output.addAudioTrack(audio);
  await output.start();
  const frames = Math.round((o.seconds ?? 2) * 30);
  for (let i = 0; i < frames; i++) {
    await video.add(
      new EncodedPacket(
        new Uint8Array([0, 0, 0, 2, i === 0 ? 0x65 : 0x41, i & 0xff]),
        i === 0 ? 'key' : 'delta',
        i / 30,
        1 / 30,
      ),
      i === 0
        ? {
            decoderConfig: {
              codec: 'avc1.640028',
              codedWidth: o.width ?? 1920,
              codedHeight: o.height ?? 1080,
              description: AVCC,
            },
          }
        : undefined,
    );
  }
  if (audio) {
    const packets = Math.round(((o.seconds ?? 2) * 48000) / 1024);
    for (let i = 0; i < packets; i++) {
      await audio.add(
        new EncodedPacket(
          new Uint8Array([0x21, i & 0xff, 0, 0]),
          'key',
          (i * 1024) / 48000,
          1024 / 48000,
        ),
        i === 0
          ? {
              decoderConfig: {
                codec: 'mp4a.40.2',
                sampleRate: 48000,
                numberOfChannels: 2,
                description: new Uint8Array([0x11, 0x90]),
              },
            }
          : undefined,
      );
    }
  }
  await output.finalize();
  return new Uint8Array(output.target.buffer as ArrayBuffer);
}

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
});
