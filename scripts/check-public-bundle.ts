/**
 * Build-output guard (ARC-01, INV-1, SEC-03). Run after `npm run build`.
 *
 * 1. The public Worker bundle must contain nothing admin-only: no Access JWT
 *    handling, no admin config, no private bucket, no admin write paths.
 * 2. The admin Worker bundle must not contain the dev-server Access bypass.
 * 3. No build may ship inline <script> or style="" (CSP has no 'unsafe-inline').
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');

function files(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...files(full, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

const failures: string[] = [];

function forbid(dir: string, exts: string[], patterns: Array<[RegExp, string]>): void {
  const abs = path.join(root, dir);
  for (const file of files(abs, exts)) {
    const text = readFileSync(file, 'utf8');
    for (const [re, why] of patterns) {
      if (re.test(text)) failures.push(`${path.relative(root, file)}: ${why} (${re})`);
    }
  }
}

// 1. Public Worker: no admin code paths.
forbid(
  'apps/public/dist',
  ['.mjs', '.js', '.html'],
  [
    [/cf-access-jwt-assertion/i, 'Access JWT handling in public bundle'],
    [/ADMIN_EMAIL|ACCESS_AUD|ACCESS_TEAM_DOMAIN/, 'admin configuration in public bundle'],
    [/MEDIA_PRIVATE/, 'private media bucket in public bundle'],
    [/x-cg-request/i, 'admin CSRF handling in public bundle'],
    [/CG_DEV_ONLY_ACCESS_BYPASS/, 'dev-only code in public bundle'],
  ],
);

// 2. Admin Worker: the dev bypass must be compiled out.
forbid(
  'apps/admin/dist',
  ['.mjs', '.js'],
  [[/CG_DEV_ONLY_ACCESS_BYPASS/, 'dev-only Access bypass shipped']],
);

// 3. Rendered page templates: no inline scripts/styles (checked again at runtime by e2e).
for (const app of ['public', 'admin']) {
  forbid(
    `apps/${app}/dist/client`,
    ['.html'],
    [
      [/<script(?![^>]*\bsrc=)[^>]*>/i, 'inline <script>'],
      [/\sstyle\s*=/i, 'inline style attribute'],
    ],
  );
}

if (failures.length > 0) {
  console.error(`Bundle check failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('Bundle check passed.');
