/**
 * "Add photos" on the item editor (ADM-01, ADM-03, D-46). For each chosen
 * photo, one at a time (iPhone memory):
 *
 *   process on this device → POST …/media (plan) → PUT each file → finalize
 *
 * Each file upload is retried on network errors (NFR-06): re-sending a file
 * is safe until finalize. Messages use textContent only (Trusted Types).
 *
 * Markup: <section data-photos data-item-id="…"> with
 *   <input type="file" data-photo-input> and <ul data-photo-progress>.
 */
import { PHOTO_ERROR_TEXT, PhotoError, partLabel, processPhoto } from './process.ts';
import { encodeWebp } from './webp.ts';

const CSRF = { 'x-cg-request': '1' };
const RETRIES = 3;

class UploadError extends Error {
  override readonly name = 'UploadError';
}

function serverMessage(status: number, data: Record<string, unknown>): string {
  if (status === 403) return 'Your session has expired. Reload the page to sign in again.';
  const reason = typeof data['reason'] === 'string' ? data['reason'] : '';
  const reasons = Array.isArray(data['reasons']) ? (data['reasons'] as string[]) : [];
  if (reasons.includes('in_trash')) return 'This item is in the trash. Restore it first.';
  if (reasons.includes('too_many_photos'))
    return 'This item already has the maximum number of photos.';
  if (reasons.includes('inbox_full'))
    return 'The inbox is full (500 photos). Sort some into items first.';
  if (reason === 'photo_too_small') return PHOTO_ERROR_TEXT.too_small;
  if (reason.startsWith('file_')) {
    return `The server refused one of the processed files (${reason.slice(5).replace(/_/g, ' ')}). Nothing was added.`;
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
      if (attempt >= RETRIES)
        throw new UploadError('Network error. Check your connection and try again.');
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      continue;
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return data;
    if (res.status >= 500 && attempt < RETRIES) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      continue;
    }
    throw new UploadError(serverMessage(res.status, data));
  }
}

interface Began {
  uploadId: string;
  parts: Array<{ name: string; width: number; height: number }>;
}

async function uploadOne(
  target: { beginUrl: string; finishLabel: string },
  file: File,
  say: (s: string) => void,
): Promise<void> {
  const photo = await processPhoto(file, encodeWebp, say);
  say('Starting the upload');
  const began = (await request(
    'POST',
    target.beginUrl,
    JSON.stringify({ width: photo.width, height: photo.height }),
    'application/json',
  )) as unknown as Began;
  // The server plans independently; both must agree exactly.
  const local = photo.plan.map((p) => `${p.name}:${p.width}x${p.height}`).join(',');
  const remote = began.parts.map((p) => `${p.name}:${p.width}x${p.height}`).join(',');
  if (local !== remote)
    throw new UploadError('The server expected different photo sizes. Reload and try again.');

  let n = 0;
  for (const part of photo.plan) {
    n++;
    say(`Uploading the ${partLabel(part)} (file ${n} of ${photo.plan.length})`);
    const bytes = photo.files.get(part.name);
    if (!bytes) throw new UploadError('A processed file is missing.');
    await request(
      'PUT',
      `/api/uploads/${encodeURIComponent(began.uploadId)}/${encodeURIComponent(part.name)}`,
      bytes as Uint8Array<ArrayBuffer>,
      part.format,
    );
  }
  say(target.finishLabel);
  await request(
    'POST',
    `/api/uploads/${encodeURIComponent(began.uploadId)}/finalize`,
    JSON.stringify({}),
    'application/json',
  );
}

function init(section: HTMLElement): void {
  // Where uploads start: an item's photos, or the inbox (D-55).
  const itemId = section.dataset['itemId'] ?? '';
  const target = {
    beginUrl:
      section.dataset['beginUrl'] ??
      (itemId ? `/api/items/${encodeURIComponent(itemId)}/media` : ''),
    finishLabel: section.dataset['finishLabel'] ?? 'Attaching the photo to the item',
  };
  const input = section.querySelector<HTMLInputElement>('input[data-photo-input]');
  const progress = section.querySelector<HTMLElement>('[data-photo-progress]');
  if (!input || !progress || !target.beginUrl) return;

  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? []);
    if (files.length === 0) return;
    input.disabled = true;
    progress.replaceChildren();
    const rows = files.map((f) => {
      const li = document.createElement('li');
      li.textContent = `${f.name}: waiting`;
      progress.appendChild(li);
      return li;
    });
    void (async () => {
      let added = 0;
      for (const [i, file] of files.entries()) {
        const li = rows[i] as HTMLLIElement;
        const counter = files.length > 1 ? ` (photo ${i + 1} of ${files.length})` : '';
        let step = 'Waiting';
        const say = (s: string) => {
          step = s;
          li.textContent = `${file.name}${counter}: ${s}…`;
        };
        try {
          await uploadOne(target, file, say);
          li.textContent = `${file.name}: added.`;
          li.classList.add('ok');
          added++;
        } catch (err) {
          const reason =
            err instanceof PhotoError
              ? PHOTO_ERROR_TEXT[err.code]
              : err instanceof UploadError
                ? err.message
                : 'Something went wrong. Nothing was added.';
          // Say where it stopped, so a problem can be traced.
          li.textContent = `${file.name}: ${reason} (Stopped at: ${step}.)`;
          li.classList.add('error');
          if (!(err instanceof PhotoError) && !(err instanceof UploadError)) console.error(err);
        }
      }
      input.value = '';
      input.disabled = false;
      section.dataset['photosDone'] = String(added);
      // Show the new photos once everything succeeded; keep errors visible otherwise.
      if (added === files.length) window.location.reload();
      else if (added > 0) {
        const li = document.createElement('li');
        li.textContent = 'Reload the page to see the photos that were added.';
        progress.appendChild(li);
      }
    })();
  });
}

document.querySelectorAll<HTMLElement>('[data-photos]').forEach(init);
