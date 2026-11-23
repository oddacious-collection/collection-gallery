/**
 * Security headers for every host and route type (SEC-07, SEC-08, TST-04).
 *
 * One source of truth: the Workers apply these to dynamic responses, and
 * `scripts/generate-headers.ts` writes the same values into the static-asset
 * `_headers` file. Never loosen a directive here to make something work —
 * find another way or ask the owner (CLAUDE.md invariant 4).
 */
import type { EnvironmentName } from './config.ts';

export type HostKind = 'public' | 'admin';

export interface HeaderOptions {
  host: HostKind;
  environment: EnvironmentName;
  /**
   * Development server only (`astro dev`, which injects inline styles and
   * scripts). The CSP is sent as Report-Only so violations still show in the
   * console. Builds and deployments never set this.
   */
  devServer?: boolean;
}

export const HSTS_VALUE = 'max-age=63072000; includeSubDomains';

/** Features neither host uses. Only widely recognised feature names are listed. */
const DENIED_FEATURES = [
  'accelerometer',
  'browsing-topics',
  'display-capture',
  'encrypted-media',
  'geolocation',
  'gyroscope',
  'hid',
  'idle-detection',
  'magnetometer',
  'microphone',
  'midi',
  'payment',
  'publickey-credentials-get',
  'screen-wake-lock',
  'serial',
  'usb',
  'xr-spatial-tracking',
] as const;

export function permissionsPolicy(host: HostKind): string {
  // autoplay: muted feed video (PUB-06); fullscreen: slideshow (PUB-11).
  // camera (admin only): photographing items / barcode scan (ADM-01, ADM-14).
  const allowSelf =
    host === 'admin'
      ? ['autoplay', 'camera', 'fullscreen', 'picture-in-picture']
      : ['autoplay', 'fullscreen', 'picture-in-picture'];
  const denied: readonly string[] =
    host === 'admin' ? DENIED_FEATURES : [...DENIED_FEATURES, 'camera'];
  return [...denied.map((f) => `${f}=()`), ...allowSelf.map((f) => `${f}=(self)`)].join(', ');
}

export function contentSecurityPolicy(opts: HeaderOptions): string {
  const directives: string[] = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "media-src 'self'",
    "manifest-src 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ];
  if (opts.host === 'admin') {
    directives.push("require-trusted-types-for 'script'", "trusted-types 'none'");
  }
  if (opts.environment !== 'local') {
    directives.push('upgrade-insecure-requests');
  }
  return directives.join('; ');
}

/** The full header set for a response from the given host. */
export function securityHeaders(opts: HeaderOptions): Record<string, string> {
  const headers: Record<string, string> = {
    [opts.devServer ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy']:
      contentSecurityPolicy(opts),
    'Strict-Transport-Security': HSTS_VALUE,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': permissionsPolicy(opts.host),
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Origin-Agent-Cluster': '?1',
  };
  // Staging and local must never be indexed; admin never, anywhere.
  if (opts.host === 'admin' || opts.environment !== 'production') {
    headers['X-Robots-Tag'] = 'noindex, nofollow, noarchive';
  }
  if (opts.host === 'admin') {
    headers['Cache-Control'] = 'no-store';
  }
  return headers;
}

/** Headers that must never leave a Worker. */
const STRIPPED_HEADERS = ['x-powered-by', 'server-timing'];

/**
 * Returns a copy of `response` with the security headers applied. Every
 * `Set-Cookie` from the app is removed on both hosts (INV-3 / SEC-08): public
 * sets no cookies at all, and on admin the only cookie is Access's own
 * `CF_Authorization`, which Cloudflare sets at the edge, not via the Worker.
 */
export function withSecurityHeaders(response: Response, opts: HeaderOptions): Response {
  // Responses from fetch() / ASSETS have immutable headers; rebuild.
  const out = new Response(response.body, response);
  for (const name of STRIPPED_HEADERS) out.headers.delete(name);
  out.headers.delete('set-cookie');
  for (const [name, value] of Object.entries(securityHeaders(opts))) {
    out.headers.set(name, value);
  }
  return out;
}

/**
 * Contents of a Workers Static Assets `_headers` file carrying the same
 * headers, for files served without invoking the Worker.
 */
export function staticHeadersFile(opts: HeaderOptions): string {
  const lines = ['/*'];
  for (const [name, value] of Object.entries(securityHeaders(opts))) {
    lines.push(`  ${name}: ${value}`);
  }
  // Astro's hashed build assets never change (content-addressed file names).
  lines.push('', '/_astro/*', '  Cache-Control: public, max-age=31536000, immutable');
  return `${lines.join('\n')}\n`;
}
