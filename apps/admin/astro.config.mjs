// @ts-check
import cloudflare from '@astrojs/cloudflare';
import { defineConfig } from 'astro/config';

// `astro dev` uses wrangler.dev.jsonc (see the comment there); everything else,
// including builds, uses wrangler.jsonc.
const isDevServer = process.argv.slice(2).includes('dev');

export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    imageService: 'passthrough',
    ...(isDevServer ? { configPath: './wrangler.dev.jsonc' } : {}),
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
