/**
 * Build guard: refuse to build with a non-production NODE_ENV.
 *
 * Astro only defaults NODE_ENV to "production" when it is unset, so a stray
 * NODE_ENV=development (shell, CI, .env) would produce a development build in
 * which `import.meta.env.DEV` is true. The runtime guards (dev behaviour only
 * on loopback hosts in the local environment) and `npm run check:bundle` cover
 * this too; this stops it at the source.
 */
const nodeEnv = process.env['NODE_ENV'];
if (nodeEnv !== undefined && nodeEnv !== '' && nodeEnv !== 'production') {
  console.error(`assert-build-env: NODE_ENV is "${nodeEnv}"; builds must be production`);
  process.exit(1);
}
