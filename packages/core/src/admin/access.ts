/**
 * Cloudflare Access JWT validation for the admin Worker (SEC-03).
 *
 * Access sits in front of the admin host and enforces login, but the Worker
 * independently verifies the `Cf-Access-Jwt-Assertion` header on every request
 * (defence in depth): RS256 signature against the team's published keys,
 * issuer, audience, expiry, and that the email is the single admin email.
 * Any failure — including network errors fetching keys — denies.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';

/** Real Access tokens are ~1 KB; anything this big is not one. */
const MAX_TOKEN_LENGTH = 8192;

export type AccessFailure = 'missing' | 'malformed' | 'invalid' | 'wrong_identity';

export type AccessResult = { ok: true; email: string } | { ok: false; reason: AccessFailure };

export interface AccessVerifyOptions {
  /** e.g. https://myteam.cloudflareaccess.com (the token issuer). */
  teamDomain: string;
  /** The Access application's AUD tag. */
  audience: string;
  /** Normalised (trimmed, lower-case) admin email. */
  adminEmail: string;
  /** Key resolver; defaults to the team's remote JWKS. Tests inject a local one. */
  keys?: JWTVerifyGetKey;
}

const remoteKeySets = new Map<string, JWTVerifyGetKey>();

/** Per-isolate cached JWKS for a team domain (`/cdn-cgi/access/certs`). */
export function accessKeySet(teamDomain: string): JWTVerifyGetKey {
  let keys = remoteKeySets.get(teamDomain);
  if (!keys) {
    keys = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', teamDomain), {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });
    remoteKeySets.set(teamDomain, keys);
  }
  return keys;
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function verifyAccessRequest(
  request: Request,
  opts: AccessVerifyOptions,
): Promise<AccessResult> {
  const token = request.headers.get(ACCESS_JWT_HEADER);
  if (!token) return { ok: false, reason: 'missing' };
  if (token.length > MAX_TOKEN_LENGTH || token.split('.').length !== 3) {
    return { ok: false, reason: 'malformed' };
  }

  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, opts.keys ?? accessKeySet(opts.teamDomain), {
      algorithms: ['RS256'],
      issuer: opts.teamDomain,
      audience: opts.audience,
      requiredClaims: ['exp', 'iat'],
      clockTolerance: 5,
    }));
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  const email = payload['email'];
  if (typeof email !== 'string' || normaliseEmail(email) !== opts.adminEmail) {
    return { ok: false, reason: 'wrong_identity' };
  }
  return { ok: true, email: normaliseEmail(email) };
}
