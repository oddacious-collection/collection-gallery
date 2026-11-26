import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './test/wrangler.test.jsonc' },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    resolve: {
      alias: {
        // Tests build MP4 files with Mediabunny (the uploader's library). Its
        // module build probes for Node built-ins, which workerd can't load;
        // the single-file browser bundle doesn't.
        mediabunny: path.join(
          import.meta.dirname,
          '../../node_modules/mediabunny/dist/bundles/mediabunny.mjs',
        ),
      },
    },
    test: {
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/apply-migrations.ts'],
    },
  };
});
