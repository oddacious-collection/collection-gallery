/**
 * Software bill of materials (owner request 2026-11-25, D-67): everything the
 * site is built from, as CycloneDX JSON.
 *
 *   node scripts/sbom.ts [out-file]      (default: sbom.cdx.json)
 *
 * - npm packages from the lockfile, via npm's own `npm sbom` (build-only
 *   tools are marked `scope: optional` with `cdx:npm:package:development`);
 * - plus what npm can't see: every GitHub Action the workflows use (pinned
 *   commit and its release tag) and every container image they run (pinned
 *   digest), each noting the workflow file that uses it.
 *
 * Names, versions and licences only: nothing secret or account-identifying
 * goes in (CI logs and artifacts of this public repository are public).
 */
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const out = path.resolve(process.argv[2] ?? 'sbom.cdx.json');

interface Component {
  'bom-ref': string;
  type: string;
  name: string;
  group?: string;
  version: string;
  purl: string;
  scope?: string;
  properties?: Array<{ name: string; value: string }>;
}

// A fixed command line (no outside input), so one string works on every OS.
const bom = JSON.parse(
  execSync('npm sbom --sbom-format cyclonedx --sbom-type application --package-lock-only', {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }),
) as { metadata: { component: { version: string } }; components: Component[] };

// Pinned actions: `uses: owner/repo[/path]@<40-hex sha> # vX.Y.Z`.
const ACTION = /uses:\s*([\w.-]+)\/([\w.-]+)(?:\/[\w./-]+)?@([0-9a-f]{40})(?:\s*#\s*(\S+))?/g;
// Pinned images: `registry/owner/name@sha256:<digest>` (a registry has a dot).
const IMAGE = /\b([a-z0-9][a-z0-9.-]*)\/([a-z0-9._/-]+)@(sha256:[0-9a-f]{64})/g;

const extra = new Map<string, Component>();
const used = new Map<string, Set<string>>();
const note = (ref: string, file: string) => used.set(ref, (used.get(ref) ?? new Set()).add(file));
const workflows = path.join(ROOT, '.github/workflows');
for (const file of readdirSync(workflows)
  .filter((f) => /\.ya?ml$/.test(f))
  .sort()) {
  const text = readFileSync(path.join(workflows, file), 'utf8');
  for (const [, owner = '', repo = '', sha = '', tag] of text.matchAll(ACTION)) {
    const ref = `pkg:githubactions/${owner}/${repo}@${sha}`;
    extra.set(ref, {
      'bom-ref': ref,
      type: 'application',
      group: owner,
      name: repo,
      version: tag ?? sha,
      purl: ref,
      properties: [{ name: 'cg:pinned-commit', value: sha }],
    });
    note(ref, file);
  }
  for (const [, registry = '', name = '', digest = ''] of text.matchAll(IMAGE)) {
    if (!registry.includes('.')) continue;
    const ref = `pkg:docker/${name}@${digest}?repository_url=${registry}`;
    extra.set(ref, {
      'bom-ref': ref,
      type: 'container',
      name: `${registry}/${name}`,
      version: digest,
      purl: ref,
    });
    note(ref, file);
  }
}
for (const [ref, c] of extra) {
  for (const f of [...(used.get(ref) ?? [])].sort()) {
    (c.properties ??= []).push({ name: 'cg:used-by', value: `.github/workflows/${f}` });
  }
}

// The commit this SBOM describes, when CI knows it.
const sha = process.env['GITHUB_SHA'];
if (sha && /^[0-9a-f]{40}$/.test(sha)) bom.metadata.component.version = sha;
bom.components.push(...[...extra.values()].sort((a, b) => a.purl.localeCompare(b.purl)));
writeFileSync(out, `${JSON.stringify(bom, null, 2)}\n`);

const npmCount = bom.components.length - extra.size;
const dev = bom.components.filter((c) => c.scope === 'optional').length;
console.log(
  `SBOM: ${npmCount} npm packages (${dev} build-only), ${extra.size} actions and images -> ${path.relative(ROOT, out)}`,
);
