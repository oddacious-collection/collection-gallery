/**
 * On-device video processing (MED-08, MED-09, D-60, D-64). Runs in the admin's
 * browser before anything is uploaded:
 *
 *   open the file (MP4/MOV, H.264 or HEVC) → convert to the private master
 *   and the public file: H.264 + AAC MP4, ≤1080p, rotation baked into the
 *   pixels, `moov` first, no tags and no timestamps → check each result
 *   exactly as the server will (media/mp4.ts).
 *
 * The original never leaves the device. AAC sound is copied unchanged where
 * possible (D-64); it is re-encoded only when the start is trimmed or the
 * sound isn't AAC, which needs a browser with an AAC encoder.
 */
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSink,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  canEncodeAudio,
  type InputVideoTrack,
} from 'mediabunny';
import {
  Mp4Error,
  VIDEO_MAX_DURATION_S,
  VIDEO_MAX_LONG_EDGE,
  VIDEO_MAX_SHORT_EDGE,
  verifyMp4Header,
  type Mp4Info,
} from '@cg/core/media';

/** Stays under the server's 100 MB per file (MED-03), with room for sound. */
const MAX_FILE_BYTES = 95 * 1000 * 1000;
const AUDIO_BPS = 160_000;
const BITRATE = { master: 6_000_000, public: 4_000_000 } as const;

export type VideoErrorCode =
  | 'unreadable'
  | 'no_video'
  | 'cannot_decode'
  | 'cannot_encode'
  | 'needs_aac_encoder'
  | 'too_short'
  | 'self_check'
  | 'cancelled';

export class VideoError extends Error {
  override readonly name = 'VideoError';
  readonly code: VideoErrorCode;
  constructor(code: VideoErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

export const VIDEO_ERROR_TEXT: Record<VideoErrorCode, string> = {
  unreadable: 'This file can’t be read as a video. Use an MP4 or MOV file.',
  no_video: 'This file has no video picture in it.',
  cannot_decode:
    'This browser can’t read this kind of video (iPhone videos use HEVC, which Firefox can’t read). Upload it from the phone, or use Chrome, Edge or Safari.',
  cannot_encode:
    'This browser can’t make the web version of the video. Use Chrome, Edge or Safari.',
  needs_aac_encoder:
    'Trimming the start re-makes the sound, which this browser can’t do. Keep the start, tick “Remove sound”, or use Chrome, Edge or Safari.',
  too_short: 'The video is too short (under half a second).',
  self_check: 'The processed video didn’t pass the final check, so nothing was uploaded.',
  cancelled: 'Stopped. Nothing was uploaded.',
};

export interface VideoSource {
  file: File;
  input: Input;
  track: InputVideoTrack;
  durationS: number;
  /** Size as shown (rotation applied). */
  width: number;
  height: number;
  hasAudio: boolean;
  /** iOS may hand over a 360×480 / 480p copy instead of the original. */
  looksShrunk: boolean;
}

/** Opens a picked file and reads what it is, without decoding it all. */
export async function openVideo(file: File): Promise<VideoSource> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  let track: InputVideoTrack | null;
  try {
    track = await input.getPrimaryVideoTrack();
  } catch {
    throw new VideoError('unreadable');
  }
  if (!track) throw new VideoError('no_video');
  if (!(await track.canDecode())) throw new VideoError('cannot_decode');
  const durationS = await input.computeDuration();
  if (durationS < 0.5) throw new VideoError('too_short');
  const width = await track.getDisplayWidth();
  const height = await track.getDisplayHeight();
  const audio = await input.getPrimaryAudioTrack();
  return {
    file,
    input,
    track,
    durationS,
    width,
    height,
    hasAudio: audio !== null && (await audio.canDecode()),
    looksShrunk: Math.max(width, height) <= 640 && /iPhone|iPad/.test(navigator.userAgent),
  };
}

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/** The output size: long side ≤1920, short side ≤1080, never upscaled, even. */
export function outputSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(
    1,
    VIDEO_MAX_LONG_EDGE / Math.max(width, height),
    VIDEO_MAX_SHORT_EDGE / Math.min(width, height),
  );
  return { width: even(width * scale), height: even(height * scale) };
}

/** Small frames for choosing the poster, at the given times (seconds). */
export async function thumbnails(
  src: VideoSource,
  times: number[],
  height = 96,
): Promise<HTMLCanvasElement[]> {
  const sink = new CanvasSink(src.track, {
    height,
    width: even((height * src.width) / src.height),
    fit: 'fill',
    poolSize: 0,
  });
  const out: HTMLCanvasElement[] = [];
  for await (const wrapped of sink.canvasesAtTimestamps(times)) {
    const c = document.createElement('canvas');
    c.width = wrapped?.canvas.width ?? 2;
    c.height = wrapped?.canvas.height ?? 2;
    if (wrapped) c.getContext('2d')?.drawImage(wrapped.canvas, 0, 0);
    out.push(c);
  }
  return out;
}

/** The poster frame at full output size. */
export async function posterFrame(src: VideoSource, time: number): Promise<HTMLCanvasElement> {
  const size = outputSize(src.width, src.height);
  const sink = new CanvasSink(src.track, { ...size, fit: 'fill', poolSize: 0 });
  const wrapped = await sink.getCanvas(time);
  if (!wrapped) throw new VideoError('unreadable', 'no frame');
  const c = document.createElement('canvas');
  c.width = size.width;
  c.height = size.height;
  c.getContext('2d')?.drawImage(wrapped.canvas, 0, 0, size.width, size.height);
  return c;
}

export interface VideoChoices {
  start: number;
  end: number;
  removeAudio: boolean;
}

export interface ConvertedVideo {
  bytes: Uint8Array;
  info: Mp4Info;
}

/** Makes the private master or the public file, then checks it as the server will. */
export async function convertVideo(
  src: VideoSource,
  choices: VideoChoices,
  which: 'master' | 'public',
  onProgress: (fraction: number) => void,
  register: (cancel: () => Promise<void>) => void = () => {},
): Promise<ConvertedVideo> {
  const size = outputSize(src.width, src.height);
  const length = choices.end - choices.start;
  const ratio = (size.width * size.height) / (1920 * 1080);
  const sourceBps = (src.file.size * 8) / src.durationS;
  const capBps = (MAX_FILE_BYTES * 8) / length - AUDIO_BPS;
  const bitrate = Math.round(
    Math.max(500_000, Math.min(BITRATE[which] * Math.max(ratio, 0.25), sourceBps * 1.1, capBps)),
  );
  const trimStart = choices.start > 0.05;
  const keepAudio = src.hasAudio && !choices.removeAudio;
  if (keepAudio && trimStart && !(await canEncodeAudio('aac', { bitrate: AUDIO_BPS }))) {
    throw new VideoError('needs_aac_encoder');
  }

  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  const trimmed = trimStart || choices.end < src.durationS - 0.05;
  const conversion = await Conversion.init({
    input: src.input,
    output,
    video: {
      codec: 'avc',
      ...size,
      fit: 'contain',
      bitrate,
      forceTranscode: true,
      allowRotationMetadata: false,
    },
    audio: keepAudio
      ? trimStart
        ? { codec: 'aac', bitrate: AUDIO_BPS }
        : { codec: 'aac' } // AAC is copied unchanged (D-64)
      : { discard: true },
    tags: { creationTime: null },
    ...(trimmed ? { trim: { start: choices.start, end: choices.end } } : {}),
  });
  if (!conversion.isValid) {
    const reasons = conversion.discardedTracks.map((d) => `${d.track.type}:${d.reason}`).join(',');
    throw new VideoError(
      conversion.discardedTracks.some((d) => d.track.type === 'audio')
        ? 'needs_aac_encoder'
        : 'cannot_encode',
      reasons,
    );
  }
  register(() => conversion.cancel());
  conversion.onProgress = (p) => onProgress(p);
  try {
    await conversion.execute();
  } catch (err) {
    if (err instanceof Error && /cancel/i.test(err.message)) throw new VideoError('cancelled');
    throw err;
  }
  const buffer = target.buffer;
  if (!buffer) throw new VideoError('self_check', 'no output');
  const bytes = new Uint8Array(buffer);
  let info: Mp4Info;
  try {
    info = verifyMp4Header(bytes, bytes.length, VIDEO_MAX_DURATION_S + 0.5);
  } catch (err) {
    if (err instanceof Mp4Error) throw new VideoError('self_check', err.message);
    throw err;
  }
  if (info.width !== size.width || info.height !== size.height) {
    throw new VideoError(
      'self_check',
      `${info.width}x${info.height}, expected ${size.width}x${size.height}`,
    );
  }
  if (info.hasAudio !== keepAudio) throw new VideoError('self_check', 'sound');
  return { bytes, info };
}

/**
 * A live frame preview for the poster/trim slider. `show(time)` draws the
 * frame at `time` onto `target`; while one frame is being decoded, only the
 * latest requested time is kept, so dragging stays responsive on a phone.
 */
export function framePreviewer(
  src: VideoSource,
  target: HTMLCanvasElement,
  height = 270,
): { show: (time: number) => void } {
  const width = even((height * src.width) / src.height);
  target.width = width;
  target.height = height;
  const sink = new CanvasSink(src.track, { width, height, fit: 'fill', poolSize: 1 });
  const ctx = target.getContext('2d');
  let busy = false;
  let pending: number | null = null;
  const draw = async (time: number): Promise<void> => {
    busy = true;
    try {
      const frame = await sink.getCanvas(time);
      if (frame && ctx) ctx.drawImage(frame.canvas, 0, 0, width, height);
    } catch {
      // A frame that can't be decoded just isn't shown.
    } finally {
      busy = false;
    }
    if (pending !== null) {
      const next = pending;
      pending = null;
      void draw(next);
    }
  };
  return {
    show(time: number) {
      if (busy) pending = time;
      else void draw(time);
    },
  };
}
