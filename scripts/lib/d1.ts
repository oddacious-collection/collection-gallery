/**
 * Running D1 queries from Node scripts (backup verify, export, restore).
 * Wrangler runs through its own entry script with this Node, without a
 * shell, so arguments (SQL included) arrive exactly as given on any OS.
 * Remote `--file` runs use Cloudflare's import API, which returns no rows:
 * queries go through `--command`, one statement per call.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export const ROOT = path.join(import.meta.dirname, '../..');

/** Where to run: local state (optionally another directory) or a remote database. */
export type D1Target =
  | { kind: 'local'; persistTo?: string; database?: string }
  | { kind: 'remote'; env: 'staging'; database?: string };

function targetArgs(t: D1Target): string[] {
  const config = path.join(ROOT, 'apps/admin/wrangler.jsonc');
  if (t.kind === 'local') {
    return [
      '--local',
      '--config',
      config,
      '--persist-to',
      t.persistTo ?? path.join(ROOT, '.wrangler/state'),
    ];
  }
  return ['--remote', '--config', config, '--env', t.env];
}

export function wrangler(args: string[]): string {
  return execFileSync(
    process.execPath,
    [path.join(ROOT, 'node_modules/wrangler/bin/wrangler.js'), ...args],
    {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
    },
  );
}

/** Rows of one SQL statement. */
export function d1Query<T = Record<string, unknown>>(t: D1Target, sql: string): T[] {
  const out = wrangler([
    'd1',
    'execute',
    t.database ?? 'DB',
    ...targetArgs(t),
    '--json',
    '--command',
    sql,
  ]);
  const json = JSON.parse(out.slice(out.indexOf('['))) as Array<{ results?: T[] }>;
  return json.flatMap((r) => r.results ?? []);
}

/** Runs a .sql file (any number of statements; returns no rows). */
export function d1File(t: D1Target, file: string): void {
  wrangler(['d1', 'execute', t.database ?? 'DB', ...targetArgs(t), '--file', file, '--yes']);
}

/** Applies the forward-only migrations to a target (an empty database gets the full schema). */
export function d1Migrate(t: D1Target): void {
  wrangler(['d1', 'migrations', 'apply', t.database ?? 'DB', ...targetArgs(t)]);
}
