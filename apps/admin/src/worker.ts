/**
 * Admin Worker entry point. Every request (pages, API and — because of
 * `run_worker_first` — static assets) goes through the admin pipeline, which
 * validates the Cloudflare Access JWT before anything else runs (SEC-03).
 */
import { handle } from '@astrojs/cloudflare/handler';
import { createAdminPipeline } from '@cg/core/admin';
import { createDevPipeline } from './dev-only.ts';

// `import.meta.env.DEV` is a build-time constant: true only under `astro dev`.
// In every build it is `false`, so the dev pipeline is removed from the bundle
// (verified by `npm run check:bundle`).
const fetch = import.meta.env.DEV
  ? createDevPipeline<Env>(handle)
  : createAdminPipeline<Env>(handle);

export default { fetch } satisfies ExportedHandler<Env>;
