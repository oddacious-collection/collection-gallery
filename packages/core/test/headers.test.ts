/** TST-04 — the header policy itself (SEC-07). */
import { describe, expect, it } from 'vitest';
import {
  HSTS_VALUE,
  contentSecurityPolicy,
  securityHeaders,
  staticHeadersFile,
  type HeaderOptions,
} from '../src/headers.ts';

const cases: HeaderOptions[] = [
  { host: 'public', environment: 'production' },
  { host: 'public', environment: 'staging' },
  { host: 'admin', environment: 'production' },
  { host: 'admin', environment: 'staging' },
];

function directives(csp: string): Map<string, string> {
  return new Map(
    csp.split(';').map((d) => {
      const [name = '', ...rest] = d.trim().split(/\s+/);
      return [name, rest.join(' ')];
    }),
  );
}

describe.each(cases)('security headers for $host/$environment', (opts) => {
  const headers = securityHeaders(opts);
  const csp = directives(headers['Content-Security-Policy'] ?? '');

  it('has a strict CSP', () => {
    expect(csp.get('default-src')).toBe("'none'");
    expect(csp.get('script-src')).toBe(
      opts.host === 'admin' ? "'self' 'wasm-unsafe-eval'" : "'self'",
    );
    expect(csp.get('style-src')).toBe("'self'");
    expect(csp.get('object-src')).toBe("'none'");
    expect(csp.get('base-uri')).toBe("'none'");
    expect(csp.get('form-action')).toBe("'self'");
    expect(csp.get('frame-ancestors')).toBe("'none'");
    expect(csp.has('upgrade-insecure-requests')).toBe(true);
  });

  it('never allows unsafe sources', () => {
    const raw = headers['Content-Security-Policy'] ?? '';
    for (const bad of [
      "'unsafe-inline'",
      "'unsafe-eval'",
      "'unsafe-hashes'",
      'data:',
      'blob:',
      '*',
    ]) {
      expect(raw.split(/[\s;]+/)).not.toContain(bad);
    }
  });

  it('sets the other required headers', () => {
    expect(headers['Strict-Transport-Security']).toBe(HSTS_VALUE);
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(headers['Cross-Origin-Resource-Policy']).toBe('same-origin');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Permissions-Policy']).toContain('geolocation=()');
    expect(headers['Permissions-Policy']).toContain('microphone=()');
  });
});

describe('host differences', () => {
  it('enables Trusted Types on admin only', () => {
    expect(contentSecurityPolicy({ host: 'admin', environment: 'production' })).toContain(
      "require-trusted-types-for 'script'",
    );
    expect(contentSecurityPolicy({ host: 'public', environment: 'production' })).not.toContain(
      'trusted-types',
    );
  });

  it('allows WebAssembly compilation on admin only (D-44), never JavaScript eval', () => {
    const admin = contentSecurityPolicy({ host: 'admin', environment: 'production' });
    expect(admin).toContain("'wasm-unsafe-eval'");
    expect(admin.split(/[\s;]+/)).not.toContain("'unsafe-eval'");
    for (const environment of ['production', 'staging', 'local'] as const) {
      expect(contentSecurityPolicy({ host: 'public', environment })).not.toContain('wasm');
    }
  });

  it('allows the camera on admin only', () => {
    expect(
      securityHeaders({ host: 'admin', environment: 'production' })['Permissions-Policy'],
    ).toContain('camera=(self)');
    expect(
      securityHeaders({ host: 'public', environment: 'production' })['Permissions-Policy'],
    ).toContain('camera=()');
  });

  it('never indexes admin, staging or local; indexes public production', () => {
    expect(securityHeaders({ host: 'admin', environment: 'production' })['X-Robots-Tag']).toContain(
      'noindex',
    );
    expect(securityHeaders({ host: 'public', environment: 'staging' })['X-Robots-Tag']).toContain(
      'noindex',
    );
    expect(securityHeaders({ host: 'public', environment: 'local' })['X-Robots-Tag']).toContain(
      'noindex',
    );
    expect(
      securityHeaders({ host: 'public', environment: 'production' })['X-Robots-Tag'],
    ).toBeUndefined();
  });

  it('does not upgrade requests on plain-http local previews', () => {
    expect(contentSecurityPolicy({ host: 'public', environment: 'local' })).not.toContain(
      'upgrade-insecure-requests',
    );
  });

  it('uses Report-Only only for the dev server', () => {
    const dev = securityHeaders({ host: 'public', environment: 'local', devServer: true });
    expect(dev['Content-Security-Policy']).toBeUndefined();
    expect(dev['Content-Security-Policy-Report-Only']).toContain("default-src 'none'");
  });
});

describe('static _headers file', () => {
  it('carries the same headers for every path', () => {
    const file = staticHeadersFile({ host: 'public', environment: 'staging' });
    const lines = file.split('\n');
    expect(lines[0]).toBe('/*');
    for (const [name, value] of Object.entries(
      securityHeaders({ host: 'public', environment: 'staging' }),
    )) {
      expect(lines).toContain(`  ${name}: ${value}`);
    }
  });
});
