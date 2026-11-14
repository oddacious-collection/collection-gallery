/** SEC-05 — configuration is validated and fails closed. */
import { describe, expect, it } from 'vitest';
import { AdminConfigSchema } from '../src/admin/config.ts';
import { ConfigError, PublicConfigSchema, loadConfig } from '../src/config.ts';
import { adminEnv, publicEnv } from './helpers.ts';

describe('config', () => {
  it('accepts valid admin config and normalises the email', () => {
    const config = loadConfig(AdminConfigSchema, adminEnv({ ADMIN_EMAIL: ' Owner@Example.TEST ' }));
    expect(config.ADMIN_EMAIL).toBe('owner@example.test');
  });

  it.each([
    ['missing email', { ADMIN_EMAIL: undefined }],
    ['bad email', { ADMIN_EMAIL: 'not-an-email' }],
    ['non-Access team domain', { ACCESS_TEAM_DOMAIN: 'https://evil.example.com' }],
    ['http team domain', { ACCESS_TEAM_DOMAIN: 'http://team.cloudflareaccess.com' }],
    ['short AUD', { ACCESS_AUD: 'abc' }],
    ['origin with path', { ADMIN_ORIGIN: 'https://admin.example.test/x' }],
    ['http origin in staging', { ADMIN_ORIGIN: 'http://admin.example.test' }],
    [
      'localhost origin in production',
      { ENVIRONMENT: 'production', ADMIN_ORIGIN: 'http://localhost:4322' },
    ],
    ['non-local origin labelled local', { ENVIRONMENT: 'local' }],
    ['unknown environment', { ENVIRONMENT: 'dev' }],
  ])('rejects admin config with %s', (_name, overrides) => {
    expect(() => loadConfig(AdminConfigSchema, adminEnv(overrides))).toThrow(ConfigError);
  });

  it('does not put secret values in the error message', () => {
    try {
      loadConfig(AdminConfigSchema, adminEnv({ ADMIN_EMAIL: 'secret-value-not-an-email' }));
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain('secret-value');
      expect((err as ConfigError).fields).toEqual(['ADMIN_EMAIL']);
    }
  });

  it('accepts local origins in the local environment', () => {
    const config = loadConfig(
      PublicConfigSchema,
      publicEnv({ ENVIRONMENT: 'local', PUBLIC_ORIGIN: 'http://localhost:4321' }),
    );
    expect(config.ENVIRONMENT).toBe('local');
  });
});
