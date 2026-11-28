/**
 * "Apply the rules to drafts" (D-62 (3)): asks the server for one batch at a
 * time until every imported draft has been seen, showing progress.
 * Messages use textContent only (Trusted Types).
 */
const CSRF = { 'x-cg-request': '1' };

const button = document.querySelector<HTMLButtonElement>('[data-apply-rules]');
const message = document.querySelector<HTMLElement>('[data-apply-message]');
if (button && message) {
  const say = (text: string, ok = true) => {
    message.textContent = text;
    message.classList.toggle('error', !ok);
  };
  button.addEventListener('click', () => {
    button.disabled = true;
    void (async () => {
      let cursor: string | null = null;
      let seen = 0;
      let changed = 0;
      try {
        do {
          const res = await fetch('/api/hashtag-rules/apply', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { ...CSRF, 'content-type': 'application/json' },
            body: JSON.stringify({ cursor }),
          });
          if (!res.ok) {
            say(
              res.status === 403
                ? 'Your session has expired. Reload the page to sign in again.'
                : 'The rules couldn’t be applied. Try again.',
              false,
            );
            return;
          }
          const data = (await res.json()) as {
            processed: number;
            changed: number;
            nextCursor: string | null;
          };
          seen += data.processed;
          changed += data.changed;
          cursor = data.nextCursor;
          say(`Working… ${seen} drafts checked, ${changed} updated.`);
        } while (cursor);
        say(`Done: ${seen} drafts checked, ${changed} updated.`);
      } catch {
        say('Network error. Run it again: it only ever adds what is missing.', false);
      } finally {
        button.disabled = false;
      }
    })();
  });
}
