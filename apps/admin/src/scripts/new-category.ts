/**
 * "+ New category" on the item editor: create a category without leaving the
 * item (owner feedback 2026-11-24). It:
 *   1. creates the category (POST /api/categories);
 *   2. adds a ticked checkbox for it in the Categories list, under its parent;
 *   3. saves the item's categories (PUT /api/items/:id/categories);
 *   4. updates the publish checklist in place.
 * No page reload, so unsaved edits elsewhere on the page are kept.
 * DOM is built with createElement/textContent only (Trusted Types).
 */

const CSRF = { 'x-cg-request': '1', 'content-type': 'application/json' };

async function send(method: string, url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: CSRF,
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    if (res.status === 403)
      throw new Error('Your session has expired. Reload the page to sign in again.');
    if (data['error'] === 'slug_taken')
      throw new Error('A category with that name already exists.');
    if (data['error'] === 'invalid')
      throw new Error('Please check the name (1 to 100 characters).');
    throw new Error('Something went wrong. Nothing was changed.');
  }
  return data;
}

function checkbox(id: string, name: string): HTMLLIElement {
  const li = document.createElement('li');
  const label = document.createElement('label');
  label.className = 'inline';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.name = 'categoryIds';
  input.value = id;
  input.dataset['type'] = 'checks';
  input.checked = true;
  label.appendChild(input);
  label.appendChild(document.createTextNode(` ${name}`));
  li.appendChild(label);
  return li;
}

/** The list a new category's checkbox goes into: its parent's sub-list, or the top level. */
function listFor(form: HTMLFormElement, parentId: string): HTMLUListElement | null {
  if (!parentId) {
    return form.querySelector<HTMLUListElement>(
      '[data-category-root], [data-category-root-wrap] > ul',
    );
  }
  const parentInput = Array.from(
    form.querySelectorAll<HTMLInputElement>('input[name="categoryIds"]'),
  ).find((i) => i.value === parentId);
  const li = parentInput?.closest('li');
  if (!li) return null;
  let sub =
    Array.from(li.children).find((c): c is HTMLUListElement => c instanceof HTMLUListElement) ??
    null;
  if (!sub) {
    sub = document.createElement('ul');
    sub.className = 'checks tree';
    li.appendChild(sub);
  }
  return sub;
}

function addParentOption(
  select: HTMLSelectElement,
  id: string,
  name: string,
  parentId: string,
): void {
  const parent = Array.from(select.options).find((o) => o.value === parentId);
  const depth = parent ? Number(parent.dataset['depth'] ?? '0') + 1 : 0;
  const option = document.createElement('option');
  option.value = id;
  option.dataset['depth'] = String(depth);
  option.textContent = `${' '.repeat(depth)}${name}`;
  if (!parent) {
    select.appendChild(option);
    return;
  }
  // After the parent's last existing descendant.
  let after: HTMLOptionElement = parent;
  for (
    let o = parent.nextElementSibling;
    o instanceof HTMLOptionElement;
    o = o.nextElementSibling
  ) {
    if (Number(o.dataset['depth'] ?? '0') < depth) break;
    after = o;
  }
  select.insertBefore(option, after.nextSibling);
}

/** The item now has a category: drop that publish blocker, enable Publish if none remain. */
function clearCategoryBlocker(): void {
  const blocker = document.querySelector('[data-blocker="needs_category"]');
  if (!blocker) return;
  const list = blocker.parentElement;
  blocker.remove();
  if (list && list.children.length === 0) {
    list.remove();
    const publish = document.querySelector<HTMLButtonElement>('button[data-publish]');
    if (publish) publish.disabled = false;
  }
}

function init(form: HTMLFormElement): void {
  const panel = form.querySelector<HTMLElement>('[data-new-category]');
  const nameInput = panel?.querySelector<HTMLInputElement>('#new-category-name');
  const parentSelect = (panel?.querySelector('#new-category-parent') ??
    null) as HTMLSelectElement | null;
  const button = panel?.querySelector<HTMLButtonElement>('[data-new-category-create]');
  const message = panel?.querySelector<HTMLElement>('[data-new-category-message]');
  const itemId = form.dataset['itemId'];
  if (!panel || !nameInput || !parentSelect || !button || !message || !itemId) return;

  const say = (text: string, ok: boolean) => {
    message.textContent = text;
    message.classList.toggle('error', !ok);
  };

  const create = async () => {
    const name = nameInput.value.trim();
    if (!name) {
      say('Type a name first.', false);
      nameInput.focus();
      return;
    }
    const parentId = parentSelect.value;
    button.setAttribute('aria-busy', 'true');
    button.disabled = true;
    try {
      const created = await send('POST', '/api/categories', { name, parentId: parentId || null });
      const id = String(created['id'] ?? '');
      const list = listFor(form, parentId);
      if (!id || !list)
        throw new Error('Created, but the list could not be updated. Reload the page.');
      list.appendChild(checkbox(id, name));
      form.querySelector('[data-no-categories]')?.remove();
      addParentOption(parentSelect, id, name, parentId);

      const categoryIds = Array.from(
        form.querySelectorAll<HTMLInputElement>('input[name="categoryIds"]:checked'),
      ).map((i) => i.value);
      await send('PUT', `/api/items/${encodeURIComponent(itemId)}/categories`, { categoryIds });
      clearCategoryBlocker();
      // The ticks were just saved too.
      delete form.dataset['dirty'];
      nameInput.value = '';
      say(`Created “${name}” and added this item to it.`, true);
    } catch (err) {
      say(err instanceof Error ? err.message : 'Something went wrong.', false);
    } finally {
      button.removeAttribute('aria-busy');
      button.disabled = false;
    }
  };

  button.addEventListener('click', () => void create());
  // Enter in the name field creates the category instead of submitting the form.
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void create();
    }
  });
}

document.querySelectorAll<HTMLFormElement>('form[data-category-form]').forEach(init);
