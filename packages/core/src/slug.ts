/**
 * URL slugs for items, categories and tags. Lower-case ASCII letters, digits
 * and single hyphens; accents are folded ("Bézier" → "bezier").
 */

export const SLUG_MAX_LENGTH = 80;
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugify(input: string, fallback = 'item'): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // combining marks left by NFKD
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, '');
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
    const candidate = base.slice(0, SLUG_MAX_LENGTH - suffix.length).replace(/-+$/g, '') + suffix;
    if (!(await isTaken(candidate))) return candidate;
  }
  throw new Error('uniqueSlug: no free slug');
}
