/**
 * Writes apps/<host>/public/_headers from the shared header policy so static
 * assets served without the Worker carry the same security headers (SEC-07).
 *
 * Usage: node scripts/generate-headers.ts <public|admin>
 * Environment comes from CLOUDFLARE_ENV (the same variable that selects the
 * Wrangler environment at build time); unset means local.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EnvironmentName } from '../packages/core/src/config.ts';
import { staticHeadersFile, type HostKind } from '../packages/core/src/headers.ts';

const host = process.argv[2];
if (host !== 'public' && host !== 'admin') {
  console.error('usage: generate-headers.ts <public|admin>');
  process.exit(2);
}
const environment = EnvironmentName.parse(process.env['CLOUDFLARE_ENV'] ?? 'local');
const file = path.join(import.meta.dirname, '..', 'apps', host, 'public', '_headers');
mkdirSync(path.dirname(file), { recursive: true });
writeFileSync(file, staticHeadersFile({ host: host satisfies HostKind, environment }));
console.log(`wrote ${path.relative(process.cwd(), file)} for ${host}/${environment}`);
