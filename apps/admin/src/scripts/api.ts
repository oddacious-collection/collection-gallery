/**
 * Sends admin forms and action buttons to the JSON API (SEC-04).
 *
 * Plain HTML forms can't add the custom CSRF header, so every admin write goes
 * through here. Markup contract:
 *
 *   <form data-api="/api/items/ID" data-method="PATCH" data-then="reload">
 *     <input name="title" />                          string
 *     <input name="purchasePriceCents" data-type="cents" />   "12.50" → 1250, "" → null
 *     <input name="openToParting" type="checkbox" data-type="bool" />
 *     <input name="purchaseDate" data-type="nullable" />      "" → null
 *     <input name="tags" data-type="list" />                  "a, b" → ["a","b"]
 *     <input name="categoryIds" type="checkbox" value="ID" data-type="checks" />
 *     <p data-api-message role="status"></p>
 *   </form>
 *
 *   <button data-api="/api/items/ID/status" data-method="POST"
 *           data-body='{"status":"public"}' data-then="reload"
 *           data-confirm="Publish now?">Publish</button>
 *
 * data-then: "reload", "redirect:/path/{id}" ({id} and {slug} come from the
 * response) or "none". Messages are set with textContent only (Trusted Types).
 */

const CSRF_HEADER = 'x-cg-request';

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function valueOf(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): Json {
  const type = el.dataset['type'] ?? 'string';
  if (type === 'bool') return (el as HTMLInputElement).checked;
  const raw = el.value;
  switch (type) {
    case 'nullable':
      return raw.trim() === '' ? null : raw.trim();
    case 'int':
      return raw.trim() === '' ? null : Number.parseInt(raw, 10);
    case 'cents': {
      const t = raw.trim().replace(/[$,\s]/g, '');
      if (t === '') return null;
      const n = Number(t);
      return Number.isFinite(n) ? Math.round(n * 100) : NaN;
    }
    case 'list':
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    default:
      return raw;
  }
}

function formBody(form: HTMLFormElement): Record<string, Json> {
  const body: Record<string, Json> = {};
  for (const el of Array.from(form.elements)) {
    if (
      !(
        el instanceof HTMLInputElement ||
        el instanceof HTMLSelectElement ||
        el instanceof HTMLTextAreaElement
      ) ||
      !el.name ||
      el.disabled
    ) {
      continue;
    }
    if (el.dataset['type'] === 'checks') {
      const list = (body[el.name] as Json[] | undefined) ?? [];
      if ((el as HTMLInputElement).checked) list.push(el.value);
      body[el.name] = list;
      continue;
    }
    body[el.name] = valueOf(el);
  }
  return body;
}

const REASONS: Record<string, string> = {
  needs_category: 'add at least one category',
  needs_media: 'add at least one photo',
  wishlist: 'wishlist items can never be public',
  in_trash: 'restore it from the trash first',
  has_children: 'it has subcategories',
  has_items: 'items are still in it',
  cycle: "a category can't go inside itself or its own subcategories",
  order_mismatch: 'the photo list changed; reload the page',
};

function describeError(status: number, data: Record<string, unknown>): string {
  const code = typeof data['error'] === 'string' ? data['error'] : '';
  const reasons = Array.isArray(data['reasons']) ? (data['reasons'] as string[]) : [];
  const reason = typeof data['reason'] === 'string' ? [data['reason']] : [];
  const words = [...reasons, ...reason].map((r) => REASONS[r] ?? r);
  if (code === 'slug_taken') return 'That URL name is already used by another entry.';
  if (code === 'cannot_publish') return `Can't publish yet: ${words.join('; ')}.`;
  if (code === 'conflict') return `Can't do that: ${words.join('; ')}.`;
  if (code === 'not_found') return 'Not found. It may have been deleted.';
  if (code === 'invalid') {
    const issues = Array.isArray(data['issues'])
      ? (data['issues'] as Array<{ path: string; message: string }>)
          .map((i) => `${i.path || 'input'}: ${i.message}`)
          .join('; ')
      : words.join('; ');
    return `Please check the form: ${issues || 'invalid input'}.`;
  }
  return status === 403
    ? 'Your session has expired. Reload the page to sign in again.'
    : 'Something went wrong. Nothing was changed.';
}

function showMessage(scope: Element, text: string, ok: boolean): void {
  const target =
    scope.querySelector('[data-api-message]') ?? document.querySelector('#api-message');
  if (!target) return;
  target.textContent = text;
  target.classList.toggle('error', !ok);
}

function fill(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{(id|slug)\}/g, (_, key: string) =>
    encodeURIComponent(String(data[key] ?? '')),
  );
}

async function request(
  url: string,
  method: string,
  body: Record<string, Json> | null,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' },
    body: body === null ? null : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, data };
}

// ------------------------------------------------------------------ unsaved changes
//
// Typing in or ticking a field of an API form marks it "dirty" until it is
// saved. Anything that reloads or leaves the page first saves every other
// dirty form, so an edit in one card is never lost (or blocks a reload) when
// another card is saved, a photo is moved or the item is published. Only
// leaving by a link, Back or closing the tab with unsaved changes asks first.

const dirtyForms = (): HTMLFormElement[] =>
  Array.from(document.querySelectorAll<HTMLFormElement>('form[data-api][data-dirty]'));

function formLabel(form: HTMLFormElement): string {
  return (
    form.dataset['label'] ??
    form.querySelector('h2')?.textContent?.trim() ??
    'A form'
  ).replace(/\s+/g, ' ');
}

function updateSaveBar(): void {
  const bar = document.querySelector<HTMLElement>('[data-save-bar]');
  if (!bar) return;
  const status = bar.querySelector<HTMLElement>('[data-save-status]');
  const save = bar.querySelector<HTMLButtonElement>('[data-save-all]');
  const labels = dirtyForms().map(formLabel);
  bar.classList.toggle('dirty', labels.length > 0);
  if (status) {
    status.textContent = labels.length
      ? `Unsaved changes: ${labels.join(', ')}.`
      : 'All changes saved.';
  }
  if (save) save.disabled = labels.length === 0;
}

/** Saves one form without reloading. Returns false (and shows why) on failure. */
async function saveForm(form: HTMLFormElement): Promise<boolean> {
  try {
    const r = await request(
      form.dataset['api'] ?? '',
      form.dataset['method'] ?? 'POST',
      formBody(form),
    );
    if (!r.ok) {
      showMessage(form, describeError(r.status, r.data), false);
      return false;
    }
    delete form.dataset['dirty'];
    showMessage(form, 'Saved.', true);
    return true;
  } catch {
    showMessage(form, 'Network error. Nothing was changed; try again.', false);
    return false;
  } finally {
    updateSaveBar();
  }
}

/** Saves every form with unsaved changes (except `except`), stopping at the first failure. */
async function saveDirtyForms(except: Element | null = null): Promise<boolean> {
  for (const form of dirtyForms()) {
    if (form === except) continue;
    if (!(await saveForm(form))) {
      form.scrollIntoView({ block: 'center' });
      return false;
    }
  }
  return true;
}

async function send(
  el: HTMLElement,
  url: string,
  method: string,
  body: Record<string, Json> | null,
): Promise<void> {
  const confirmText = el.dataset['confirm'];
  if (confirmText && !window.confirm(confirmText)) return;
  const scope = el.closest('form') ?? el.closest('[data-api-scope]') ?? document.body;
  const then = el.dataset['then'] ?? 'reload';
  el.setAttribute('aria-busy', 'true');
  try {
    // Reloading or leaving: save the other cards' edits first.
    if (then !== 'none' && !(await saveDirtyForms(el instanceof HTMLFormElement ? el : null))) {
      showMessage(
        scope,
        "Another section couldn't be saved (see its message), so nothing else was done.",
        false,
      );
      return;
    }
    const res = await request(url, method, body);
    if (!res.ok) {
      showMessage(scope, describeError(res.status, res.data), false);
      return;
    }
    // A saved form has no unsaved changes any more.
    if (el instanceof HTMLFormElement) delete el.dataset['dirty'];
    updateSaveBar();
    if (then.startsWith('redirect:')) {
      window.location.assign(fill(then.slice('redirect:'.length), res.data));
    } else if (then === 'reload') {
      window.location.reload();
    } else {
      showMessage(scope, 'Saved.', true);
    }
  } catch {
    showMessage(scope, 'Network error. Nothing was changed; try again.', false);
  } finally {
    el.removeAttribute('aria-busy');
  }
}

function markDirty(event: Event): void {
  const field = event.target;
  if (!(field instanceof HTMLElement) || !field.getAttribute('name')) return;
  const form = field.closest<HTMLFormElement>('form[data-api]');
  if (form && form.dataset['dirty'] !== '1') {
    form.dataset['dirty'] = '1';
    updateSaveBar();
  }
}
document.addEventListener('input', markDirty);
document.addEventListener('change', markDirty);

// The save bar: "Save" saves every section; "Save and close" also goes back to the list.
document.addEventListener('click', (event) => {
  const button = (event.target as Element | null)?.closest('[data-save-all], [data-save-close]');
  if (!(button instanceof HTMLButtonElement)) return;
  event.preventDefault();
  void (async () => {
    button.setAttribute('aria-busy', 'true');
    const ok = await saveDirtyForms();
    button.removeAttribute('aria-busy');
    if (!ok) return;
    const href = button.dataset['href'];
    if (button.hasAttribute('data-save-close') && href) window.location.assign(href);
    else window.location.reload();
  })();
});

// Tag suggestions add the tag to the box, then save the Tags section.
document.addEventListener('click', (event) => {
  const button = (event.target as Element | null)?.closest('button[data-add-tag]');
  if (!(button instanceof HTMLButtonElement)) return;
  const form = button.closest('form');
  const input = form?.querySelector<HTMLInputElement>('input[name="tags"]');
  const tag = button.dataset['addTag'] ?? '';
  if (!form || !input || !tag) return;
  event.preventDefault();
  const tags = input.value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!tags.some((t) => t.toLowerCase() === tag.toLowerCase())) tags.push(tag);
  input.value = tags.join(', ');
  form.dataset['dirty'] = '1';
  form.requestSubmit();
});
window.addEventListener('beforeunload', (event) => {
  if (document.querySelector('form[data-api][data-dirty]')) {
    event.preventDefault();
    // Older Safari needs returnValue set to show the prompt.
    event.returnValue = '';
  }
});

document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.dataset['api']) return;
  event.preventDefault();
  void send(form, form.dataset['api'], form.dataset['method'] ?? 'POST', formBody(form));
});

document.addEventListener('click', (event) => {
  const button = (event.target as Element | null)?.closest('button[data-api]');
  if (!(button instanceof HTMLButtonElement)) return;
  // A form's own submit button goes through the submit handler instead.
  if (button.type === 'submit' && button.form?.dataset['api']) return;
  event.preventDefault();
  const raw = button.dataset['body'];
  let body: Record<string, Json> | null = null;
  if (raw) {
    try {
      body = JSON.parse(raw) as Record<string, Json>;
    } catch {
      return;
    }
  }
  void send(button, button.dataset['api'] ?? '', button.dataset['method'] ?? 'POST', body);
});

// Photo order buttons (ADM-03): up, down, or "make cover" (move to the top).
document.addEventListener('click', (event) => {
  const button = (event.target as Element | null)?.closest('button[data-photo-move]');
  if (!(button instanceof HTMLButtonElement)) return;
  const row = button.closest('[data-media-id]');
  const list = row?.parentElement;
  const itemId = list?.dataset['itemId'];
  if (!row || !list || !itemId) return;
  const ids = Array.from(list.children)
    .map((c) => (c as HTMLElement).dataset['mediaId'])
    .filter((x): x is string => Boolean(x));
  const from = ids.indexOf((row as HTMLElement).dataset['mediaId'] ?? '');
  const dir = button.dataset['photoMove'];
  const to = dir === 'first' ? 0 : dir === 'up' ? from - 1 : from + 1;
  if (from < 0 || to < 0 || to >= ids.length || to === from) return;
  const [moved] = ids.splice(from, 1);
  if (moved) ids.splice(to, 0, moved);
  // The page reloads with the new order (and the right buttons) once it's saved.
  void send(button, `/api/items/${encodeURIComponent(itemId)}/media/order`, 'PUT', { order: ids });
});

// Reorder buttons for category siblings: move the row, then send the new order.
document.addEventListener('click', (event) => {
  const button = (event.target as Element | null)?.closest('button[data-move]');
  if (!(button instanceof HTMLButtonElement)) return;
  const row = button.closest('[data-category-id]');
  const list = row?.parentElement;
  if (!row || !list) return;
  const dir = button.dataset['move'];
  const sibling = dir === 'up' ? row.previousElementSibling : row.nextElementSibling;
  if (!sibling) return;
  if (dir === 'up') list.insertBefore(row, sibling);
  else list.insertBefore(sibling, row);
  const order = Array.from(list.children)
    .map((c) => (c as HTMLElement).dataset['categoryId'])
    .filter((x): x is string => Boolean(x));
  const parentId = list.dataset['parentId'] || null;
  void send(button, '/api/categories', 'PUT', { parentId, order });
});
