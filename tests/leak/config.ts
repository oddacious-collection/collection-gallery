/**
 * What the leak crawl checks for the sentinel data in sentinels.sql (TST-02).
 * Phase A: toggle ALPHA public, BETA private; phase B: the reverse.
 */
import type { CrawlOptions, Forbidden } from './crawl.ts';

export type Phase = 'a' | 'b';

/** Markers that must never appear on any public surface, in either phase. */
export const SQL_FORBIDDEN: Forbidden[] = [
  { label: 'a SENTINEL marker', value: 'SENTINEL-' },
  { label: 'a sentinel storage key', value: '0sentkey' },
  { label: 'a sentinel internal ID', value: '01SENT', caseSensitive: true },
  { label: 'the sentinel purchase price', value: '987654321' },
  { label: 'the sentinel price as money', value: '9,876,543.21' },
  { label: 'the sentinel valuation', value: '987654322' },
  { label: 'the sentinel currency', value: 'ZQX', caseSensitive: true },
  { label: 'a sentinel admin date', value: '1901-02-03' },
  { label: 'a sentinel email', value: '@example.invalid' },
  { label: 'the sentinel admin setting key', value: 'sentinel_admin_setting' },
  { label: 'the sentinel admin field key', value: 'sentinel_admin_field' },
  { label: 'a sentinel referrer', value: 'sentinel-sql-referrer' },
];

const TOGGLE = {
  alpha: { title: 'LEAKTOGGLE-SQL-ALPHA', slug: 'leak-test-toggle-alpha' },
  beta: { title: 'LEAKTOGGLE-SQL-BETA', slug: 'leak-test-toggle-beta' },
};

export function phaseChecks(
  phase: Phase,
): Pick<CrawlOptions, 'forbidden' | 'must404' | 'must200' | 'searches'> {
  const hidden = phase === 'a' ? TOGGLE.beta : TOGGLE.alpha;
  const shown = phase === 'a' ? TOGGLE.alpha : TOGGLE.beta;
  return {
    forbidden: [
      ...SQL_FORBIDDEN,
      { label: `the private toggle item's title (phase ${phase})`, value: hidden.title },
    ],
    must404: [
      ...['draft', 'private', 'wishlist', 'trashed'].map((k) => ({
        label: `sentinel ${k} item page`,
        path: `/item/sentinel-sql-${k}`,
      })),
      { label: 'sentinel draft photo view', path: '/item/sentinel-sql-draft/photo/1' },
      { label: 'sentinel private photo view', path: '/item/sentinel-sql-private/photo/1' },
      { label: 'old slug of a private item', path: '/item/sentinel-sql-private-old-slug' },
      { label: 'category with only hidden items', path: '/category/sentinel-sql-hidden-category' },
      { label: `private toggle item page (phase ${phase})`, path: `/item/${hidden.slug}` },
      ...['a1', 'a2', 'a3', 'd1', 'e1', 'e2'].map((k) => ({
        label: `sentinel private file ${k}`,
        path: `/media/0sentkey0000000000000000${k}`,
      })),
    ],
    must200: [
      '/item/leak-test-public-item',
      '/category/leak-test',
      `/item/${shown.slug}`,
      '/search?q=leak',
    ],
    searches: [
      'sentinel',
      'SENTINEL-SQL-PRIVATE-TITLE',
      'private',
      'draft',
      'wishlist',
      'trashed',
      'hidden',
      'leaktoggle',
      'leak test',
      '987654321',
      'ZQX',
      'counterparty',
      'grantee',
      'inbox',
    ],
  };
}
