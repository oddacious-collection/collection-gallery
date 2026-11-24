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

async function send(
  el: HTMLElement,
  url: string,
  method: string,
  body: Record<string, Json> | null,
): Promise<void> {
  const confirmText = el.dataset['confirm'];
  if (confirmText && !window.confirm(confirmText)) return;
  const scope = el.closest('form') ?? el.closest('[data-api-scope]') ?? document.body;
  el.setAttribute('aria-busy', 'true');
  try {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' },
      body: body === null ? null : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      showMessage(scope, describeError(res.status, data), false);
      return;
    }
    // A saved form has no unsaved changes any more.
    if (el instanceof HTMLFormElement) delete el.dataset['dirty'];
    const then = el.dataset['then'] ?? 'reload';
    if (then.startsWith('redirect:')) {
      window.location.assign(fill(then.slice('redirect:'.length), data));
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

// Unsaved changes: typing in or ticking a field of an API form marks it
// "dirty" until it is saved, and leaving the page then asks first.
function markDirty(event: Event): void {
  const field = event.target;
  if (!(field instanceof HTMLElement) || !field.getAttribute('name')) return;
  const form = field.closest<HTMLFormElement>('form[data-api]');
  if (form) form.dataset['dirty'] = '1';
}
document.addEventListener('input', markDirty);
document.addEventListener('change', markDirty);
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
  const dir = button.dataset['photoMove'];
  if (dir === 'first') list.insertBefore(row, list.firstElementChild);
  else if (dir === 'up' && row.previousElementSibling)
    list.insertBefore(row, row.previousElementSibling);
  else if (dir === 'down' && row.nextElementSibling) list.insertBefore(row.nextElementSibling, row);
  else return;
  const order = Array.from(list.children)
    .map((c) => (c as HTMLElement).dataset['mediaId'])
    .filter((x): x is string => Boolean(x));
  void send(button, `/api/items/${encodeURIComponent(itemId)}/media/order`, 'PUT', { order });
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
