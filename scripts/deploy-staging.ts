/**
 * Deploys a built Worker to staging, injecting host-specific values that are
 * deliberately NOT committed to this public repository (they can identify the
 * owner's Cloudflare account): the workers.dev hostnames and the Access team.
 *
 * Usage (after `CLOUDFLARE_ENV=staging npm run build`):
 *   node scripts/deploy-staging.ts <public|admin> [--dry-run]
 *
 * Required env (GitHub `staging` environment secrets in CI, so they're masked
 * in the public logs):
 *   STAGING_PUBLIC_URL   e.g. https://cg-public-staging.<subdomain>.workers.dev
 *   STAGING_ADMIN_URL    e.g. https://cg-admin-staging.<subdomain>.workers.dev
 *   ACCESS_TEAM_DOMAIN   e.g. https://<team>.cloudflareaccess.com   (admin only)
 *   ACCESS_AUD_ADMIN     the admin staging Access app's AUD tag      (admin only)
 */
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { staticHeadersFile } from '../packages/core/src/headers.ts';

const app = process.argv[2];
if (app !== 'public' && app !== 'admin') {
  console.error('usage: deploy-staging.ts <public|admin> [--dry-run]');
  process.exit(2);
}
const dryRun = process.argv.includes('--dry-run');

function env(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`missing env ${name}`);
    process.exit(2);
  }
  return v.replace(/\/$/, '');
}

function fail(message: string): never {
  console.error(`deploy-staging: ${message}`);
  process.exit(1);
}

const cwd = path.join(import.meta.dirname, '..', 'apps', app);
const expectedName = `cg-${app}-staging`;

// Guard: only deploy a build made for staging, to the Worker that Access
// protects. (2026-11-22: a stray CLOUDFLARE_ENV made wrangler append a second
// "-staging" and create new, unprotected Workers. Never again.)
const built = JSON.parse(readFileSync(path.join(cwd, 'dist/server/wrangler.json'), 'utf8')) as {
  name?: unknown;
  workers_dev?: unknown;
  preview_urls?: unknown;
};
if (built.name !== expectedName) {
  fail(
    `built config is for "${String(built.name)}", expected "${expectedName}" (build with CLOUDFLARE_ENV=staging)`,
  );
}
if (built.preview_urls !== false) fail('preview_urls must be false');

// The public Worker serves static files without running, using the generated
// `_headers`: it must be the staging policy, not a local one (no
// upgrade-insecure-requests) or a stale file.
if (app === 'public') {
  const headersFile = readFileSync(path.join(cwd, 'dist/client/_headers'), 'utf8');
  if (headersFile !== staticHeadersFile({ host: 'public', environment: 'staging' })) {
    fail('dist/client/_headers is not the staging header policy');
  }
}

// Deploy only output that passed the bundle guard (no admin code in public,
// no dev bypass in admin, no inline scripts or styles).
const bundle = spawnSync(
  process.execPath,
  [path.join(import.meta.dirname, 'check-public-bundle.ts')],
  {
    stdio: 'inherit',
  },
);
if (bundle.status !== 0) fail('bundle check failed');

const vars: Record<string, string> =
  app === 'public'
    ? { PUBLIC_ORIGIN: env('STAGING_PUBLIC_URL') }
    : {
        PUBLIC_ORIGIN: env('STAGING_PUBLIC_URL'),
        ADMIN_ORIGIN: env('STAGING_ADMIN_URL'),
        ACCESS_TEAM_DOMAIN: env('ACCESS_TEAM_DOMAIN'),
        ACCESS_AUD: env('ACCESS_AUD_ADMIN'),
      };

// The built config is already the flattened staging config. CLOUDFLARE_ENV
// must not reach wrangler here, or it applies the environment a second time.
const childEnv = { ...process.env };
delete childEnv['CLOUDFLARE_ENV'];
const opts: SpawnSyncOptions = { cwd, env: childEnv, shell: process.platform === 'win32' };

// A unique marker on this deployment, checked afterwards on the expected Worker.
const marker = `ci-${process.env['GITHUB_SHA'] ?? randomUUID()}`;

const args = [
  'wrangler',
  'deploy',
  '--config',
  'dist/server/wrangler.json',
  '--name',
  expectedName,
  '--message',
  marker,
  ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`]),
  ...(dryRun ? ['--dry-run'] : []),
];
const deployed = spawnSync('npx', args, { ...opts, stdio: 'inherit' });
if (deployed.status !== 0) process.exit(deployed.status ?? 1);
if (dryRun) process.exit(0);

// Verify the deploy landed on the expected Worker. Parse only: the JSON
// includes the deployer's identity, which must not reach the public CI log.
const status = spawnSync(
  'npx',
  ['wrangler', 'deployments', 'status', '--name', expectedName, '--json'],
  { ...opts, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' },
);
let message: unknown;
try {
  const parsed = JSON.parse(String(status.stdout)) as { annotations?: Record<string, unknown> };
  message = parsed.annotations?.['workers/message'];
} catch {
  message = undefined;
}
if (message !== marker) fail(`${expectedName} is not running this deploy`);
console.log(`deploy-staging: verified ${expectedName} is running this deploy`);
