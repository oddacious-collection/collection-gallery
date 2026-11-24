/**
 * Photo inbox page (D-55): pick photos in order, then create a draft or add
 * them to an item. Selection lives in page memory; the last category chosen
 * is carried in the URL (?cat=) so it's ready for the next draft.
 * DOM changes use textContent only (Trusted Types).
 */

const CSRF = { 'x-cg-request': '1', 'content-type': 'application/json' };

async function post(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: CSRF,
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    if (res.status === 403)
      throw new Error('Your session has expired. Reload the page to sign in again.');
    const reasons = Array.isArray(data['reasons']) ? (data['reasons'] as string[]) : [];
    if (reasons.includes('too_many_photos'))
      throw new Error('That item would have too many photos.');
    if (reasons.includes('in_trash')) throw new Error('That item is in the trash.');
    if (data['error'] === 'not_found') {
      throw new Error('Some of those photos are no longer in the inbox. Reload the page.');
    }
    if (data['error'] === 'invalid')
      throw new Error('Please check the title (1 to 200 characters).');
    throw new Error('Something went wrong. Nothing was changed.');
  }
  return data;
}

function init(bar: HTMLElement): void {
  const grid = document.querySelector<HTMLElement>('[data-inbox-grid]');
  const status = bar.querySelector<HTMLElement>('[data-inbox-status]');
  const message = bar.querySelector<HTMLElement>('[data-inbox-message]');
  const create = bar.querySelector<HTMLButtonElement>('[data-inbox-create]');
  const open = bar.querySelector<HTMLButtonElement>('[data-inbox-open]');
  const cancel = bar.querySelector<HTMLButtonElement>('[data-inbox-cancel]');
  const dialog = (bar.querySelector('[data-inbox-dialog]') ?? null) as HTMLDialogElement | null;
  const dialogCount = bar.querySelector<HTMLElement>('[data-inbox-dialog-count]');
  const dialogMessage = bar.querySelector<HTMLElement>('[data-inbox-dialog-message]');
  const add = bar.querySelector<HTMLButtonElement>('[data-inbox-add]');
  const remove = bar.querySelector<HTMLButtonElement>('[data-inbox-remove]');
  const title = bar.querySelector<HTMLInputElement>('[data-inbox-title]');
  const category = (bar.querySelector('[data-inbox-category]') ?? null) as HTMLSelectElement | null;
  const forItem = bar.dataset['forItem'] ?? '';
  if (!grid || !status || !message) return;

  const selected: string[] = [];
  const say = (text: string, ok: boolean) => {
    message.textContent = text;
    message.classList.toggle('error', !ok);
  };

  const render = () => {
    grid.querySelectorAll<HTMLButtonElement>('[data-inbox-id]').forEach((b) => {
      const i = selected.indexOf(b.dataset['inboxId'] ?? '');
      b.setAttribute('aria-pressed', i >= 0 ? 'true' : 'false');
      const no = b.querySelector<HTMLElement>('[data-pick-no]');
      if (no) no.textContent = i >= 0 ? String(i + 1) : '';
    });
    const n = selected.length;
    status.textContent =
      n === 0
        ? 'Nothing selected yet.'
        : `${n} photo${n === 1 ? '' : 's'} selected${n > 1 ? ' (number 1 becomes the cover)' : ''}.`;
    for (const b of [open, add, remove]) if (b) b.disabled = n === 0;
  };

  // "Create draft…" asks for the title and category in a small dialog, so the
  // bar stays short and the photos stay visible (especially on a phone).
  open?.addEventListener('click', () => {
    if (!dialog || selected.length === 0) return;
    const n = selected.length;
    if (dialogCount) {
      dialogCount.textContent = `${n} photo${n === 1 ? '' : 's'}${n > 1 ? ', in the order you picked them' : ''}.`;
    }
    if (dialogMessage) dialogMessage.textContent = '';
    dialog.showModal();
    title?.focus();
  });
  cancel?.addEventListener('click', () => dialog?.close());

  grid.addEventListener('click', (e) => {
    const button = (e.target as Element | null)?.closest('[data-inbox-id]');
    if (!(button instanceof HTMLButtonElement)) return;
    const id = button.dataset['inboxId'] ?? '';
    const i = selected.indexOf(id);
    if (i >= 0) selected.splice(i, 1);
    else selected.push(id);
    render();
  });

  const busy = async (button: HTMLButtonElement, work: () => Promise<void>) => {
    button.setAttribute('aria-busy', 'true');
    button.disabled = true;
    try {
      await work();
    } catch (err) {
      const text = err instanceof Error ? err.message : 'Something went wrong.';
      // Errors from the dialog show inside it.
      if (dialog?.open && dialogMessage) {
        dialogMessage.textContent = text;
        dialogMessage.classList.add('error');
      } else {
        say(text, false);
      }
      button.disabled = false;
    } finally {
      button.removeAttribute('aria-busy');
    }
  };

  create?.addEventListener(
    'click',
    () =>
      void busy(create, async () => {
        const name = title?.value.trim() ?? '';
        if (!name) {
          title?.focus();
          throw new Error('Give the new draft a title first.');
        }
        const categoryId = category?.value || null;
        const data = await post('/api/inbox/assign', {
          photoIds: selected,
          title: name,
          categoryId,
        });
        const next = new URLSearchParams();
        if (categoryId) next.set('cat', categoryId);
        next.set('done', String(data['id'] ?? ''));
        window.location.assign(`/inbox?${next.toString()}`);
      }),
  );

  add?.addEventListener(
    'click',
    () =>
      void busy(add, async () => {
        await post('/api/inbox/assign', { photoIds: selected, itemId: forItem });
        window.location.assign(`/items/${encodeURIComponent(forItem)}#photos`);
      }),
  );

  remove?.addEventListener(
    'click',
    () =>
      void busy(remove, async () => {
        const n = selected.length;
        if (
          !window.confirm(
            `Remove ${n} photo${n === 1 ? '' : 's'} from the inbox? You can restore them for 30 days.`,
          )
        ) {
          remove.disabled = false;
          return;
        }
        await post('/api/inbox/remove', { photoIds: selected });
        window.location.reload();
      }),
  );

  // Enter in the title creates the draft.
  title?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      create?.click();
    }
  });

  render();
}

document.querySelectorAll<HTMLElement>('[data-inbox-bar]').forEach(init);
