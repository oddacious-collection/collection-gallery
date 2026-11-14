// @ts-check
import cloudflare from '@astrojs/cloudflare';
import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    imageService: 'passthrough',
    // Both Workers share one local D1 state directory.
    persistState: { path: '../../.wrangler/state' },
  }),
  // No Astro sessions; the only admin cookie is Cloudflare Access's (SEC-08).
  session: false,
  security: { checkOrigin: true },
  build: { inlineStylesheets: 'never' },
  vite: { build: { assetsInlineLimit: 0 } },
  devToolbar: { enabled: false },
  prefetch: false,
});
