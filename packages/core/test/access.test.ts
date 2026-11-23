/**
 * TST-03 / SEC-03 — Access JWT validation. AC: requests with a missing,
 * expired, wrong-aud or wrong-email token are rejected; so is anything else
 * that is not a genuine, current token for the admin.
 */
import { SignJWT, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { verifyAccessRequest, type AccessVerifyOptions } from '../src/admin/access.ts';
import {
  ADMIN_EMAIL,
  AUD,
  TEAM_DOMAIN,
  createIssuer,
  unsignedToken,
  type TestIssuer,
} from './helpers.ts';

let issuer: TestIssuer;
let opts: AccessVerifyOptions;

beforeAll(async () => {
  issuer = await createIssuer();
  opts = { teamDomain: TEAM_DOMAIN, audience: AUD, adminEmail: ADMIN_EMAIL, keys: issuer.keys };
});

function req(token?: string): Request {
  const headers = new Headers();
  if (token !== undefined) headers.set('Cf-Access-Jwt-Assertion', token);
  return new Request('https://admin.example.test/', { headers });
}

describe('verifyAccessRequest', () => {
  it('accepts a valid token for the admin email', async () => {
    const result = await verifyAccessRequest(req(await issuer.sign()), opts);
    expect(result).toEqual({ ok: true, email: ADMIN_EMAIL });
  });

  it('compares the email case-insensitively', async () => {
    const token = await issuer.sign({ email: ' Owner@Example.TEST ' });
    expect((await verifyAccessRequest(req(token), opts)).ok).toBe(true);
  });

  const rejections: Array<[string, () => Promise<string | undefined>, string]> = [
    ['missing header', async () => undefined, 'missing'],
    ['empty header', async () => '', 'missing'],
    ['garbage', async () => 'not-a-jwt', 'malformed'],
    ['oversized token', async () => `${'a'.repeat(9000)}.b.c`, 'malformed'],
    [
      'expired',
      async () => issuer.sign(undefined, { expiresIn: Math.floor(Date.now() / 1000) - 60 }),
      'invalid',
    ],
    ['not yet valid', async () => issuer.sign(undefined, { notBefore: '5m' }), 'invalid'],
    [
      'older than 24 h (SEC-02), though not expired',
      async () => issuer.sign(undefined, { issuedAt: Math.floor(Date.now() / 1000) - 25 * 3600 }),
      'invalid',
    ],
    [
      'team-wide org token, not an app token',
      async () => issuer.sign({ email: ADMIN_EMAIL, type: 'org' }),
      'invalid',
    ],
    ['no type claim', async () => issuer.sign({ email: ADMIN_EMAIL, type: undefined }), 'invalid'],
    ['no exp claim', async () => issuer.sign(undefined, { omitExp: true }), 'invalid'],
    ['wrong audience', async () => issuer.sign(undefined, { audience: 'b'.repeat(64) }), 'invalid'],
    [
      'wrong issuer',
      async () => issuer.sign(undefined, { issuer: 'https://evil.cloudflareaccess.com' }),
      'invalid',
    ],
    ['wrong email', async () => issuer.sign({ email: 'someone@example.test' }), 'wrong_identity'],
    [
      'no email (e.g. service token)',
      async () => issuer.sign({ common_name: 'ci.access' }),
      'wrong_identity',
    ],
    ['non-string email', async () => issuer.sign({ email: [ADMIN_EMAIL] }), 'wrong_identity'],
    ['alg none', async () => unsignedToken(), 'invalid'],
    [
      'signed by an unknown key with the same kid',
      async () => {
        const { privateKey } = await generateKeyPair('RS256');
        return issuer.sign(undefined, { key: privateKey });
      },
      'invalid',
    ],
    [
      'HS256 (algorithm confusion)',
      async () =>
        new SignJWT({ email: ADMIN_EMAIL })
          .setProtectedHeader({ alg: 'HS256', kid: issuer.kid })
          .setIssuer(TEAM_DOMAIN)
          .setAudience(AUD)
          .setIssuedAt()
          .setExpirationTime('10m')
          .sign(new TextEncoder().encode('x'.repeat(32))),
      'invalid',
    ],
    [
      'tampered payload',
      async () => {
        const [h, , s] = (await issuer.sign()).split('.');
        const forged = btoa(
          JSON.stringify({
            email: ADMIN_EMAIL,
            iss: TEAM_DOMAIN,
            aud: AUD,
            exp: 9999999999,
            iat: 1,
          }),
        )
          .replace(/=+$/, '')
          .replace(/\+/g, '-')
          .replace(/\//g, '_');
        return `${h}.${forged}.${s}`;
      },
      'invalid',
    ],
  ];

  it.each(rejections)('rejects: %s', async (_name, makeToken, reason) => {
    const result = await verifyAccessRequest(req(await makeToken()), opts);
    expect(result).toEqual({ ok: false, reason });
  });

  it('fails closed when the key set cannot be fetched', async () => {
    const token = await issuer.sign();
    const result = await verifyAccessRequest(req(token), {
      ...opts,
      keys: async () => {
        throw new Error('network down');
      },
    });
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });
});
