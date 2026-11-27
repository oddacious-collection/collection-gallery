/**
 * Privacy-leak crawler (TST-02). Starting from the home page it fetches
 * every public page it can reach (links, images, srcset, Open Graph URLs),
 * every list page and feed fragment, and a set of searches, and asserts:
 *
 * - no response contains any forbidden string (admin-only markers, hidden
 *   items' text, private storage keys, internal IDs), in HTML, text, or the
 *   bytes of photo files;
 * - every "must be 404" URL answers 404 with exactly the body of an unknown
 *   page (PUB-15: no existence leak), and every "must be 200" URL works;
 * - no response sets a cookie (INV-3).
 *
 * Reports never print forbidden strings or keys taken from real data: only
 * labels (e.g. "private media key #3"), so CI logs leak nothing either.
 */

export interface Forbidden {
  /** What it is, safe to print. */
  label: string;
  /** The exact text that must never appear (matched case-insensitively unless caseSensitive). */
  value: string;
  /** For short markers that random lowercase keys could contain by chance. */
  caseSensitive?: boolean;
}

export interface CrawlOptions {
  base: string;
  headers?: Record<string, string>;
  forbidden: Forbidden[];
  /** Paths that must answer the standard 404 (labels are safe to print). */
  must404: Array<{ label: string; path: string }>;
  /** Paths that must answer 200. */
  must200: string[];
  /** Searches to run (visitor words). */
  searches: string[];
  maxRequests?: number;
  log?: (line: string) => void;
}

export interface CrawlResult {
  requests: number;
  pages: number;
  files: number;
  failures: string[];
}

/** Shorter markers are checked in page text only (see `found`). */
const MIN_OPAQUE_MARKER = 8;

const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript)|image\/svg)/;

function linksIn(html: string): string[] {
  const out: string[] = [];
  // data-video/data-captions: the files the video player loads (PUB-06).
  const attr = /\b(?:href|src|content|action|data-video|data-captions)\s*=\s*"([^"]{1,2000})"/g;
  for (const m of html.matchAll(attr)) if (m[1]) out.push(m[1]);
  const srcset = /\bsrcset\s*=\s*"([^"]{1,8000})"/g;
  for (const m of html.matchAll(srcset)) {
    for (const part of (m[1] ?? '').split(',')) {
      const url = part.trim().split(/\s+/)[0];
      if (url) out.push(url);
    }
  }
  return out.map((u) => u.replace(/&amp;/g, '&'));
}

export async function crawl(opts: CrawlOptions): Promise<CrawlResult> {
  const base = new URL(opts.base);
  const log = opts.log ?? (() => {});
  const max = opts.maxRequests ?? 3000;
  const failures: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [];
  let requests = 0;
  let pages = 0;
  let files = 0;
  const needles = opts.forbidden.map((f) => ({ ...f, lower: f.value.toLowerCase() }));

  const fail = (msg: string) => {
    failures.push(msg);
    log(`FAIL ${msg}`);
  };

  const get = async (path: string) => {
    requests++;
    const once = () =>
      fetch(new URL(path, base), {
        headers: { ...opts.headers, accept: '*/*' },
        redirect: 'manual',
      });
    let res = await once();
    if (res.status === 429) {
      // Search is rate-limited per minute (D-53); wait the window out once.
      log(`rate-limited; waiting 61 s before retrying a search`);
      await new Promise((r) => setTimeout(r, 61_000));
      requests++;
      res = await once();
    }
    const type = res.headers.get('content-type') ?? '';
    const buf = new Uint8Array(await res.arrayBuffer());
    // latin1 keeps every byte, so markers hidden in binary files are found too.
    const text = TEXT_TYPES.test(type)
      ? new TextDecoder().decode(buf)
      : new TextDecoder('latin1').decode(buf);
    return { res, type, text };
  };

  /**
   * Markers present in `text`. Short markers (under 8 characters, like a
   * 3-letter currency) are only looked for in page text: photo bytes and
   * header tokens are random enough to contain them by chance.
   */
  const found = (text: string, opaque = false) =>
    needles.filter((n) => {
      if (opaque && n.value.length < MIN_OPAQUE_MARKER) return false;
      return n.caseSensitive ? text.includes(n.value) : text.toLowerCase().includes(n.lower);
    });

  /**
   * The visitor's own search words are shown back to them (the search box,
   * "Search: …" links, ?q= in item links); that echo isn't a leak. Remove it
   * in every form it appears in before scanning.
   */
  const withoutEcho = (path: string, text: string): string => {
    const q = new URL(path, base).searchParams.get('q');
    if (!q) return text;
    const forms = new Set([
      q,
      q.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      encodeURIComponent(q),
      new URLSearchParams({ q }).toString().slice(2),
    ]);
    let out = text;
    for (const f of forms) if (f) out = out.split(f).join('');
    return out;
  };

  const scan = (where: string, res: Response, text: string, path = where) => {
    if (res.headers.get('set-cookie')) fail(`${where}: sets a cookie`);
    const binary = !TEXT_TYPES.test(res.headers.get('content-type') ?? '');
    for (const n of found(withoutEcho(path, text), binary)) fail(`${where}: contains ${n.label}`);
    for (const [name, value] of res.headers) {
      for (const n of found(withoutEcho(path, value), true))
        fail(`${where}: header ${name} contains ${n.label}`);
    }
  };

  const enqueue = (raw: string) => {
    let url: URL;
    try {
      url = new URL(raw, base);
    } catch {
      return;
    }
    if (url.origin !== base.origin) return;
    // Feed views of searches show the same items the feed fragments cover.
    if (url.pathname === '/search' && url.searchParams.has('view')) return;
    url.hash = '';
    const key = url.pathname + url.search;
    if (seen.has(key)) return;
    seen.add(key);
    queue.push(key);
  };

  // The reference "not found" every hidden thing must match exactly.
  const reference = await get('/leak-suite-unknown-page');
  if (reference.res.status !== 404) fail(`unknown page answered ${reference.res.status}, not 404`);

  for (const p of [
    '/',
    '/items',
    '/items?view=grid',
    '/collections',
    '/search',
    '/robots.txt',
    ...opts.must200,
  ]) {
    enqueue(p);
  }
  for (const q of opts.searches) enqueue(`/search?q=${encodeURIComponent(q)}`);

  const feedContexts = new Set<string>(['']);
  while (queue.length > 0 && requests < max) {
    const path = queue.shift() as string;
    const { res, type, text } = await get(path);
    const where = path.length > 120 ? `${path.slice(0, 117)}...` : path;
    scan(where, res, text, path);
    if (path.startsWith('/media/')) {
      files++;
      continue;
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (loc) enqueue(loc);
      continue;
    }
    if (res.status === 429) {
      // Search rate limit (D-53): the page is still scanned; just don't retry.
      continue;
    }
    if (!type.startsWith('text/html')) continue;
    pages++;
    for (const link of linksIn(text)) enqueue(link);
    // Every list this page belongs to gets its feed fragments crawled too.
    const u = new URL(path, base);
    if (u.pathname.startsWith('/category/'))
      feedContexts.add(`in=${encodeURIComponent(u.pathname.slice(10))}`);
    if (u.pathname === '/search' && u.searchParams.get('q')) {
      feedContexts.add(`q=${encodeURIComponent(u.searchParams.get('q') ?? '')}`);
    }
  }
  for (const ctx of feedContexts) {
    for (const sub of ctx.startsWith('in=') ? ['', '&sub=0'] : ['']) {
      for (let offset = 0; offset < 500 && requests < max; offset += 5) {
        const path = `/feed?${ctx}${sub}${ctx ? '&' : ''}offset=${offset}&limit=5`;
        const { res, text } = await get(path);
        scan(path, res, text);
        for (const link of linksIn(text)) enqueue(link);
        if (!text.includes('<article')) break;
      }
    }
  }
  // Links found in feed fragments (more items, photos).
  while (queue.length > 0 && requests < max) {
    const path = queue.shift() as string;
    const { res, text } = await get(path);
    scan(path, res, text);
    if (path.startsWith('/media/')) files++;
    else pages++;
  }
  if (requests >= max) fail(`stopped at ${max} requests; raise maxRequests`);

  for (const m of opts.must404) {
    const { res, text } = await get(m.path);
    scan(m.label, res, text);
    if (res.status !== 404) fail(`${m.label}: answered ${res.status}, expected 404`);
    else if (!m.path.startsWith('/media/') && text !== reference.text) {
      fail(`${m.label}: 404 body differs from an unknown page`);
    }
  }
  for (const path of opts.must200) {
    const { res } = await get(path);
    if (res.status !== 200) fail(`${path}: answered ${res.status}, expected 200`);
  }
  return { requests, pages, files, failures };
}
