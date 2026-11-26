/**
 * Server-side check of an uploaded video's MP4 header (D-60, MED-03, MED-08).
 *
 * Videos are uploaded in chunks (they don't fit a Worker's memory), and the
 * header comes first (`moov` before `mdat`, "fast start"). This module
 * verifies that header completely, before any byte is stored, and proves
 * that the media data that follows can hold nothing but the samples the
 * header describes. A file passes only if:
 *
 * - the top level is exactly `ftyp`, `moov`, `mdat`, ending at the declared
 *   file size (no other boxes, no trailing data);
 * - every box inside `moov` is on an allow-list: no `udta`, `meta`, `uuid`,
 *   `free` or any other box that can carry descriptive metadata (location,
 *   device, dates, tags);
 * - every creation/modification time is zero (D-60: the uploader writes none);
 * - handler names and the encoder-name field hold short plain text only;
 * - there is exactly one H.264 (`avc1`) video track and at most one AAC
 *   (`mp4a`) audio track;
 * - the duration is within the limit and the picture is at most 1080p
 *   (long side ≤1920, short side ≤1080);
 * - the samples listed in the sample tables tile the `mdat` payload exactly:
 *   no gaps, no overlaps, nothing outside. So no hidden bytes can ride along
 *   in the data that is streamed after the header.
 *
 * The browser runs the same check on its own output before uploading.
 */
import { FormatError } from './bytes.ts';

export const VIDEO_MAX_DURATION_S = 120; // D-59
export const VIDEO_MAX_LONG_EDGE = 1920;
export const VIDEO_MAX_SHORT_EDGE = 1080;

/** Containers we descend into, and how many bytes of fields precede their children. */
const CONTAINERS: Record<string, number> = {
  moov: 0,
  trak: 0,
  edts: 0,
  mdia: 0,
  minf: 0,
  dinf: 0,
  stbl: 0,
  dref: 8, // full box + entry count
  stsd: 8, // full box + entry count
  avc1: 78, // VisualSampleEntry fields
  mp4a: 28, // AudioSampleEntry (version 0) fields
};

/** Leaf boxes allowed inside `moov` (structure and codec setup only). */
const LEAVES = new Set([
  'mvhd',
  'tkhd',
  'elst',
  'mdhd',
  'hdlr',
  'vmhd',
  'smhd',
  'url ',
  'avcC',
  'btrt',
  'pasp',
  'colr',
  'esds',
  'stts',
  'ctts',
  'stsc',
  'stsz',
  'stco',
  'co64',
  'stss',
  'sdtp',
  'sgpd',
  'sbgp',
]);

const FTYP_BRANDS = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1']);

export type Mp4Reason =
  | 'too_short'
  | 'wrong_type'
  | 'malformed'
  | 'has_metadata'
  | 'wrong_codec'
  | 'too_long'
  | 'too_large_picture'
  | 'wrong_size'
  | 'not_fast_start'
  | 'hidden_data';

export class Mp4Error extends Error {
  override readonly name = 'Mp4Error';
  readonly reason: Mp4Reason;
  readonly detail: string | undefined;
  constructor(reason: Mp4Reason, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.reason = reason;
    this.detail = detail;
  }
}

export interface Mp4Info {
  durationS: number;
  width: number;
  height: number;
  hasAudio: boolean;
  /** Bytes from the start of the file to the end of `moov` (the part checked here). */
  headerBytes: number;
}

interface Box {
  type: string;
  start: number;
  end: number;
  body: number;
}

interface Track {
  handler: string;
  entry: string;
  width: number;
  height: number;
  timescale: number;
  duration: number;
  sizes: number[];
  stsc: Array<{ firstChunk: number; samplesPerChunk: number }>;
  offsets: number[];
}

class Reader {
  readonly view: DataView;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u8(at: number): number {
    this.need(at, 1);
    return this.view.getUint8(at);
  }
  u16(at: number): number {
    this.need(at, 2);
    return this.view.getUint16(at);
  }
  u32(at: number): number {
    this.need(at, 4);
    return this.view.getUint32(at);
  }
  u64(at: number): number {
    this.need(at, 8);
    const v = this.view.getBigUint64(at);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Mp4Error('malformed', 'size');
    return Number(v);
  }
  type(at: number): string {
    this.need(at, 4);
    return String.fromCharCode(...this.bytes.subarray(at, at + 4));
  }
  need(at: number, n: number): void {
    if (at < 0 || at + n > this.bytes.length) throw new Mp4Error('malformed', 'truncated');
  }
  /** The box at `at`, which must end by `limit`. */
  box(at: number, limit: number): Box {
    let size = this.u32(at);
    const type = this.type(at + 4);
    let header = 8;
    if (size === 1) {
      size = this.u64(at + 8);
      header = 16;
    } else if (size === 0) {
      size = limit - at;
    }
    if (size < header || at + size > limit) throw new Mp4Error('malformed', `box ${type}`);
    return { type, start: at, end: at + size, body: at + header };
  }
  /** Printable ASCII only, at most `max` characters, NUL-terminated or padded. */
  plainText(from: number, to: number, max: number): boolean {
    let n = 0;
    for (let i = from; i < to; i++) {
      const c = this.u8(i);
      if (c === 0) {
        for (let j = i; j < to; j++) if (this.u8(j) !== 0) return false;
        return true;
      }
      if (c < 0x20 || c > 0x7e || ++n > max) return false;
    }
    return true;
  }
}

function emptyTrack(): Track {
  return {
    handler: '',
    entry: '',
    width: 0,
    height: 0,
    timescale: 0,
    duration: 0,
    sizes: [],
    stsc: [],
    offsets: [],
  };
}

/** Version-0/1 full-box creation and modification times must both be zero. */
function zeroTimes(r: Reader, body: number): void {
  const version = r.u8(body);
  const [c, m] =
    version === 1 ? [r.u64(body + 4), r.u64(body + 12)] : [r.u32(body + 4), r.u32(body + 8)];
  if (c !== 0 || m !== 0) throw new Mp4Error('has_metadata', 'timestamp');
}

function readLeaf(
  r: Reader,
  b: Box,
  track: Track | null,
  movie: { timescale: number; duration: number },
) {
  const v = r.u8(b.body);
  switch (b.type) {
    case 'mvhd':
      zeroTimes(r, b.body);
      movie.timescale = v === 1 ? r.u32(b.body + 20) : r.u32(b.body + 12);
      movie.duration = v === 1 ? r.u64(b.body + 24) : r.u32(b.body + 16);
      return;
    case 'tkhd': {
      zeroTimes(r, b.body);
      if (!track) throw new Mp4Error('malformed', 'tkhd');
      const wAt = b.body + (v === 1 ? 88 : 76);
      track.width = r.u32(wAt) / 65536;
      track.height = r.u32(wAt + 4) / 65536;
      return;
    }
    case 'mdhd':
      zeroTimes(r, b.body);
      if (!track) throw new Mp4Error('malformed', 'mdhd');
      track.timescale = v === 1 ? r.u32(b.body + 20) : r.u32(b.body + 12);
      track.duration = v === 1 ? r.u64(b.body + 24) : r.u32(b.body + 16);
      return;
    case 'hdlr':
      if (!track) throw new Mp4Error('malformed', 'hdlr');
      track.handler = r.type(b.body + 8);
      if (!r.plainText(b.body + 24, b.end, 64)) throw new Mp4Error('has_metadata', 'handler name');
      return;
    case 'stsz': {
      if (!track) throw new Mp4Error('malformed', 'stsz');
      const fixed = r.u32(b.body + 4);
      const n = r.u32(b.body + 8);
      if (n > 1_000_000) throw new Mp4Error('malformed', 'stsz count');
      for (let i = 0; i < n; i++) track.sizes.push(fixed || r.u32(b.body + 12 + 4 * i));
      return;
    }
    case 'stsc': {
      if (!track) throw new Mp4Error('malformed', 'stsc');
      const n = r.u32(b.body + 4);
      for (let i = 0; i < n; i++) {
        track.stsc.push({
          firstChunk: r.u32(b.body + 8 + 12 * i),
          samplesPerChunk: r.u32(b.body + 12 + 12 * i),
        });
      }
      return;
    }
    case 'stco':
    case 'co64': {
      if (!track) throw new Mp4Error('malformed', b.type);
      const n = r.u32(b.body + 4);
      for (let i = 0; i < n; i++) {
        track.offsets.push(
          b.type === 'stco' ? r.u32(b.body + 8 + 4 * i) : r.u64(b.body + 8 + 8 * i),
        );
      }
      return;
    }
    default:
      return;
  }
}

function walk(
  r: Reader,
  from: number,
  to: number,
  tracks: Track[],
  track: Track | null,
  movie: { timescale: number; duration: number },
): void {
  let at = from;
  while (at < to) {
    if (to - at < 8) throw new Mp4Error('malformed', 'trailing bytes');
    const b = r.box(at, to);
    if (b.type in CONTAINERS) {
      let current = track;
      if (b.type === 'trak') {
        current = emptyTrack();
        tracks.push(current);
      }
      if (b.type === 'avc1' || b.type === 'mp4a') {
        if (!current || current.entry) throw new Mp4Error('wrong_codec', 'sample entries');
        current.entry = b.type;
        if (b.type === 'avc1') {
          // Encoder name: a Pascal string in 32 bytes; plain text only.
          const len = r.u8(b.body + 42);
          if (len > 31 || !r.plainText(b.body + 43, b.body + 43 + len, 31)) {
            throw new Mp4Error('has_metadata', 'encoder name');
          }
          const w = r.u16(b.body + 24);
          const h = r.u16(b.body + 26);
          if (!fitsPicture(w, h)) throw new Mp4Error('too_large_picture', `${w}x${h}`);
        } else if (r.u16(b.body + 8) !== 0) {
          throw new Mp4Error('wrong_codec', 'audio entry version');
        }
      } else if (b.type === 'stsd' || b.type === 'dref') {
        if (r.u32(b.body + 4) !== 1) throw new Mp4Error('wrong_codec', `${b.type} entries`);
      }
      walk(r, b.body + (CONTAINERS[b.type] ?? 0), b.end, tracks, current, movie);
    } else if (LEAVES.has(b.type)) {
      readLeaf(r, b, track, movie);
    } else if (b.type === 'udta' || b.type === 'meta' || b.type === 'uuid' || b.type === 'free') {
      throw new Mp4Error('has_metadata', b.type);
    } else {
      throw new Mp4Error('has_metadata', `box ${JSON.stringify(b.type)}`);
    }
    at = b.end;
  }
}

function fitsPicture(w: number, h: number): boolean {
  return (
    w > 0 &&
    h > 0 &&
    Math.max(w, h) <= VIDEO_MAX_LONG_EDGE &&
    Math.min(w, h) <= VIDEO_MAX_SHORT_EDGE
  );
}

/** Byte ranges of every sample of a track, from its sample tables. */
function sampleRanges(t: Track): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let sample = 0;
  for (let c = 0; c < t.offsets.length; c++) {
    const chunk = c + 1;
    let per = 0;
    for (const e of t.stsc) if (e.firstChunk <= chunk) per = e.samplesPerChunk;
    let at = t.offsets[c] ?? 0;
    for (let s = 0; s < per; s++) {
      const size = t.sizes[sample++];
      if (size === undefined) throw new Mp4Error('malformed', 'sample tables');
      ranges.push([at, at + size]);
      at += size;
    }
  }
  if (sample !== t.sizes.length) throw new Mp4Error('malformed', 'sample count');
  return ranges;
}

/**
 * Verifies a video file's header. `head` holds at least the file's first
 * bytes up to the end of `moov`; `fileSize` is the whole file's declared size.
 */
export function verifyMp4Header(
  head: Uint8Array,
  fileSize: number,
  maxDurationS: number = VIDEO_MAX_DURATION_S,
): Mp4Info {
  if (head.length < 16) throw new Mp4Error('too_short');
  const r = new Reader(head);
  if (r.type(4) !== 'ftyp') throw new Mp4Error('wrong_type');
  try {
    const ftyp = r.box(0, head.length);
    if (!FTYP_BRANDS.has(r.type(ftyp.body))) throw new Mp4Error('wrong_type', r.type(ftyp.body));
    if (ftyp.end + 8 > head.length || r.type(ftyp.end + 4) !== 'moov') {
      throw new Mp4Error('not_fast_start');
    }
    const moov = r.box(ftyp.end, head.length);
    // mdat: only its header needs to be in `head`; its size must reach the end of the file.
    r.need(moov.end, 16);
    if (r.type(moov.end + 4) !== 'mdat') throw new Mp4Error('has_metadata', 'box after moov');
    let mdatSize = r.u32(moov.end);
    let mdatHeader = 8;
    if (mdatSize === 1) {
      mdatSize = r.u64(moov.end + 8);
      mdatHeader = 16;
    }
    if (mdatSize === 0) mdatSize = fileSize - moov.end;
    if (moov.end + mdatSize !== fileSize) throw new Mp4Error('wrong_size', 'mdat end');

    const tracks: Track[] = [];
    const movie = { timescale: 0, duration: 0 };
    walk(r, moov.body, moov.end, tracks, null, movie);

    const video = tracks.filter((t) => t.handler === 'vide');
    const audio = tracks.filter((t) => t.handler === 'soun');
    if (video.length !== 1 || audio.length > 1 || video.length + audio.length !== tracks.length) {
      throw new Mp4Error('wrong_codec', 'tracks');
    }
    const v = video[0] as Track;
    if (v.entry !== 'avc1') throw new Mp4Error('wrong_codec', 'video');
    if (audio[0] && audio[0].entry !== 'mp4a') throw new Mp4Error('wrong_codec', 'audio');

    if (!movie.timescale) throw new Mp4Error('malformed', 'mvhd');
    const durations = [movie.duration / movie.timescale];
    for (const t of tracks) {
      if (!t.timescale) throw new Mp4Error('malformed', 'mdhd');
      durations.push(t.duration / t.timescale);
    }
    const durationS = Math.max(...durations);
    if (durationS > maxDurationS) throw new Mp4Error('too_long', durationS.toFixed(1));
    const width = Math.round(v.width);
    const height = Math.round(v.height);
    if (!fitsPicture(width, height)) throw new Mp4Error('too_large_picture', `${width}x${height}`);

    // The samples must tile the mdat payload exactly.
    const ranges = tracks.flatMap(sampleRanges).sort((a, b) => a[0] - b[0]);
    let at = moov.end + mdatHeader;
    for (const [s, e] of ranges) {
      if (s !== at) throw new Mp4Error('hidden_data', s > at ? 'gap' : 'overlap');
      at = e;
    }
    if (at !== fileSize) throw new Mp4Error('hidden_data', 'tail');

    return { durationS, width, height, hasAudio: audio.length === 1, headerBytes: moov.end };
  } catch (err) {
    if (err instanceof FormatError) throw new Mp4Error('malformed', err.reason);
    throw err;
  }
}
