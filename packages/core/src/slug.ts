/**
 * URL slugs for items, categories and tags. Lower-case ASCII letters, digits
 * and single hyphens; accents are folded ("Bézier" → "bezier").
 *
 * No regular expression here backtracks: hyphens are trimmed with a linear
 * scan (a `-+$` pattern is polynomial on long runs of hyphens; CodeQL
 * js/polynomial-redos).
 */

export const SLUG_MAX_LENGTH = 80;
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** `s` without leading or trailing hyphens. */
function trimHyphens(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) === 45) start++;
  while (end > start && s.charCodeAt(end - 1) === 45) end--;
  return s.slice(start, end);
}

export function slugify(input: string, fallback = 'item'): string {
  const collapsed = input
    .normalize('NFKD')
    .replace(/\p{M}/gu, '') // combining marks left by NFKD (accents)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-');
  const slug = trimHyphens(trimHyphens(collapsed).slice(0, SLUG_MAX_LENGTH));
  return slug || fallback;
}

/**
 * The first of `base`, `base-2`, `base-3`, ... for which `isTaken` is false.
 * `isTaken` is asked about candidates in order; callers usually check the
 * database (including old slugs in `slug_redirects`).
 */
export async function uniqueSlug(
  base: string,
  isTaken: (candidate: string) => Promise<boolean>,
): Promise<string> {
  if (!(await isTaken(base))) return base;
  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`;
    const candidate = trimHyphens(base.slice(0, SLUG_MAX_LENGTH - suffix.length)) + suffix;
    if (!(await isTaken(candidate))) return candidate;
  }
  throw new Error('uniqueSlug: no free slug');
}
