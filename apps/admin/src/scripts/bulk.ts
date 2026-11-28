/**
 * Bulk actions in the item list (IMP-04): tick items, then publish them, add
 * a category or move them to the trash. Sent in groups of up to 50; each item
 * succeeds or fails on its own and the result says which and why.
 * Messages use textContent only (Trusted Types).
 */
const CSRF = { 'x-cg-request': '1' };
const REASON: Record<string, string> = {
  needs_category: 'no category',
  needs_media: 'no photo',
  wishlist: 'wishlist item',
  in_trash: 'in the trash',
  not_found: 'not found',
};

const bar = document.querySelector<HTMLElement>('[data-bulk]');
if (bar) {
  const max = Number(bar.dataset['bulkMax'] ?? '50');
  const all = bar.querySelector<HTMLInputElement>('[data-bulk-all]');
  const count = bar.querySelector<HTMLElement>('[data-bulk-count]');
  const message = bar.querySelector<HTMLElement>('[data-bulk-message]');
  const category = document.getElementById('bulk-category') as HTMLSelectElement | null;
  const actions = bar.querySelectorAll<HTMLButtonElement>('[data-bulk-action]');
  const picks = () =>
    Array.from(document.querySelectorAll<HTMLInputElement>('input[data-bulk-pick]'));
  const chosen = () =>
    picks()
      .filter((p) => p.checked)
      .map((p) => p.value);
  const say = (text: string, ok = true) => {
    if (!message) return;
    message.textContent = text;
    message.classList.toggle('error', !ok);
  };
  const refresh = () => {
    const n = chosen().length;
    if (count) count.textContent = n === 0 ? 'None selected' : `${n} selected`;
    actions.forEach((b) => (b.disabled = n === 0));
    if (category) category.disabled = n === 0;
    if (all) all.checked = n > 0 && n === picks().length;
  };
  document.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement | null;
    if (t?.matches('input[data-bulk-pick]')) refresh();
  });
  all?.addEventListener('change', () => {
    for (const p of picks()) p.checked = all.checked;
    refresh();
  });

  actions.forEach((button) =>
    button.addEventListener('click', () => {
      const action = button.dataset['bulkAction'] ?? '';
      const ids = chosen();
      if (ids.length === 0) return;
      const categoryId = category?.value ?? '';
      if (action === 'add-category' && !categoryId) {
        say('Choose the category to add first.', false);
        return;
      }
      if (
        action === 'trash' &&
        !window.confirm(
          `Move ${ids.length} item(s) to the trash? You can restore them for 30 days.`,
        )
      ) {
        return;
      }
      actions.forEach((b) => (b.disabled = true));
      say('Working…');
      void (async () => {
        let done = 0;
        const failed: string[] = [];
        try {
          for (let i = 0; i < ids.length; i += max) {
            const res = await fetch('/api/items/bulk', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { ...CSRF, 'content-type': 'application/json' },
              body: JSON.stringify({
                ids: ids.slice(i, i + max),
                action,
                ...(action === 'add-category' ? { categoryId } : {}),
              }),
            });
            if (!res.ok) {
              say(
                res.status === 403
                  ? 'Your session has expired. Reload the page to sign in again.'
                  : 'That didn’t work. Nothing more was changed.',
                false,
              );
              return;
            }
            const data = (await res.json()) as {
              results: Array<{ id: string; ok: boolean; reasons?: string[] }>;
            };
            for (const r of data.results) {
              if (r.ok) done++;
              else {
                const row = document.querySelector<HTMLInputElement>(
                  `input[data-bulk-pick][value="${CSS.escape(r.id)}"]`,
                );
                const title = row?.getAttribute('aria-label')?.replace(/^Select /, '') ?? r.id;
                failed.push(
                  `${title} (${(r.reasons ?? []).map((x) => REASON[x] ?? x).join(', ')})`,
                );
              }
            }
          }
          if (failed.length) {
            say(`${done} done. Not done: ${failed.join('; ')}. Reload to see the changes.`, false);
          } else {
            say(`${done} done. Reloading…`);
            window.location.reload();
          }
        } catch {
          say('Network error. Some may have been done; reload to check.', false);
        } finally {
          refresh();
        }
      })();
    }),
  );
  refresh();
}
