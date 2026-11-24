/**
 * Privacy-leak suite, local deploy gate (TST-02). Runs against the BUILT
 * public Worker and the local data (npm run build, db:migrate:local and
 * db:seed:local first):
 *
 *   1. add the sentinel data (tests/leak/sentinels.sql), phase A;
 *   2. start the public site and crawl it;
 *   3. flip two items private <-> public (toggle-b.sql), restart, crawl again;
 *   4. always: put the toggle back and remove the sentinel rows.
 *
 * Exits 1 on any leak. CI runs it before any deploy.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { ROOT, applySql, runPhase, selfCheck } from '../tests/leak/run.ts';

const BASE = 'http://localhost:4321';
const local = { kind: 'local' } as const;

function startPublic(): ChildProcess {
  return spawn('npm run preview -w @cg/public', {
    cwd: ROOT,
    shell: true,
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  });
}

function stop(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // already gone
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
}

async function waitUntilUp(): Promise<void> {
  const until = Date.now() + 90_000;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${BASE}/robots.txt`);
      if (res.ok) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('the public site did not start');
}

async function freePort(): Promise<void> {
  try {
    await fetch(`${BASE}/robots.txt`);
  } catch {
    return;
  }
  throw new Error(
    `something is already serving ${BASE}; stop it first (it would be a stale build)`,
  );
}

let failures = 0;
let server: ChildProcess | null = null;
try {
  await freePort();
  applySql(local, 'sentinels.sql');
  for (const phase of ['a', 'b'] as const) {
    applySql(local, `toggle-${phase}.sql`);
    server = startPublic();
    await waitUntilUp();
    if (phase === 'a' && !(await selfCheck(BASE))) failures++;
    failures += (await runPhase(phase, BASE, local)).failures.length;
    stop(server);
    server = null;
    await new Promise((r) => setTimeout(r, 1500));
  }
} finally {
  if (server) stop(server);
  applySql(local, 'toggle-a.sql');
  applySql(local, 'cleanup-local.sql');
}
if (failures > 0) {
  console.error(`\nPrivacy-leak suite FAILED: ${failures} problem(s).`);
  process.exit(1);
}
console.log('\nPrivacy-leak suite passed (both phases).');
