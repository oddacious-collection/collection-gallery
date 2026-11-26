/**
 * "Add a video" on the item editor (ADM-03, MED-08/09, D-60). One video at a
 * time:
 *
 *   pick → read it here (size, length, sound; warn about iOS shrunk copies)
 *   → choose poster frame, trim, remove sound → make the private master and
 *   the public file here, check both as the server will → make the poster
 *   images → POST …/media/videos (plan) → PUT each file in 8 MiB chunks
 *   (retried on network errors; chunk 0 is checked by the server before it
 *   is stored) → PUT poster images → finalize.
 *
 * The screen is kept awake while it works (D-63). Messages use textContent
 * only, and frames are shown as canvases (Trusted Types, no blob: media).
 */
import { PHOTO_ERROR_TEXT, PhotoError, processPoster } from '../photos/process.ts';
import { encodeWebp } from '../photos/webp.ts';
import {
  VIDEO_ERROR_TEXT,
  VideoError,
  convertVideo,
  openVideo,
  posterFrame,
  thumbnails,
  type VideoSource,
} from './process.ts';

const CSRF = { 'x-cg-request': '1' };
const RETRIES = 4;
const MAX_LENGTH_S = 120;
const POSTER_CHOICES = 6;

class UploadError extends Error {
  override readonly name = 'UploadError';
}

function serverMessage(status: number, data: Record<string, unknown>): string {
  if (status === 403) return 'Your session has expired. Reload the page to sign in again.';
  const reason = typeof data['reason'] === 'string' ? data['reason'] : '';
  const reasons = Array.isArray(data['reasons']) ? (data['reasons'] as string[]) : [];
  if (reasons.includes('in_trash')) return 'This item is in the trash. Restore it first.';
  if (reasons.includes('too_many_photos'))
    return 'This item already has the maximum number of photos and videos.';
  if (reason.startsWith('video_') || reason.startsWith('file_') || reason.startsWith('chunk_')) {
    return `The server refused the processed video (${reason.replace(/_/g, ' ')}). Nothing was added.`;
  }
  return 'The server refused the upload. Nothing was added.';
}

async function request(
  method: string,
  url: string,
  body: BodyInit,
  contentType: string,
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
      if (attempt >= RETRIES) {
        throw new UploadError('Network error. Check your connection and try again.');
      }
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      continue;
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return data;
    if (res.status >= 500 && attempt < RETRIES) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      continue;
    }
    throw new UploadError(serverMessage(res.status, data));
  }
}

interface PlannedFile {
  name: string;
  format: string;
  width: number;
  height: number;
  bytes?: number;
  chunkSize?: number;
  chunks?: number;
}

function clock(s: number): string {
  const t = Math.round(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

async function keepAwake(): Promise<() => void> {
  try {
    const lock = await navigator.wakeLock.request('screen');
    return () => void lock.release();
  } catch {
    return () => {};
  }
}

function init(root: HTMLElement): void {
  const itemId = root.dataset['itemId'] ?? '';
  const q = <T extends Element>(sel: string) => root.querySelector<T>(sel);
  const input = q<HTMLInputElement>('[data-video-input]');
  const panel = q<HTMLElement>('[data-video-panel]');
  const info = q<HTMLElement>('[data-video-info]');
  const warning = q<HTMLElement>('[data-video-warning]');
  const posters = q<HTMLElement>('[data-video-posters]');
  const startInput = q<HTMLInputElement>('[data-video-start]');
  const endInput = q<HTMLInputElement>('[data-video-end]');
  const lengthNote = q<HTMLElement>('[data-video-length]');
  const mute = q<HTMLInputElement>('[data-video-mute]');
  const go = q<HTMLButtonElement>('[data-video-upload]');
  const stop = q<HTMLButtonElement>('[data-video-stop]');
  const bar = q<HTMLProgressElement>('[data-video-progress]');
  const status = q<HTMLElement>('[data-video-status]');
  if (
    !itemId ||
    !input ||
    !panel ||
    !info ||
    !warning ||
    !posters ||
    !startInput ||
    !endInput ||
    !lengthNote ||
    !mute ||
    !go ||
    !stop ||
    !bar ||
    !status
  ) {
    return;
  }

  let src: VideoSource | null = null;
  let posterTime = 0;
  let cancel: (() => Promise<void>) | null = null;
  let stopped = false;

  const say = (text: string, kind: 'ok' | 'error' | '' = '') => {
    status.textContent = text;
    status.className = kind;
  };
  const choices = () => {
    const start = Math.max(0, Number(startInput.value) || 0);
    const end = Math.min(src?.durationS ?? 0, Number(endInput.value) || 0);
    return { start, end, removeAudio: mute.checked };
  };
  const checkLength = (): boolean => {
    const { start, end } = choices();
    const length = end - start;
    const ok = length >= 0.5 && length <= MAX_LENGTH_S + 0.05;
    lengthNote.textContent = ok
      ? `Length: ${clock(length)}`
      : length > MAX_LENGTH_S
        ? `Length: ${clock(length)}. Videos can be at most 2:00: move the start or the end.`
        : 'The end must be after the start.';
    lengthNote.className = ok ? 'hint' : 'hint error';
    go.disabled = !ok;
    return ok;
  };

  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    panel.hidden = true;
    posters.replaceChildren();
    warning.hidden = true;
    say('Reading the video…');
    void (async () => {
      try {
        src = await openVideo(file);
      } catch (err) {
        src = null;
        say(
          err instanceof VideoError ? VIDEO_ERROR_TEXT[err.code] : 'This video can’t be read.',
          'error',
        );
        return;
      }
      const s = src;
      info.textContent = `${s.width}×${s.height}, ${clock(s.durationS)}, ${s.hasAudio ? 'with sound' : 'no sound'}.`;
      if (s.looksShrunk) {
        warning.textContent =
          'This looks like a shrunk copy (iOS made it smaller). For full quality, pick the video again and choose Options → Format → Current in the picker.';
        warning.hidden = false;
      }
      startInput.value = '0';
      startInput.max = String(Math.floor(s.durationS * 10) / 10);
      endInput.max = startInput.max;
      endInput.value = String(Math.min(MAX_LENGTH_S, Math.floor(s.durationS * 10) / 10));
      mute.checked = false;
      mute.disabled = !s.hasAudio;
      panel.hidden = false;
      checkLength();
      say(
        s.durationS > MAX_LENGTH_S
          ? 'Longer than 2 minutes: the first 2 minutes are selected.'
          : '',
      );

      // Poster choices: evenly spread frames; the first is chosen.
      const times = Array.from(
        { length: POSTER_CHOICES },
        (_, i) => (s.durationS * (i + 0.5)) / POSTER_CHOICES,
      );
      times[0] = 0;
      posterTime = 0;
      try {
        const frames = await thumbnails(s, times);
        frames.forEach((canvas, i) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'poster-choice';
          b.setAttribute('aria-pressed', String(i === 0));
          b.setAttribute('aria-label', `Poster from ${clock(times[i] ?? 0)}`);
          b.appendChild(canvas);
          b.addEventListener('click', () => {
            posterTime = times[i] ?? 0;
            posters
              .querySelectorAll('button')
              .forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
          });
          posters.appendChild(b);
        });
      } catch {
        posters.textContent = 'Previews aren’t available; the first frame will be the poster.';
      }
    })();
  });
  startInput.addEventListener('input', checkLength);
  endInput.addEventListener('input', checkLength);

  stop.addEventListener('click', () => {
    stopped = true;
    void cancel?.();
  });

  go.addEventListener('click', () => {
    const s = src;
    if (!s || !checkLength()) return;
    const pick = choices();
    if (posterTime < pick.start || posterTime > pick.end) posterTime = pick.start;
    go.disabled = true;
    input.disabled = true;
    stop.hidden = false;
    bar.hidden = false;
    stopped = false;
    void (async () => {
      const release = await keepAwake();
      let step = 'starting';
      const progress = (label: string, fraction: number) => {
        step = label;
        bar.value = fraction;
        say(`${label}… ${Math.round(fraction * 100)}%`);
      };
      try {
        const master = await convertVideo(
          s,
          pick,
          'master',
          (p) => progress('Making the full-quality copy (private)', p),
          (c) => (cancel = c),
        );
        if (stopped) throw new VideoError('cancelled');
        const pub = await convertVideo(
          s,
          pick,
          'public',
          (p) => progress('Making the web version', p),
          (c) => (cancel = c),
        );
        if (stopped) throw new VideoError('cancelled');
        cancel = null;
        progress('Making the poster', 0);
        const frame = await posterFrame(s, posterTime);
        const posterFiles = await processPoster(frame, pub.info.width, pub.info.height, encodeWebp);

        progress('Starting the upload', 0);
        const began = (await request(
          'POST',
          `/api/items/${encodeURIComponent(itemId)}/media/videos`,
          JSON.stringify({
            width: pub.info.width,
            height: pub.info.height,
            durationS: pub.info.durationS,
            hasAudio: pub.info.hasAudio,
            masterBytes: master.bytes.length,
            videoBytes: pub.bytes.length,
          }),
          'application/json',
        )) as unknown as { uploadId: string; parts: PlannedFile[] };
        const base = `/api/uploads/${encodeURIComponent(began.uploadId)}`;

        const videoParts = began.parts.filter((p) => p.format === 'video/mp4');
        const totalChunks = videoParts.reduce((n, p) => n + (p.chunks ?? 0), 0);
        let sent = 0;
        for (const part of videoParts) {
          const bytes = part.name === 'original' ? master.bytes : pub.bytes;
          const size = part.chunkSize ?? bytes.length;
          for (let n = 0; n < (part.chunks ?? 0); n++) {
            if (stopped) throw new VideoError('cancelled');
            progress(
              part.name === 'original'
                ? 'Uploading the full-quality copy'
                : 'Uploading the web version',
              sent / totalChunks,
            );
            await request(
              'PUT',
              `${base}/${encodeURIComponent(part.name)}/${n}`,
              bytes.slice(n * size, (n + 1) * size) as Uint8Array<ArrayBuffer>,
              'application/octet-stream',
            );
            sent++;
          }
        }
        for (const part of began.parts.filter((p) => p.format !== 'video/mp4')) {
          progress('Uploading the poster', 1);
          const bytes = posterFiles.get(part.name);
          if (!bytes) throw new UploadError('A poster file is missing.');
          await request(
            'PUT',
            `${base}/${encodeURIComponent(part.name)}`,
            bytes as Uint8Array<ArrayBuffer>,
            part.format,
          );
        }
        progress('Attaching the video to the item', 1);
        await request('POST', `${base}/finalize`, JSON.stringify({}), 'application/json');
        say('Video added.', 'ok');
        window.location.reload();
      } catch (err) {
        const reason =
          err instanceof VideoError
            ? VIDEO_ERROR_TEXT[err.code]
            : err instanceof PhotoError
              ? PHOTO_ERROR_TEXT[err.code]
              : err instanceof UploadError
                ? err.message
                : 'Something went wrong. Nothing was added.';
        say(`${reason} (Stopped at: ${step}.)`, 'error');
        if (!(err instanceof VideoError) && !(err instanceof UploadError)) console.error(err);
      } finally {
        release();
        cancel = null;
        stop.hidden = true;
        bar.hidden = true;
        go.disabled = false;
        input.disabled = false;
      }
    })();
  });
}

document.querySelectorAll<HTMLElement>('[data-videos]').forEach(init);
