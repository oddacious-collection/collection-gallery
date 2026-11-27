# Security scans and the SBOM (D-67)

What runs, where the results go, and what to do with a finding.

## What runs

| Scan                                | When                                                       | What it checks                                                                          | Results                                                           |
| ----------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| CodeQL (`codeql.yml`)               | Every PR, every push to `main`, Mondays 06:27 UTC          | The site's own code and the workflows                                                   | Security tab → Code scanning; a PR with a new finding can't merge |
| Dependency scan (`osv-scan.yml`)    | Mondays 06:37 UTC; PRs and pushes that change the lockfile | Every npm package in `package-lock.json` (build tools too) against OSV                  | Security tab → Code scanning; the run fails on a finding          |
| ZAP (`zap-staging.yml`)             | After every staging deploy, and Mondays 06:47 UTC          | The staging site from outside (headers, cookies, CSP, common web flaws), through Access | The run's summary (redacted, D-37); the run fails on a FAIL rule  |
| Secret scan (gitleaks, in `ci.yml`) | Every PR and push                                          | Committed secrets                                                                       | The run fails                                                     |
| Dependabot                          | Mondays                                                    | Newer npm packages and Action pins (7-day wait, D-58); known-vulnerable versions        | Pull requests and Security tab → Dependabot                       |
| Heartbeat (`heartbeat.yml`)         | Mondays 09:07 UTC                                          | Every scheduled workflow above (and the backup checks) is switched on and ran recently  | The run fails if one is paused or overdue                         |

GitHub emails the owner when a scheduled run fails. GitHub pauses scheduled workflows after 60 days without repository activity; the heartbeat switches them back on each week and reports a pause, so a quiet repository doesn't quietly stop checking.

## The SBOM

Every staging deploy keeps a CycloneDX SBOM with its run for 90 days: Actions → the CI run → Artifacts → `sbom-<commit>`. It lists every npm package (build-only tools marked `scope: optional`), every pinned GitHub Action and the ZAP image, each with the workflow that uses it. Make one locally with `npm run sbom` (writes `sbom.cdx.json`, not committed).

## A finding

1. **Dependency (OSV or Dependabot):** if a fixed version exists, update it (Dependabot usually opens the PR; it waits 7 days after a release, D-58). If it doesn't affect the site, add it to `osv-scanner.toml` with the exact reason and an `ignoreUntil` date at most 3 months away, so it gets re-checked. Never ignore without a reason.
2. **CodeQL:** fix the code. Dismiss only a proven false positive, with the reason in the dismissal.
3. **ZAP:** a new FAIL usually means a header or page change; fix it rather than loosening `.zap/rules.tsv` (INV-4).
4. **Heartbeat:** open the named workflow in the Actions tab. If it was paused, the heartbeat has already switched it back on; run it once by hand (Run workflow) to catch up.
