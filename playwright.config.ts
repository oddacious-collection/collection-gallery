import { defineConfig, devices } from '@playwright/test';

/**
 * E2E tests (TST-01/03/04) run against the BUILT Workers in local workerd via
 * `astro preview` — the same code that deploys. Build first: `npm run build`.
 */
const isCI = !!process.env['CI'];

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-webkit', use: { ...devices['iPhone 15'] } },
  ],
  webServer: [
    {
      command: 'npm run preview -w @cg/public',
      url: 'http://localhost:4321/robots.txt',
      reuseExistingServer: !isCI,
      timeout: 60_000,
    },
    {
      command: 'npm run preview -w @cg/admin',
      // Admin answers 403 to everything without an Access JWT; any HTTP
      // response means it is up.
      port: 4322,
      reuseExistingServer: !isCI,
      timeout: 60_000,
    },
  ],
});
