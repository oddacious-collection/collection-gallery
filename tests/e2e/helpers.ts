import { expect, type APIResponse } from '@playwright/test';
import { securityHeaders, type HostKind } from '../../packages/core/src/headers.ts';

export const PUBLIC = 'http://localhost:4321';
export const ADMIN = 'http://localhost:4322';

type HeaderSource = Pick<APIResponse, 'headers'>;

/** TST-04: every response carries the full security header set for its host. */
export function expectSecurityHeaders(res: HeaderSource, host: HostKind): void {
  const actual = res.headers();
  for (const [name, value] of Object.entries(securityHeaders({ host, environment: 'local' }))) {
    expect(actual[name.toLowerCase()], `${name} on ${host}`).toBe(value);
  }
}

/** INV-3 / SEC-08: the public host never sets cookies. */
export function expectNoCookies(res: HeaderSource): void {
  expect(res.headers()['set-cookie']).toBeUndefined();
}
