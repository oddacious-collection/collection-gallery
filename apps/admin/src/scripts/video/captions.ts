/**
 * Captions on the item editor (MED-12, D-65): pick a .vtt or .srt file for a
 * video and it is sent as-is; the server checks it and publishes a cleaned
 * WebVTT copy. Messages use textContent only (Trusted Types).
 */

const CSRF = { 'x-cg-request': '1' };
const MAX_BYTES = 256 * 1024;

function at(data: Record<string, unknown>): string {
  return typeof data['block'] === 'number' ? ` (caption ${data['block']} in the file)` : '';
}

function message(status: number, data: Record<string, unknown>): string {
  if (status === 403) return 'Your session has expired. Reload the page to sign in again.';
  const reason = typeof data['reason'] === 'string' ? data['reason'] : '';
  switch (reason) {
    case 'captions_too_large':
      return 'That file is too big for captions (256 KB at most).';
    case 'captions_not_utf8':
      return 'That file isn’t plain UTF-8 text. Save it as UTF-8 and try again.';
    case 'captions_empty':
      return 'No captions were found in that file.';
    case 'captions_bad_block':
      return `Part of the file isn’t a caption${at(data)}. Each caption needs a timing line like 00:00:01.000 --> 00:00:03.000, and a blank line between captions.`;
    case 'captions_bad_timing':
      return `A timing line can’t be read, or ends before it starts${at(data)}. Use the form 00:00:01.000 --> 00:00:03.000.`;
    case 'captions_starts_after_end':
      return `A caption starts after the video ends${at(data)}. Were these captions made for the untrimmed video?`;
    case 'captions_too_many_cues':
      return 'That file has too many captions (2,000 at most).';
    case 'captions_line_too_long':
      return `A caption line is too long${at(data)} (500 characters at most).`;
    case 'not_a_video':
      return 'Captions can only be added to a video.';
    default:
      return 'The captions couldn’t be added. Nothing was changed.';
  }
}

for (const box of document.querySelectorAll<HTMLElement>('[data-captions]')) {
  const input = box.querySelector<HTMLInputElement>('[data-captions-input]');
  const status = box.querySelector<HTMLElement>('[data-captions-message]');
  const mediaId = box.dataset['captions'] ?? '';
  if (!input || !status) continue;
  const show = (text: string, ok: boolean) => {
    status.textContent = text;
    status.classList.toggle('error', !ok);
  };
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > MAX_BYTES) {
      show(message(400, { reason: 'captions_too_large' }), false);
      input.value = '';
      return;
    }
    void (async () => {
      input.disabled = true;
      show('Checking and adding the captions…', true);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const res = await fetch(`/api/media/${encodeURIComponent(mediaId)}/captions`, {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { ...CSRF, 'content-type': 'application/octet-stream' },
          body: bytes,
        });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          show(message(res.status, data), false);
          return;
        }
        const n = typeof data['cues'] === 'number' ? data['cues'] : 0;
        show(`Added ${n} caption${n === 1 ? '' : 's'}. Reloading…`, true);
        window.location.reload();
      } catch {
        show('Network error. Nothing was changed; try again.', false);
      } finally {
        input.disabled = false;
        input.value = '';
      }
    })();
  });
}
