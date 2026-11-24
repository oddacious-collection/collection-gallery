/** Small display helpers for admin pages. */

/** "2026-11-23T19:04:05.123Z" → "2026-11-23 19:04 UTC" (empty for null). */
export function shortDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** Integer cents → "12.50" for an input field (empty for null). */
export function centsToInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '';
  return (cents / 100).toFixed(2);
}

export const STATUS_LABEL = { draft: 'Draft', public: 'Public', private: 'Private' } as const;

export const LICENSE_LABEL: Record<string, string> = {
  'cc-by': 'CC BY 4.0',
  'cc-by-nc': 'CC BY-NC 4.0',
  'cc-by-nc-sa': 'CC BY-NC-SA 4.0',
  'cc-by-nc-nd': 'CC BY-NC-ND 4.0',
  arr: 'All rights reserved',
};
