/**
 * Photo carousels and the vertical feed (PUB-04, PUB-05). Progressive
 * enhancement of server-rendered markup; everything works without it.
 *
 * Carousel: arrows, a "2 / 5" counter, ←/→ keys; swiping is native
 * (scroll snapping).
 *
 * Feed: on an item page, the neighbouring items of the list it was opened
 * from load as you scroll (2 ahead, PUB-05 prefetch), the address bar follows
 * the item on screen (history.replaceState, so Back returns to the list), and
 * ↑/↓ (or j/k) and the on-screen buttons move between items.
 *
 * Privacy: state lives in page memory only. No storage, no cookies (PRV-01).
 */

// Videos in the carousels play in place (PUB-06).
import './video.ts';

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const behavior: ScrollBehavior = reduceMotion ? 'auto' : 'smooth';

// ------------------------------------------------------------------ carousel

const carousels = new WeakMap<Element, (delta: number) => void>();

function initCarousel(root: HTMLElement): void {
  const slides = root.querySelector<HTMLElement>('.slides');
  if (!slides || carousels.has(root)) return;
  const count = slides.children.length;
  const prev = root.querySelector<HTMLButtonElement>('[data-prev]');
  const next = root.querySelector<HTMLButtonElement>('[data-next]');
  const label = root.querySelector<HTMLElement>('[data-count]');
  const index = () => Math.round(slides.scrollLeft / Math.max(slides.clientWidth, 1));
  const go = (i: number) => {
    const target = Math.min(Math.max(i, 0), count - 1);
    slides.scrollTo({ left: target * slides.clientWidth, behavior });
  };
  const update = () => {
    const i = index();
    if (label) label.textContent = `${i + 1} / ${count}`;
    if (prev) prev.disabled = i <= 0;
    if (next) next.disabled = i >= count - 1;
  };
  carousels.set(root, (delta) => go(index() + delta));
  if (count < 2) return;
  if (prev) prev.hidden = false;
  if (next) next.hidden = false;
  prev?.addEventListener('click', () => go(index() - 1));
  next?.addEventListener('click', () => go(index() + 1));
  let frame = 0;
  slides.addEventListener(
    'scroll',
    () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    },
    { passive: true },
  );
  slides.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      go(index() + (e.key === 'ArrowLeft' ? -1 : 1));
    }
  });
  update();
}

document.querySelectorAll<HTMLElement>('[data-carousel]').forEach(initCarousel);

// ------------------------------------------------------------------ feed

const feed = document.querySelector<HTMLElement>('[data-feed]');
if (feed) initFeed(feed);

function initFeed(feed: HTMLElement): void {
  const context = new URLSearchParams((feed.dataset['context'] ?? '').replace(/^\?/, ''));
  const total = Number(feed.dataset['total'] ?? '0');
  const followUrl = feed.dataset['followUrl'] !== 'false';
  // With the feed running, the no-JavaScript pager is not needed.
  document.querySelectorAll<HTMLElement>('[data-feed-pager]').forEach((p) => (p.hidden = true));
  let first = Number(feed.dataset['position'] ?? '0'); // list offset of the first loaded article
  // List offset of the last loaded article (a list page starts with several).
  let last = first + Math.max(feed.querySelectorAll(':scope > article[data-item]').length - 1, 0);
  let loading: Promise<void> | null = null;
  let current: HTMLElement | null = feed.querySelector('article[data-item]');
  const siteTitle = document.title.split(' · ').slice(1).join(' · ');

  const controls = document.querySelector<HTMLElement>('[data-feed-controls]');
  const prevLink = controls?.querySelector<HTMLAnchorElement>('[data-feed-prev]') ?? null;
  const nextLink = controls?.querySelector<HTMLAnchorElement>('[data-feed-next]') ?? null;
  const posLabel = controls?.querySelector<HTMLElement>('[data-feed-pos]') ?? null;

  const articles = () =>
    Array.from(feed.querySelectorAll<HTMLElement>(':scope > article[data-item]'));
  const offsetOf = (a: HTMLElement) => first + articles().indexOf(a);

  async function fetchItems(offset: number, limit: number): Promise<HTMLElement[]> {
    const params = new URLSearchParams(context);
    params.set('offset', String(offset));
    params.set('limit', String(limit));
    try {
      const res = await fetch(`/feed?${params.toString()}`, { headers: { accept: 'text/html' } });
      if (!res.ok) return [];
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      return Array.from(doc.querySelectorAll<HTMLElement>('article[data-item]')).map(
        (a) => document.importNode(a, true) as HTMLElement,
      );
    } catch {
      return [];
    }
  }

  function adopt(nodes: HTMLElement[]): void {
    for (const a of nodes) {
      a.querySelectorAll<HTMLElement>('[data-carousel]').forEach(initCarousel);
      observer.observe(a);
    }
  }

  function loadNext(): Promise<void> {
    if (loading || last + 1 >= total) return loading ?? Promise.resolve();
    loading = (async () => {
      const nodes = await fetchItems(last + 1, 2);
      for (const a of nodes) feed.appendChild(a);
      last += nodes.length;
      adopt(nodes);
      updateControls();
    })().finally(() => {
      loading = null;
    });
    return loading;
  }

  function loadPrev(): Promise<void> {
    if (loading || first <= 0) return loading ?? Promise.resolve();
    loading = (async () => {
      const from = Math.max(first - 2, 0);
      const nodes = await fetchItems(from, first - from);
      const anchor = feed.firstElementChild as HTMLElement | null;
      const before = anchor?.getBoundingClientRect().top ?? 0;
      for (const a of nodes.reverse()) feed.insertBefore(a, feed.firstChild);
      // Keep what the visitor is looking at in place.
      const after = anchor?.getBoundingClientRect().top ?? 0;
      window.scrollBy(0, after - before);
      first -= nodes.length;
      adopt(nodes);
      updateControls();
    })().finally(() => {
      loading = null;
    });
    return loading;
  }

  function updateControls(): void {
    if (!current) return;
    const list = articles();
    const i = list.indexOf(current);
    const offset = first + i;
    if (posLabel) posLabel.textContent = `${offset + 1} / ${total}`;
    const before = list[i - 1];
    const after = list[i + 1];
    if (prevLink) {
      prevLink.hidden = offset <= 0;
      if (before?.dataset['url']) prevLink.href = before.dataset['url'];
    }
    if (nextLink) {
      nextLink.hidden = offset >= total - 1;
      if (after?.dataset['url']) nextLink.href = after.dataset['url'];
    }
  }

  function setCurrent(a: HTMLElement): void {
    if (a === current) return;
    current = a;
    // On an item page the address bar follows the item on screen; a list
    // shown as a feed keeps its own address (each title links to its item).
    if (followUrl) {
      const url = a.dataset['url'];
      if (url) history.replaceState(history.state, '', url);
      const title = a.dataset['title'];
      if (title) document.title = siteTitle ? `${title} · ${siteTitle}` : title;
    }
    updateControls();
    // Keep two items ready ahead (PUB-05).
    if (offsetOf(a) + 2 > last) void loadNext();
  }

  // The article crossing the middle of the screen is the current one.
  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) setCurrent(e.target as HTMLElement);
    },
    { rootMargin: '-45% 0px -45% 0px' },
  );
  articles().forEach((a) => observer.observe(a));

  async function go(delta: 1 | -1): Promise<void> {
    if (!current) return;
    let list = articles();
    let target = list[list.indexOf(current) + delta];
    if (!target) {
      await (delta > 0 ? loadNext() : loadPrev());
      list = articles();
      target = list[list.indexOf(current) + delta];
    }
    if (!target) return;
    target.scrollIntoView({ behavior, block: 'start' });
    const heading = target.querySelector<HTMLElement>('.item-title');
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }

  prevLink?.addEventListener('click', (e) => {
    e.preventDefault();
    void go(-1);
  });
  nextLink?.addEventListener('click', (e) => {
    e.preventDefault();
    void go(1);
  });

  document.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName))) return;
    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      void go(1);
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      void go(-1);
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && current) {
      const carousel = current.querySelector('[data-carousel]');
      const move = carousel ? carousels.get(carousel) : undefined;
      if (move) {
        e.preventDefault();
        move(e.key === 'ArrowLeft' ? -1 : 1);
      }
    }
  });

  // Scrolling up to the top loads the items before this one.
  let lastY = window.scrollY;
  window.addEventListener(
    'scroll',
    () => {
      const y = window.scrollY;
      if (y < lastY && y < 300 && first > 0) void loadPrev();
      lastY = y;
    },
    { passive: true },
  );

  updateControls();
  void loadNext();
}
