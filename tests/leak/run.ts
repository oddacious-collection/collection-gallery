/**
 * Shared steps for the leak suite runners (scripts/leak-local.ts and
 * scripts/leak-staging.ts): apply SQL, read private facts from the
 * database, run one crawl phase.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crawl, type CrawlResult, type Forbidden } from './crawl.ts';
import { phaseChecks, type Phase } from './config.ts';

export const ROOT = path.join(import.meta.dirname, '../..');
const ADMIN_CONFIG = path.join(ROOT, 'apps/admin/wrangler.jsonc');

export type Target = { kind: 'local' } | { kind: 'staging' };

function wranglerArgs(target: Target): string[] {
  return target.kind === 'local'
    ? ['--local', '--config', ADMIN_CONFIG, '--persist-to', path.join(ROOT, '.wrangler/state')]
    : ['--remote', '--config', ADMIN_CONFIG, '--env', 'staging'];
}

function wrangler(args: string[]): string {
  const bin = path.join(
    ROOT,
    'node_modules/.bin',
    process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler',
  );
  return execFileSync(bin, args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function applySql(target: Target, file: string): void {
  wrangler([
    'd1',
    'execute',
    'DB',
    ...wranglerArgs(target),
    '--file',
    path.join(ROOT, 'tests/leak', file),
    '--yes',
  ]);
}

/**
 * Every private storage key and every internal ID, as forbidden strings,
 * plus the private keys as URLs that must 404. Labels never contain values.
 */
export function privateFacts(target: Target): {
  forbidden: Forbidden[];
  must404: Array<{ label: string; path: string }>;
} {
  // One statement per kind (D1 limits compound SELECTs); one result set each.
  const sql = [
    "SELECT 'master' AS kind, original_key AS v FROM media",
    "SELECT 'captions' AS kind, captions_key AS v FROM media WHERE captions_key IS NOT NULL",
    "SELECT 'hidden photo' AS kind, v.key AS v FROM media_variants v JOIN media m ON m.id = v.media_id JOIN items i ON i.id = m.item_id WHERE m.deleted_at IS NOT NULL OR NOT (i.status = 'public' AND i.kind = 'owned' AND i.deleted_at IS NULL)",
    "SELECT 'inbox photo' AS kind, json_extract(p.value, '$.key') AS v FROM inbox_photos, json_each(inbox_photos.parts) AS p",
    "SELECT 'document' AS kind, key AS v FROM documents",
    "SELECT 'id' AS kind, id AS v FROM items",
    "SELECT 'id' AS kind, id AS v FROM media",
    "SELECT 'id' AS kind, id AS v FROM categories",
    "SELECT 'id' AS kind, id AS v FROM tags",
    "SELECT 'id' AS kind, id AS v FROM inbox_photos",
  ].join(';\n');
  // Passed as a file: a long --command doesn't survive Windows shell quoting.
  const dir = mkdtempSync(path.join(tmpdir(), 'cg-leak-'));
  const file = path.join(dir, 'facts.sql');
  writeFileSync(file, `${sql};\n`);
  let out: string;
  try {
    out = wrangler([
      'd1',
      'execute',
      'DB',
      ...wranglerArgs(target),
      '--json',
      '--file',
      file,
      '--yes',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const json = JSON.parse(out.slice(out.indexOf('['))) as Array<{
    results: Array<{ kind: string; v: string }>;
  }>;
  const rows = json.flatMap((r) => r.results);
  const counts = new Map<string, number>();
  const forbidden: Forbidden[] = [];
  const must404: Array<{ label: string; path: string }> = [];
  for (const row of rows) {
    if (!row.v) continue;
    const n = (counts.get(row.kind) ?? 0) + 1;
    counts.set(row.kind, n);
    const label = row.kind === 'id' ? `internal ID #${n}` : `${row.kind} key #${n}`;
    // IDs are upper-case ULIDs; matching them case-sensitively avoids chance hits in lower-case keys.
    forbidden.push({ label, value: row.v, caseSensitive: row.kind === 'id' });
    if (row.kind !== 'id') must404.push({ label, path: `/media/${row.v}` });
  }
  return { forbidden, must404 };
}

export async function runPhase(
  phase: Phase,
  base: string,
  target: Target,
  headers: Record<string, string> = {},
): Promise<CrawlResult> {
  const checks = phaseChecks(phase);
  const facts = privateFacts(target);
  const result = await crawl({
    base,
    headers,
    forbidden: [...checks.forbidden, ...facts.forbidden],
    must404: [...checks.must404, ...facts.must404],
    must200: checks.must200,
    searches: checks.searches,
    log: (l) => console.log(`  ${l}`),
  });
  console.log(
    `Phase ${phase.toUpperCase()}: ${result.requests} requests (${result.pages} pages, ${result.files} files), ` +
      `${checks.forbidden.length + facts.forbidden.length} forbidden strings, ` +
      `${checks.must404.length + facts.must404.length} must-404 URLs: ` +
      (result.failures.length === 0 ? 'no leaks.' : `${result.failures.length} FAILURES.`),
  );
  return result;
}

/**
 * Proves the crawler can find a leak: a short crawl in which a known PUBLIC
 * title is declared forbidden and a public page is declared must-404. Both
 * must be reported, or the suite itself is broken.
 */
export async function selfCheck(
  base: string,
  headers: Record<string, string> = {},
): Promise<boolean> {
  const result = await crawl({
    base,
    headers,
    forbidden: [{ label: 'self-check marker', value: 'Leak test public item' }],
    must404: [{ label: 'self-check page', path: '/item/leak-test-public-item' }],
    must200: [],
    searches: ['leak'],
    maxRequests: 60,
  });
  const ok =
    result.failures.some((f) => f.includes('contains self-check marker')) &&
    result.failures.some((f) => f.startsWith('self-check page: answered 200'));
  console.log(
    `Self-check: ${ok ? 'the crawler detects planted leaks.' : 'FAILED: a planted leak went unnoticed.'}`,
  );
  return ok;
}
