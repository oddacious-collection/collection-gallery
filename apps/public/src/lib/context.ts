/**
 * The list an item page belongs to (PUB-05), carried in the URL so it is
 * shareable and needs no storage (PRV-01):
 *   (none)            all public items, newest first
 *   ?in=<slug>        a category, subcategories included
 *   ?in=<slug>&sub=0  a category, items filed directly in it only
 *   ?q=<words>[&in=]  search results (optionally within a category)
 */
import type { ListContext } from '@cg/core/public';

export function contextFromUrl(url: URL): ListContext {
  const q = (url.searchParams.get('q') ?? '').trim();
  const cat = url.searchParams.get('in') ?? '';
  if (q) return cat ? { kind: 'search', q, category: cat } : { kind: 'search', q };
  if (cat) return { kind: 'category', slug: cat, descendants: url.searchParams.get('sub') !== '0' };
  return { kind: 'all' };
}

/** Query string (with leading "?", or "") that carries the context. */
export function contextQuery(ctx: ListContext): string {
  const p = new URLSearchParams();
  if (ctx.kind === 'search') {
    p.set('q', ctx.q);
    if (ctx.category) p.set('in', ctx.category);
  } else if (ctx.kind === 'category') {
    p.set('in', ctx.slug);
    if (!ctx.descendants) p.set('sub', '0');
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function itemHref(slug: string, ctx: ListContext): string {
  return `/item/${encodeURIComponent(slug)}${contextQuery(ctx)}`;
}

/** 1-based page number from `?page=`, clamped. */
export function pageFromUrl(url: URL, max = 1000): number {
  const n = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), max) : 1;
}

export const PAGE_SIZE = 24;

/** How a list is shown (PUB-02): the vertical feed or a grid of covers. */
export type ListView = 'feed' | 'grid';

export function viewFromUrl(url: URL, fallback: ListView): ListView {
  const v = url.searchParams.get('view');
  return v === 'feed' || v === 'grid' ? v : fallback;
}

/** Items per page in the feed layout (more load as you scroll). */
export const FEED_PAGE_SIZE = 6;
