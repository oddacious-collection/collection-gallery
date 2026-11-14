/**
 * DEV SERVER ONLY. There is no Cloudflare Access in front of `astro dev`, so
 * this pipeline skips JWT validation. It is referenced only behind
 * `import.meta.env.DEV`, which is `false` in every build, so it never ships;
 * `npm run check:bundle` fails if this marker appears in a build:
 * CG_DEV_ONLY_ACCESS_BYPASS
 *
 * As a second guard it refuses to serve unless the environment is `local`.
 */
import { AdminConfigSchema, type FetchHandler } from '@cg/core/admin';
import { loadConfig } from '@cg/core/config';
import { errorResponse } from '@cg/core/errors';
import { withSecurityHeaders } from '@cg/core/headers';

export function createDevPipeline<Env extends object>(app: FetchHandler<Env>): FetchHandler<Env> {
  return async (request, env, ctx) => {
    const opts = { host: 'admin', environment: 'local', devServer: true } as const;
    const config = loadConfig(AdminConfigSchema, env);
    if (config.ENVIRONMENT !== 'local') {
      console.error('CG_DEV_ONLY_ACCESS_BYPASS refused: environment is not local');
      return withSecurityHeaders(errorResponse(403), opts);
    }
    return withSecurityHeaders(await app(request, env, ctx), opts);
  };
}
