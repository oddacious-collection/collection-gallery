/**
 * The importer's uploads (D-70): one photo or video, made by the same
 * pipelines as a normal upload, sent through the same endpoints, and
 * finalized with its source hash so a re-run knows it's there.
 */
import { processPhoto, processPoster } from '../photos/process.ts';
import { encodeWebp } from '../photos/webp.ts';
import { convertVideo, openVideo, posterFrame } from '../video/process.ts';

const CSRF = { 'x-cg-request': '1' };
const RETRIES = 4;

export class SendError extends Error {
  override readonly name = 'SendError';
}

function serverMessage(status: number, data: Record<string, unknown>): string {
  if (status === 403) return 'Your session has expired. Reload the page to sign in again.';
  const reason = typeof data['reason'] === 'string' ? data['reason'] : '';
  const reasons = Array.isArray(data['reasons']) ? (data['reasons'] as string[]) : [];
  const why = [reason, ...reasons].filter(Boolean).join(', ').replace(/_/g, ' ');
  return `The server refused it${why ? ` (${why})` : ''}.`;
}

/** A JSON or binary request with retries on network errors and 5xx. */
export async function send(
  method: string,
  url: string,
  body: BodyInit,
  contentType = 'application/json',
): Promise<Record<string, unknown>> {
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        credentials: 'same-origin',
        headers: { ...CSRF, 'content-type': contentType },
        body,
      });
    } catch {
      if (attempt >= RETRIES) throw new SendError('Network error. Check the connection.');
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      continue;
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return data;
    if (res.status >= 500 && attempt < RETRIES) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      continue;
    }
    throw new SendError(serverMessage(res.status, data));
  }
}

interface Planned {
  name: string;
  format: string;
  width: number;
  height: number;
  chunkSize?: number;
  chunks?: number;
}

const enc = (s: string) => encodeURIComponent(s);

/** One photo into an item; returns the new media's ID. */
export async function sendPhoto(
  itemId: string,
  file: Blob,
  sourceHash: string,
  say: (s: string) => void,
): Promise<string> {
  const photo = await processPhoto(file, encodeWebp, say);
  const began = (await send(
    'POST',
    `/api/items/${enc(itemId)}/media`,
    JSON.stringify({ width: photo.width, height: photo.height }),
  )) as unknown as { uploadId: string; parts: Planned[] };
  const local = photo.plan.map((p) => `${p.name}:${p.width}x${p.height}`).join(',');
  const remote = began.parts.map((p) => `${p.name}:${p.width}x${p.height}`).join(',');
  if (local !== remote) throw new SendError('The server planned different photo sizes.');
  for (const part of photo.plan) {
    say(`Uploading ${part.name}`);
    const bytes = photo.files.get(part.name);
    if (!bytes) throw new SendError('A processed file is missing.');
    await send(
      'PUT',
      `/api/uploads/${enc(began.uploadId)}/${enc(part.name)}`,
      bytes as Uint8Array<ArrayBuffer>,
      part.format,
    );
  }
  const done = await send(
    'POST',
    `/api/uploads/${enc(began.uploadId)}/finalize`,
    JSON.stringify({ sourceHash }),
  );
  return String(done['mediaId'] ?? '');
}

/**
 * One video into an item, whole (Instagram videos are at most 60 s; anything
 * over 120 s would keep its first 120 s, D-70); returns the new media's ID.
 */
export async function sendVideo(
  itemId: string,
  file: File,
  sourceHash: string,
  say: (s: string) => void,
  register: (cancel: () => Promise<void>) => void,
): Promise<{ mediaId: string; trimmed: boolean }> {
  const src = await openVideo(file);
  const trimmed = src.durationS > 120;
  const choices = { start: 0, end: Math.min(src.durationS, 120), removeAudio: false };
  const pct = (label: string) => (p: number) => say(`${label} ${Math.round(p * 100)}%`);
  const master = await convertVideo(
    src,
    choices,
    'master',
    pct('Making the full-quality copy'),
    register,
  );
  const pub = await convertVideo(src, choices, 'public', pct('Making the web version'), register);
  say('Making the poster');
  const frame = await posterFrame(src, Math.min(1, choices.end / 2));
  const posters = await processPoster(frame, pub.info.width, pub.info.height, encodeWebp);
  const began = (await send(
    'POST',
    `/api/items/${enc(itemId)}/media/videos`,
    JSON.stringify({
      width: pub.info.width,
      height: pub.info.height,
      durationS: pub.info.durationS,
      hasAudio: pub.info.hasAudio,
      masterBytes: master.bytes.length,
      videoBytes: pub.bytes.length,
    }),
  )) as unknown as { uploadId: string; parts: Planned[] };
  const base = `/api/uploads/${enc(began.uploadId)}`;
  for (const part of began.parts.filter((p) => p.format === 'video/mp4')) {
    const bytes = part.name === 'original' ? master.bytes : pub.bytes;
    const size = part.chunkSize ?? bytes.length;
    for (let n = 0; n < (part.chunks ?? 0); n++) {
      say(
        `Uploading the ${part.name === 'original' ? 'full-quality copy' : 'web version'} (${n + 1}/${part.chunks})`,
      );
      await send(
        'PUT',
        `${base}/${enc(part.name)}/${n}`,
        bytes.slice(n * size, (n + 1) * size) as Uint8Array<ArrayBuffer>,
        'application/octet-stream',
      );
    }
  }
  for (const part of began.parts.filter((p) => p.format !== 'video/mp4')) {
    say('Uploading the poster');
    const bytes = posters.get(part.name);
    if (!bytes) throw new SendError('A poster file is missing.');
    await send('PUT', `${base}/${enc(part.name)}`, bytes as Uint8Array<ArrayBuffer>, part.format);
  }
  const done = await send('POST', `${base}/finalize`, JSON.stringify({ sourceHash }));
  return { mediaId: String(done['mediaId'] ?? ''), trimmed };
}

/** A caption file (the reel's .srt) onto a video (D-65). */
export async function sendCaptions(mediaId: string, bytes: Uint8Array): Promise<void> {
  await send(
    'PUT',
    `/api/media/${enc(mediaId)}/captions`,
    bytes as Uint8Array<ArrayBuffer>,
    'application/octet-stream',
  );
}
