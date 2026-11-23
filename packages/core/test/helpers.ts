/** Test helpers: a local Access-like issuer with its own RSA key pair. */
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';

export const TEAM_DOMAIN = 'https://testteam.cloudflareaccess.com';
export const AUD = 'a'.repeat(64);
export const ADMIN_EMAIL = 'owner@example.test';
export const ADMIN_ORIGIN = 'https://admin.example.test';
export const PUBLIC_ORIGIN = 'https://example.test';

export interface TestIssuer {
  keys: JWTVerifyGetKey;
  privateKey: CryptoKey;
  kid: string;
  sign(claims?: JWTPayload, opts?: SignOptions): Promise<string>;
}

export interface SignOptions {
  issuer?: string;
  audience?: string;
  expiresIn?: string | number;
  notBefore?: string | number;
  /** `iat` in seconds since the epoch (default: now). */
  issuedAt?: number;
  key?: CryptoKey;
  omitExp?: boolean;
}

export async function createIssuer(kid = 'test-key-1'): Promise<TestIssuer> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  const keys = createLocalJWKSet({ keys: [jwk] });
  return {
    keys,
    privateKey,
    kid,
    async sign(claims = { email: ADMIN_EMAIL }, opts = {}) {
      let jwt = new SignJWT({ type: 'app', ...claims })
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuer(opts.issuer ?? TEAM_DOMAIN)
        .setAudience(opts.audience ?? AUD)
        .setIssuedAt(opts.issuedAt)
        .setSubject('user-123');
      if (!opts.omitExp) jwt = jwt.setExpirationTime(opts.expiresIn ?? '10m');
      if (opts.notBefore !== undefined) jwt = jwt.setNotBefore(opts.notBefore);
      return jwt.sign(opts.key ?? privateKey);
    },
  };
}

export function adminEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ENVIRONMENT: 'staging',
    ADMIN_ORIGIN,
    PUBLIC_ORIGIN,
    OWNER_NAME: 'Test Owner',
    ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    ACCESS_AUD: AUD,
    ADMIN_EMAIL,
    ...overrides,
  };
}

export function publicEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ENVIRONMENT: 'staging', PUBLIC_ORIGIN, OWNER_NAME: 'Test Owner', ...overrides };
}

function base64url(input: string): string {
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** An unsigned `alg: none` token carrying otherwise-valid claims. */
export function unsignedToken(claims: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const body = base64url(
    JSON.stringify({
      iss: TEAM_DOMAIN,
      aud: AUD,
      email: ADMIN_EMAIL,
      iat: now,
      exp: now + 600,
      ...claims,
    }),
  );
  return `${header}.${body}.`;
}
