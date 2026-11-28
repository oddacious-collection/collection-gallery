/**
 * Admin Worker request pipeline. Every request — pages, API and static
 * assets — passes through here (the admin Worker runs with
 * `assets.run_worker_first: true`):
 *
 *   config check → Access JWT (SEC-03) → method/CSRF check (SEC-04)
 *   → app → security headers (SEC-07)
 *
 * Every step fails closed with a generic error (SEC-12).
 */
import { ConfigError, loadConfig } from '../config.ts';
import { AdminConfigSchema, type AdminConfig } from './config.ts';
import { errorResponse, logEvent } from '../errors.ts';
import { withSecurityHeaders } from '../headers.ts';
import { verifyAccessRequest, type AccessVerifyOptions } from './access.ts';

export { verifyAccessRequest, accessKeySet, ACCESS_JWT_HEADER } from './access.ts';
export { AdminConfigSchema, type AdminConfig } from './config.ts';
export type { AccessResult, AccessFailure, AccessVerifyOptions } from './access.ts';
export * from './items.ts';
export * from './categories.ts';
export * from './purge.ts';
export * from './media.ts';
export * from './captions.ts';
export * from './import.ts';
export * from './review.ts';
export { api, json, readJson, MAX_JSON_BYTES } from './http.ts';
export { DomainError, type DomainErrorCode } from './domain-error.ts';
export {
  ItemCreate,
  ItemUpdate,
  type ItemCreateInput,
  type ItemUpdateInput,
} from './validation.ts';

/**
 * Internal header carrying the verified owner email from the pipeline to the
 * app (for the audit log, SEC-13). The pipeline always overwrites it, so a
 * client-supplied value never reaches the app.
 */
export const ACTOR_HEADER = 'x-cg-actor';

/** The verified actor for an admin request (set by the pipeline). */
export function actorOf(request: Request): string {
  const actor = request.headers.get(ACTOR_HEADER);
  if (!actor) throw new Error('actorOf: request did not pass the admin pipeline');
  return actor;
}

/** Custom header that admin client code sends on every state-changing request. */
export const CSRF_HEADER = 'x-cg-request';
export const CSRF_HEADER_VALUE = '1';

const SAFE_METHODS = new Set(['GET', 'HEAD']);
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

export type FetchHandler<Env> = (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) => Promise<Response>;

export interface AdminPipelineOptions {
  /** Test seam: override JWT key resolution. Production uses the team JWKS. */
  keys?: AccessVerifyOptions['keys'];
}

/** SEC-04: state-changing requests must be same-origin and carry the custom header. */
export function checkCsrf(request: Request, adminOrigin: string): boolean {
  if (request.headers.get('origin') !== adminOrigin) return false;
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return false;
  return request.headers.get(CSRF_HEADER) === CSRF_HEADER_VALUE;
}

export function createAdminPipeline<Env extends object>(
  app: FetchHandler<Env>,
  options: AdminPipelineOptions = {},
): FetchHandler<Env> {
  return async (request, env, ctx) => {
    let config: AdminConfig;
    try {
      config = loadConfig(AdminConfigSchema, env);
    } catch (err) {
      const fields = err instanceof ConfigError ? err.fields.join(',') : 'unknown';
      logEvent('error', 'config_invalid', { worker: 'admin', fields });
      // Environment unknown: use the strictest (non-local) header set.
      return withSecurityHeaders(errorResponse(500), { host: 'admin', environment: 'production' });
    }
    const headerOpts = { host: 'admin', environment: config.ENVIRONMENT } as const;
    const deny = (status: 403 | 405, reason: string): Response => {
      logEvent('warn', 'admin_request_denied', { reason, method: request.method });
      return withSecurityHeaders(errorResponse(status), headerOpts);
    };

    const auth = await verifyAccessRequest(request, {
      teamDomain: config.ACCESS_TEAM_DOMAIN,
      audience: config.ACCESS_AUD,
      adminEmail: config.ADMIN_EMAIL,
      ...(options.keys ? { keys: options.keys } : {}),
    });
    if (!auth.ok) return deny(403, `access_${auth.reason}`);

    if (!ALLOWED_METHODS.has(request.method)) return deny(405, 'method');
    if (!SAFE_METHODS.has(request.method) && !checkCsrf(request, config.ADMIN_ORIGIN)) {
      return deny(403, 'csrf');
    }

    // Pass the verified identity on; never trust a client-supplied value.
    const forwarded = new Request(request);
    forwarded.headers.set(ACTOR_HEADER, auth.email);

    try {
      return withSecurityHeaders(await app(forwarded, env, ctx), headerOpts);
    } catch {
      logEvent('error', 'admin_unhandled_error', { method: request.method });
      return withSecurityHeaders(errorResponse(500), headerOpts);
    }
  };
}
