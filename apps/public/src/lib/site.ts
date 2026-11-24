/** Site-wide values for public pages. */
import { env } from 'cloudflare:workers';
import { getPublicSettings } from '@cg/core/public';

/** Placeholder site title; becomes an admin setting with the static pages (M5). */
export const SITE_NAME = 'Collection Gallery';

/** The pen name (D-49): the settings value, else the configured default. */
export async function ownerName(): Promise<string> {
  const settings = await getPublicSettings(env.DB);
  return settings.owner_name ?? env.OWNER_NAME;
}

/** Absolute URL on the public origin (canonical links, Open Graph). */
export function absolute(path: string): string {
  return new URL(path, env.PUBLIC_ORIGIN).href;
}

export function formatDate(iso: string | null): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en', { dateStyle: 'long', timeZone: 'UTC' }).format(
    new Date(iso),
  );
}
