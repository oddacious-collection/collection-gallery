/**
 * Full-screen photo or video view: ← / → for previous and next, Esc to close.
 * While a video's player has focus, ← / → are its own (seeking).
 */
const link = (name: string) => document.querySelector<HTMLAnchorElement>(`[data-viewer-${name}]`);

document.addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.target instanceof HTMLVideoElement) {
    return;
  }
  const target =
    e.key === 'ArrowLeft'
      ? link('prev')
      : e.key === 'ArrowRight'
        ? link('next')
        : e.key === 'Escape'
          ? link('close')
          : null;
  if (target) {
    e.preventDefault();
    window.location.assign(target.href);
  }
});
