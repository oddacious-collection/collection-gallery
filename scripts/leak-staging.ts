/**
 * Privacy-leak suite against real staging, after each deploy (TST-02, D-24).
 *
 *   1. make sure the sentinel data is on staging (tests/leak/sentinels.sql,
 *      idempotent; it stays there between runs);
 *   2. self-check, then crawl the public staging site (phase A);
 *   3. flip the two toggle items (toggle-b.sql) and crawl again (phase B);
 *   4. always flip them back.
 *
 * Besides the sentinels it checks staging's real private storage keys and
 * internal IDs (read from D1); reports print labels only, never values.
 *
 * Needs: STAGING_PUBLIC_URL, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET
 * (public-site service token, D-24), CLOUDFLARE_API_TOKEN and
 * CLOUDFLARE_ACCOUNT_ID (D1 access for the SQL steps).
 */
import { applySql, privateFacts, runPhase, selfCheck } from '../tests/leak/run.ts';

function env(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}.`);
    process.exit(2);
  }
  return v;
}

const base = env('STAGING_PUBLIC_URL');
const headers = {
  'CF-Access-Client-Id': env('CF_ACCESS_CLIENT_ID'),
  'CF-Access-Client-Secret': env('CF_ACCESS_CLIENT_SECRET'),
};
env('CLOUDFLARE_API_TOKEN');
env('CLOUDFLARE_ACCOUNT_ID');
const staging = { kind: 'staging' } as const;

let failures = 0;
try {
  applySql(staging, 'sentinels.sql');
  applySql(staging, 'toggle-a.sql');
  if (!(await selfCheck(base, headers))) failures++;
  failures += (await runPhase('a', base, privateFacts(staging), headers)).failures.length;
  applySql(staging, 'toggle-b.sql');
  failures += (await runPhase('b', base, privateFacts(staging), headers)).failures.length;
} finally {
  applySql(staging, 'toggle-a.sql');
}
if (failures > 0) {
  console.error(`\nPrivacy-leak suite on staging FAILED: ${failures} problem(s).`);
  process.exit(1);
}
console.log('\nPrivacy-leak suite on staging passed (both phases).');
