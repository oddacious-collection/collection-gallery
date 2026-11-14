import { defineConfig } from 'drizzle-kit';

// Generates forward-only SQL migrations (OPS-03). They are applied with
// `wrangler d1 migrations apply` (see apps/admin/wrangler.jsonc).
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './migrations',
  strict: true,
  verbose: true,
});
