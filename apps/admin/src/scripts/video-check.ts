/**
 * Video device check (M4 step 2, D-61). Reports what this browser can decode,
 * encode and play, then converts one picked clip on the device the way the
 * uploader will (H.264 + AAC MP4, ≤1080p, moov first, metadata tags dropped)
 * and inspects the result's MP4 boxes for anything that could carry location
 * or other metadata. Nothing leaves the browser.
 */
import {
  ALL_FORMATS,
  BlobSource,
  BufferSource,
  BufferTarget,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  canEncodeAudio,
  canEncodeVideo,
} from 'mediabunny';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const caps = $<HTMLPreElement>('caps');
const result = $<HTMLPreElement>('result');
const clip = $<HTMLInputElement>('clip');
const trim = $<HTMLInputElement>('trim');
const run = $<HTMLButtonElement>('run');
const stop = $<HTMLButtonElement>('stop');
const progress = $<HTMLProgressElement>('progress');
const downloadRow = $<HTMLParagraphElement>('download-row');
const download = $<HTMLAnchorElement>('download');

const yes = (b: boolean) => (b ? 'yes' : 'NO');

async function videoDecode(codec: string, w: number, h: number): Promise<boolean> {
  if (!('VideoDecoder' in window)) return false;
  try {
    const r = await VideoDecoder.isConfigSupported({ codec, codedWidth: w, codedHeight: h });
    return r.supported === true;
  } catch {
    return false;
  }
}

async function audioDecode(codec: string): Promise<boolean> {
  if (!('AudioDecoder' in window)) return false;
  try {
    const r = await AudioDecoder.isConfigSupported({
      codec,
      sampleRate: 48000,
      numberOfChannels: 2,
    });
    return r.supported === true;
  } catch {
    return false;
  }
}

let aacPolyfilled = false;

async function checkCaps(): Promise<void> {
  const lines: string[] = [];
  lines.push(`Browser: ${navigator.userAgent}`);
  lines.push(`CPU threads: ${navigator.hardwareConcurrency ?? '?'}`);
  lines.push('');
  lines.push(
    `WebCodecs: VideoEncoder ${yes('VideoEncoder' in window)}, VideoDecoder ${yes(
      'VideoDecoder' in window,
    )}, AudioEncoder ${yes('AudioEncoder' in window)}, AudioDecoder ${yes('AudioDecoder' in window)}`,
  );
  lines.push(`Decode H.264 1080p: ${yes(await videoDecode('avc1.640028', 1920, 1080))}`);
  lines.push(`Decode H.264 4K: ${yes(await videoDecode('avc1.640033', 3840, 2160))}`);
  lines.push(
    `Decode HEVC 1080p (iPhone): ${yes(await videoDecode('hvc1.2.4.L123.B0', 1920, 1080))}`,
  );
  lines.push(`Decode HEVC 4K (iPhone): ${yes(await videoDecode('hvc1.2.4.L153.B0', 3840, 2160))}`);
  lines.push(`Decode AAC audio: ${yes(await audioDecode('mp4a.40.2'))}`);
  lines.push(
    `Encode H.264 1080p landscape: ${yes(
      await canEncodeVideo('avc', { width: 1920, height: 1080, bitrate: 4_500_000 }),
    )}`,
  );
  lines.push(
    `Encode H.264 1080p portrait: ${yes(
      await canEncodeVideo('avc', { width: 1080, height: 1920, bitrate: 4_500_000 }),
    )}`,
  );
  const nativeAac = await canEncodeAudio('aac', { bitrate: 128_000 });
  lines.push(`Encode AAC audio (built in): ${yes(nativeAac)}`);
  if (!nativeAac) {
    const { registerAacEncoder } = await import('@mediabunny/aac-encoder');
    registerAacEncoder();
    aacPolyfilled = true;
    lines.push(
      `Encode AAC audio (WebAssembly fallback): ${yes(
        await canEncodeAudio('aac', { bitrate: 128_000 }),
      )}`,
    );
  }
  const v = document.createElement('video');
  lines.push(
    `Plays H.264 + AAC MP4: ${v.canPlayType('video/mp4; codecs="avc1.640028, mp4a.40.2"') || 'NO'}`,
  );
  lines.push(`Screen wake lock API: ${yes('wakeLock' in navigator)}`);
  if ('wakeLock' in navigator) {
    try {
      const lock = await navigator.wakeLock.request('screen');
      lines.push('Screen wake lock allowed here: yes');
      await lock.release();
    } catch (err) {
      lines.push(
        `Screen wake lock allowed here: NO (${err instanceof Error ? err.name : 'error'})`,
      );
    }
  }
  caps.textContent = lines.join('\n');
}

// ------------------------------------------------------------ MP4 box walking

/** Container boxes we look inside (QuickTime `meta` has no version field). */
const CONTAINERS = new Set([
  'moov',
  'trak',
  'mdia',
  'minf',
  'stbl',
  'udta',
  'edts',
  'dinf',
  'meta',
  'ilst',
]);
/** Boxes that can carry descriptive metadata (location, device, dates…). */
const METADATA = new Set(['udta', 'meta', 'uuid', 'ilst', 'keys', '©xyz', 'loci', 'XMP_']);

interface Box {
  type: string;
  start: number;
  size: number;
  header: number;
}

function readBoxes(view: DataView, from: number, to: number, base: number): Box[] {
  const boxes: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = view.getUint32(at);
    const type = String.fromCharCode(
      view.getUint8(at + 4),
      view.getUint8(at + 5),
      view.getUint8(at + 6),
      view.getUint8(at + 7),
    );
    let header = 8;
    if (size === 1 && at + 16 <= to) {
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < header) break;
    boxes.push({ type, start: base + at, size, header });
    at += size;
  }
  return boxes;
}

/** Top-level box order of a file (reads only box headers). */
async function topLevel(file: Blob): Promise<Box[]> {
  const boxes: Box[] = [];
  let at = 0;
  while (at + 8 <= file.size && boxes.length < 64) {
    const head = new DataView(await file.slice(at, at + 16).arrayBuffer());
    const found = readBoxes(head, 0, Math.min(16, file.size - at), at)[0];
    if (!found) break;
    const size =
      head.getUint32(0) === 0 ? file.size - at : found.size === 0 ? file.size - at : found.size;
    boxes.push({ ...found, size });
    at += size;
  }
  return boxes;
}

/** Every box path inside moov, e.g. "moov/trak/mdia". */
async function moovPaths(file: Blob, moov: Box): Promise<string[]> {
  const buf = await file.slice(moov.start, moov.start + moov.size).arrayBuffer();
  const view = new DataView(buf);
  const paths: string[] = [];
  const walk = (from: number, to: number, path: string) => {
    for (const b of readBoxes(view, from, to, 0)) {
      const p = `${path}/${b.type}`;
      paths.push(p);
      if (CONTAINERS.has(b.type)) {
        // MP4 `meta` is a full box (4 bytes of version/flags); QuickTime's isn't.
        let inner = b.start + b.header;
        if (b.type === 'meta' && view.getUint32(inner) === 0) inner += 4;
        walk(inner, b.start + b.size, p);
      }
    }
  };
  walk(moov.header, moov.size, 'moov');
  return paths;
}

async function inspect(file: Blob, label: string): Promise<string[]> {
  const lines: string[] = [];
  const top = await topLevel(file);
  lines.push(`${label}: top-level boxes ${top.map((b) => b.type).join(', ')}`);
  const moov = top.find((b) => b.type === 'moov');
  const mdat = top.find((b) => b.type === 'mdat');
  if (moov && mdat)
    lines.push(`${label}: index first (fast start): ${yes(moov.start < mdat.start)}`);
  if (moov) {
    const paths = await moovPaths(file, moov);
    const meta = paths.filter((p) => METADATA.has(p.split('/').pop() ?? ''));
    const handlers = paths.filter((p) => p.endsWith('/hdlr')).length;
    lines.push(`${label}: ${paths.length} boxes inside moov, ${handlers} track handlers`);
    lines.push(`${label}: metadata boxes: ${meta.length ? meta.join(', ') : 'none'}`);
  }
  const topMeta = top.filter((b) => METADATA.has(b.type)).map((b) => b.type);
  if (topMeta.length) lines.push(`${label}: top-level metadata boxes: ${topMeta.join(', ')}`);
  return lines;
}

// ------------------------------------------------------------------ the run

let current: Conversion | null = null;

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

async function processClip(file: File): Promise<void> {
  const lines: string[] = [];
  const show = () => {
    result.textContent = lines.join('\n');
  };
  downloadRow.hidden = true;
  lines.push(`File: ${(file.size / 1e6).toFixed(1)} MB, type ${file.type || '?'}`);
  lines.push(...(await inspect(file, 'Original')));
  show();

  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const format = await input.getFormat();
  const duration = await input.computeDuration();
  const video = await input.getPrimaryVideoTrack();
  const audio = await input.getPrimaryAudioTrack();
  lines.push(`Container: ${format.name}, duration ${duration.toFixed(1)} s`);
  if (!video) {
    lines.push('No video track found.');
    show();
    return;
  }
  const w = await video.getDisplayWidth();
  const h = await video.getDisplayHeight();
  lines.push(
    `Video: ${(await video.getCodecParameterString()) ?? (await video.getCodec())}, ${w}×${h}, rotation ${await video.getRotation()}°, can decode: ${yes(await video.canDecode())}`,
  );
  if (audio) {
    lines.push(
      `Audio: ${(await audio.getCodecParameterString()) ?? (await audio.getCodec())}, can decode: ${yes(await audio.canDecode())}`,
    );
  } else {
    lines.push('Audio: none');
  }
  show();

  // Public file: long side ≤1920, short side ≤1080 (D-60).
  const scale = Math.min(1, 1920 / Math.max(w, h), 1080 / Math.min(w, h));
  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target,
  });
  const conversion = await Conversion.init({
    input,
    output,
    video: {
      codec: 'avc',
      width: even(w * scale),
      height: even(h * scale),
      fit: 'contain',
      bitrate: 4_500_000,
      forceTranscode: true,
    },
    audio: { codec: 'aac', bitrate: 128_000, forceTranscode: true },
    tags: {},
    ...(trim.checked ? { trim: { end: Math.min(10, duration) } } : {}),
  });
  if (!conversion.isValid) {
    lines.push(
      `Cannot convert: ${conversion.discardedTracks.map((d) => `${d.track.type} (${d.reason})`).join(', ')}`,
    );
    show();
    return;
  }
  current = conversion;
  progress.hidden = false;
  stop.hidden = false;
  run.disabled = true;
  conversion.onProgress = (p) => {
    progress.value = p;
  };
  const started = performance.now();
  try {
    await conversion.execute();
  } finally {
    current = null;
    progress.hidden = true;
    stop.hidden = true;
    run.disabled = false;
  }
  const seconds = (performance.now() - started) / 1000;
  const bytes = target.buffer;
  if (!bytes) throw new Error('no output');
  const out = new Blob([bytes], { type: 'video/mp4' });
  lines.push('');
  lines.push(
    `Converted in ${seconds.toFixed(1)} s to ${(out.size / 1e6).toFixed(1)} MB (${even(w * scale)}×${even(h * scale)}${aacPolyfilled ? ', AAC via WebAssembly' : ''})`,
  );
  const check = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
  const outVideo = await check.getPrimaryVideoTrack();
  const outAudio = await check.getPrimaryAudioTrack();
  lines.push(
    `Result: ${(await check.computeDuration()).toFixed(1)} s, video ${(await outVideo?.getCodecParameterString()) ?? 'none'}, audio ${(await outAudio?.getCodecParameterString()) ?? 'none'}`,
  );
  lines.push(...(await inspect(out, 'Result')));
  lines.push(
    `This browser can play the result: ${document.createElement('video').canPlayType('video/mp4; codecs="avc1.640028, mp4a.40.2"') || 'NO'}`,
  );
  show();
  download.href = URL.createObjectURL(out);
  downloadRow.hidden = false;
}

clip.addEventListener('change', () => {
  run.disabled = !clip.files?.length;
});
run.addEventListener('click', () => {
  const file = clip.files?.[0];
  if (!file) return;
  result.textContent = 'Working…';
  processClip(file).catch((err: unknown) => {
    result.textContent += `\nFAILED: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`;
  });
});
stop.addEventListener('click', () => {
  void current?.cancel();
});

checkCaps().catch((err: unknown) => {
  caps.textContent = `Check failed: ${err instanceof Error ? err.message : String(err)}`;
});
