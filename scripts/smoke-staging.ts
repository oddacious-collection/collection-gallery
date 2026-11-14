/**
 * Post-deploy smoke test for staging (OPS-02, TST-03/04 against the real
 * Cloudflare setup). Runs in CI after `deploy:staging`.
 *
 * Required env: STAGING_PUBLIC_URL, STAGING_ADMIN_URL, CF_ACCESS_CLIENT_ID,
 * CF_ACCESS_CLIENT_SECRET (an Access service token allowed on the PUBLIC
 * staging app only).
 */
import { securityHeaders } from '../packages/core/src/headers.ts';

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

const publicUrl = env('STAGING_PUBLIC_URL').replace(/\/$/, '');
const adminUrl = env('STAGING_ADMIN_URL').replace(/\/$/, '');
const serviceToken = {
  'CF-Access-Client-Id': env('CF_ACCESS_CLIENT_ID'),
  'CF-Access-Client-Secret': env('CF_ACCESS_CLIENT_SECRET'),
};

const failures: string[] = [];
function check(ok: boolean, message: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures.push(message);
}

async function get(url: string, headers: Record<string, string> = {}, method = 'GET') {
  return fetch(url, { method, headers, redirect: 'manual' });
}

/** Access blocks with a redirect to the team login, or a 401/403. Never a 200. */
function isBlockedByAccess(res: Response): boolean {
  if (res.status === 401 || res.status === 403) return true;
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location') ?? '';
    try {
      return new URL(loc, 'https://x').hostname.endsWith('.cloudflareaccess.com');
    } catch {
      return false;
    }
  }
  return false;
}

// 1. Nothing on staging is reachable anonymously (OPS-01: staging entirely behind Access).
for (const [label, url] of [
  ['public /', `${publicUrl}/`],
  ['public /robots.txt', `${publicUrl}/robots.txt`],
  ['admin /', `${adminUrl}/`],
  ['admin /robots.txt', `${adminUrl}/robots.txt`],
] as const) {
  const res = await get(url);
  check(isBlockedByAccess(res), `anonymous ${label} is blocked by Access (got ${res.status})`);
}

// 2. The CI service token reaches the public staging site, with correct headers.
const home = await get(`${publicUrl}/`, serviceToken);
check(home.status === 200, `public / with service token → 200 (got ${home.status})`);
check((await home.text()).includes('Collection Gallery'), 'public / renders the hello-world page');
for (const [name, value] of Object.entries(
  securityHeaders({ host: 'public', environment: 'staging' }),
)) {
  check(home.headers.get(name) === value, `public / header ${name}`);
}
const appCookies = home.headers.getSetCookie().filter((c) => !c.startsWith('CF_Authorization='));
check(appCookies.length === 0, 'public / sets no cookies of its own (INV-3)');

const robots = await get(`${publicUrl}/robots.txt`, serviceToken);
check((await robots.text()).includes('Disallow: /'), 'staging robots.txt disallows crawling');

const post = await get(`${publicUrl}/`, serviceToken, 'POST');
check(post.status === 405 || post.status === 403, `public POST rejected (got ${post.status})`);

// 3. The service token must NOT open admin (policy is the owner's email only).
const adminWithToken = await get(`${adminUrl}/`, serviceToken);
check(
  adminWithToken.status !== 200,
  `admin / with service token is refused (got ${adminWithToken.status})`,
);

// 4. A forged JWT header is refused (SEC-03). Access itself blocks first; if it
//    ever stopped doing so, the Worker's own validation must still refuse.
const forged = await get(`${adminUrl}/`, { 'Cf-Access-Jwt-Assertion': 'a.b.c' });
check(forged.status !== 200, `admin / with forged JWT is refused (got ${forged.status})`);

if (failures.length > 0) {
  console.error(`\n${failures.length} smoke check(s) failed.`);
  process.exit(1);
}
console.log('\nStaging smoke test passed.');
