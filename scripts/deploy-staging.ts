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
import { spawnSync } from 'node:child_process';
import path from 'node:path';

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

const vars: Record<string, string> =
  app === 'public'
    ? { PUBLIC_ORIGIN: env('STAGING_PUBLIC_URL') }
    : {
        PUBLIC_ORIGIN: env('STAGING_PUBLIC_URL'),
        ADMIN_ORIGIN: env('STAGING_ADMIN_URL'),
        ACCESS_TEAM_DOMAIN: env('ACCESS_TEAM_DOMAIN'),
        ACCESS_AUD: env('ACCESS_AUD_ADMIN'),
      };

const args = [
  'wrangler',
  'deploy',
  '--config',
  'dist/server/wrangler.json',
  ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`]),
  ...(dryRun ? ['--dry-run'] : []),
];
const cwd = path.join(import.meta.dirname, '..', 'apps', app);
const result = spawnSync('npx', args, {
  cwd,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(result.status ?? 1);
