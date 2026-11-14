/**
 * Public Worker entry point. Wraps Astro's handler in the public pipeline:
 * config validation, read-only methods, security headers, cookie stripping.
 */
import { handle } from '@astrojs/cloudflare/handler';
import { createPublicPipeline } from '@cg/core/public';

const fetch = createPublicPipeline<Env>(handle, { devServer: import.meta.env.DEV });

export default { fetch } satisfies ExportedHandler<Env>;
