/** Full-screen photo view: ← / → for previous and next, Esc to close. */
const link = (name: string) => document.querySelector<HTMLAnchorElement>(`[data-viewer-${name}]`);

document.addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
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
