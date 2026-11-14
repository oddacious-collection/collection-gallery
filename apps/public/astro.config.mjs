// @ts-check
import cloudflare from '@astrojs/cloudflare';
import { defineConfig } from 'astro/config';

export default defineConfig({
  // Every page is rendered by the Worker, so every HTML response passes
  // through the security pipeline (src/worker.ts).
  output: 'server',
  adapter: cloudflare({
    // Images are processed in the admin browser (MED-02); no Images binding.
    imageService: 'passthrough',
    // Both Workers share one local D1 state directory.
    persistState: { path: '../../.wrangler/state' },
  }),
  // No sessions: they would set cookies and need KV (INV-3).
  session: false,
  security: { checkOrigin: true },
  build: {
    // CSS ships as files so the CSP needs no 'unsafe-inline' for styles.
    inlineStylesheets: 'never',
  },
  vite: {
    // Never inline assets as data: URIs (the CSP does not allow data:).
    build: { assetsInlineLimit: 0 },
  },
  devToolbar: { enabled: false },
  prefetch: false,
});
