/**
 * MP4 test files made with Mediabunny (the uploader's library) from fake
 * encoded packets: real container structure, no real pictures.
 */
import {
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
} from 'mediabunny';

const AVCC = new Uint8Array([
  1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 4, 0x68, 0xee, 0x3c, 0x80,
]);

export interface Make {
  width?: number;
  height?: number;
  seconds?: number;
  audio?: boolean;
  /** Leave Mediabunny's default creation time (the current time) in place. */
  keepTimes?: boolean;
  /** Extra descriptive tags (become udta/meta boxes). */
  title?: string;
  /** Bytes per video frame (default 6): large frames make multi-chunk files. */
  frameBytes?: number;
}

export async function makeMp4(o: Make = {}): Promise<Uint8Array> {
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
      new EncodedPacket(frame(i, o.frameBytes ?? 6), i === 0 ? 'key' : 'delta', i / 30, 1 / 30),
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

/** One fake length-prefixed H.264 NAL unit of `size` bytes. */
function frame(i: number, size: number): Uint8Array {
  const b = new Uint8Array(Math.max(6, size));
  new DataView(b.buffer).setUint32(0, b.length - 4);
  b[4] = i === 0 ? 0x65 : 0x41;
  b[5] = i & 0xff;
  return b;
}
