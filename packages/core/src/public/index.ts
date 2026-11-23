/**
 * The public data-access layer and request pipeline (INV-1, ARC-01, ARC-02).
 *
 * This is the ONLY core module the public Worker may import besides config,
 * headers and errors (enforced by ESLint and `npm run check:bundle`). Every
 * query here selects allowlisted public fields from public rows only.
 */
import { inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import {
  ConfigError,
  PublicConfigSchema,
  isLocalHostname,
  loadConfig,
  type PublicConfig,
} from '../config.ts';
import { errorResponse, logEvent } from '../errors.ts';
import { withSecurityHeaders } from '../headers.ts';
import { settings } from '../db/schema.ts';

// ---------------------------------------------------------------- data access

/** Settings keys that may appear on public pages. Everything else is admin-only. */
export const PUBLIC_SETTING_KEYS = ['owner_name', 'default_license'] as const;
export type PublicSettingKey = (typeof PUBLIC_SETTING_KEYS)[number];
export type PublicSettings = Partial<Record<PublicSettingKey, string>>;

export async function getPublicSettings(db: D1Database): Promise<PublicSettings> {
  const rows = await drizzle(db)
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, [...PUBLIC_SETTING_KEYS]));
  const out: PublicSettings = {};
  for (const row of rows) {
    if ((PUBLIC_SETTING_KEYS as readonly string[]).includes(row.key)) {
      out[row.key as PublicSettingKey] = row.value;
    }
  }
  return out;
}

// ----------------------------------------------------------- request pipeline

export type FetchHandler<Env> = (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) => Promise<Response>;

/** M0 public routes are read-only. Likes, beacons and contact add POST later. */
const ALLOWED_METHODS = new Set(['GET', 'HEAD']);

export interface PublicPipelineOptions {
  /**
   * Running under `astro dev`. Only honoured when the environment is `local`
   * AND the request is for a loopback host, so a development build that was
   * deployed by mistake still sends the enforced CSP.
   */
  devServer?: boolean;
}

export function createPublicPipeline<Env extends object>(
  app: FetchHandler<Env>,
  options: PublicPipelineOptions = {},
): FetchHandler<Env> {
  return async (request, env, ctx) => {
    let config: PublicConfig;
    try {
      config = loadConfig(PublicConfigSchema, env);
    } catch (err) {
      const fields = err instanceof ConfigError ? err.fields.join(',') : 'unknown';
      logEvent('error', 'config_invalid', { worker: 'public', fields });
      return withSecurityHeaders(errorResponse(500), { host: 'public', environment: 'production' });
    }
    const devServer =
      options.devServer === true &&
      config.ENVIRONMENT === 'local' &&
      isLocalHostname(new URL(request.url).hostname);
    const headerOpts = {
      host: 'public',
      environment: config.ENVIRONMENT,
      ...(devServer ? { devServer: true } : {}),
    } as const;

    if (!ALLOWED_METHODS.has(request.method)) {
      return withSecurityHeaders(errorResponse(405, { Allow: 'GET, HEAD' }), headerOpts);
    }
    try {
      return withSecurityHeaders(await app(request, env, ctx), headerOpts);
    } catch {
      logEvent('error', 'public_unhandled_error', { method: request.method });
      return withSecurityHeaders(errorResponse(500), headerOpts);
    }
  };
}
