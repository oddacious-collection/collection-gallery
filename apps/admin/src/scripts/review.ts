/**
 * The review queue page (IMP-04, D-62 (7)): hashtag suggestions add to the
 * tags box; Publish & next / Save & next / Not an item send everything in one
 * request and go to the next draft. A blocked publish stays on the draft and
 * says why. Messages use textContent only (Trusted Types).
 */
const CSRF = { 'x-cg-request': '1' };

const REASON: Record<string, string> = {
  needs_category: 'tick at least one category',
  needs_media: 'it needs a photo (add one in the full editor)',
  wishlist: 'wishlist items can never be public',
  in_trash: 'it is in the trash',
};

const form = document.querySelector<HTMLFormElement>('form[data-review]');
if (form) {
  const id = form.dataset['review'] ?? '';
  const filter = form.dataset['filter'] ?? 'all';
  const message = form.querySelector<HTMLElement>('[data-review-message]');
  const tagsInput = form.querySelector<HTMLInputElement>('input[name="tags"]');
  const say = (text: string, ok: boolean) => {
    if (!message) return;
    message.textContent = text;
    message.classList.toggle('error', !ok);
  };
  const nextUrl = filter === 'all' ? '/review' : `/review?filter=${encodeURIComponent(filter)}`;

  form.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    const suggestion = target?.closest<HTMLButtonElement>('button[data-review-tag]');
    if (suggestion && tagsInput) {
      const tag = suggestion.dataset['reviewTag'] ?? '';
      const list = tagsInput.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (tag && !list.some((t) => t.toLowerCase() === tag.toLowerCase())) list.push(tag);
      tagsInput.value = list.join(', ');
      suggestion.hidden = true;
      return;
    }
    const button = target?.closest<HTMLButtonElement>('button[data-then]');
    if (!button) return;
    const then = button.dataset['then'] ?? 'save';
    if (
      then === 'trash' &&
      !window.confirm('Move this draft to the trash? You can restore it for 30 days.')
    ) {
      return;
    }
    const body = {
      title: form.querySelector<HTMLInputElement>('input[name="title"]')?.value ?? '',
      description:
        form.querySelector<HTMLTextAreaElement>('textarea[name="description"]')?.value ?? '',
      categoryIds: Array.from(
        form.querySelectorAll<HTMLInputElement>('input[name="categoryIds"]:checked'),
        (c) => c.value,
      ),
      tags: (tagsInput?.value ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      then,
    };
    const buttons = form.querySelectorAll<HTMLButtonElement>('button[data-then]');
    buttons.forEach((b) => (b.disabled = true));
    say('Saving…', true);
    void (async () => {
      try {
        const res = await fetch(`/api/review/${encodeURIComponent(id)}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { ...CSRF, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          say(
            res.status === 403
              ? 'Your session has expired. Reload the page to sign in again.'
              : 'That couldn’t be saved. Check the title (it can’t be empty) and try again.',
            false,
          );
          return;
        }
        if (then === 'publish' && data['published'] !== true) {
          const reasons = Array.isArray(data['reasons']) ? (data['reasons'] as string[]) : [];
          say(
            `Saved, but not published yet: ${reasons.map((r) => REASON[r] ?? r).join('; ') || 'check the item'}.`,
            false,
          );
          return;
        }
        window.location.assign(nextUrl);
      } catch {
        say('Network error. Nothing was lost; try again.', false);
      } finally {
        buttons.forEach((b) => (b.disabled = false));
      }
    })();
  });
}
