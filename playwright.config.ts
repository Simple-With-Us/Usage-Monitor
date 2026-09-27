import { defineConfig } from '@playwright/test';

// Fleet rollout scaffold: chromium-only smoke tests against a local server.
// Point PLAYWRIGHT_BASE_URL at a deployed environment to run against it.
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000';

// Throwaway, test-only auth credentials for the visual suite (visual.spec.ts
// logs in through the real /api/auth/login). These are committed test
// secrets only — never production values. Each honors the ambient environment
// first (so CI's own DATABASE_URL override wins) and falls back to the
// committed throwaway default for local runs.
const testEnv = {
  DATABASE_URL: process.env.DATABASE_URL ?? 'file:./prisma/playwright-visual-test.db',
  DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD ?? 'visual-test-password',
  SESSION_SECRET: process.env.SESSION_SECRET ?? 'visual-test-session-secret-not-production',
  E2E_TEST_PASSWORD: process.env.E2E_TEST_PASSWORD ?? 'visual-test-password',
  DD_TRACE_ENABLED: 'false',
};

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  reporter: 'list',
  use: { baseURL },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'npm start -- -H 127.0.0.1 -p 3000',
    url: baseURL,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    env: testEnv,
  },
});
