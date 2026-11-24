/**
 * DEV SERVER ONLY. There is no Cloudflare Access in front of `astro dev`, so
 * this pipeline skips JWT validation. It is referenced only behind
 * `import.meta.env.DEV`, which is `false` in every build, so it never ships;
 * `npm run check:bundle` fails if this marker appears in a build:
 * CG_DEV_ONLY_ACCESS_BYPASS
 *
 * As further guards it refuses to serve unless the environment is `local` AND
 * the request is for a loopback host (a deployed Worker never is).
 */
import { ACTOR_HEADER, AdminConfigSchema, type FetchHandler } from '@cg/core/admin';
import { isLocalHostname, loadConfig } from '@cg/core/config';
import { errorResponse } from '@cg/core/errors';
import { withSecurityHeaders } from '@cg/core/headers';

export function createDevPipeline<Env extends object>(app: FetchHandler<Env>): FetchHandler<Env> {
  return async (request, env, ctx) => {
    const opts = { host: 'admin', environment: 'local', devServer: true } as const;
    const config = loadConfig(AdminConfigSchema, env);
    if (config.ENVIRONMENT !== 'local' || !isLocalHostname(new URL(request.url).hostname)) {
      console.error('CG_DEV_ONLY_ACCESS_BYPASS refused: not a local environment and host');
      return withSecurityHeaders(errorResponse(403), opts);
    }
    // Same contract as the real pipeline: the app gets the (local) admin email.
    const forwarded = new Request(request);
    forwarded.headers.set(ACTOR_HEADER, config.ADMIN_EMAIL);
    return withSecurityHeaders(await app(forwarded, env, ctx), opts);
  };
}
