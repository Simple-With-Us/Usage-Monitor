import path from 'node:path';
import { test, expect, type Page, type Route } from '@playwright/test';

// Committed determinism stylesheet (DejaVu font pinning).  Applied AFTER
// navigation — see pinFonts below.
const DETERMINISM_CSS = path.resolve(__dirname, 'visual-determinism.css');

// Automated visual verification for the web UI (owner directive 2026-09-27).
// Jay never takes manual screenshots or runs local UI preview sessions, so
// these screenshot assertions are the standing automated-only UI check for
// the web dashboard. The native Mac (macos/) and iOS (ios/) surfaces are NOT
// covered here — Playwright cannot drive them; they stay on code review + CI.
//
// Determinism strategy (all fixtures are intentionally an empty, frozen world):
//   - The clock is pinned to a fixed instant via addInitScript, so month
//     labels, relative times, and countdowns cannot drift between runs.
//   - Every /api/* call is intercepted with fixed fixtures (empty lists,
//     zero-money summaries), so real provider data and server wall-clock
//     can never leak into a screenshot.
//   - Cross-origin requests (analytics RUM, fonts, external probes) are
//     aborted — the app must render fully offline.
//   - animations: 'disabled' + caret: 'hide' per screenshot; fonts are pinned
//     to DejaVu via the committed visual-determinism.css, applied AFTER
//     navigation (page.addStyleTag() is wiped by page.goto(), so the old
//     pre-navigation call never took effect — CI diffs of 2-3% on
//     text-heavy pages on 2026-09-27 were fallback-font rendering, not
//     real UI changes).
//   - Baselines are generated on the ubuntu-latest CI runner itself via the
//     regenerate-visual-baselines workflow, so the committed PNGs always
//     match the runner's font stack exactly.
//
// Auth: the dashboard pages require a dashboard_session cookie. Tests log in
// through the real POST /api/auth/login using E2E_TEST_PASSWORD, which the
// Playwright config wires to the test server's DASHBOARD_PASSWORD.

const FROZEN_NOW_ISO = '2026-09-27T20:00:00.000Z';

const stableShot = {
  animations: 'disabled',
  caret: 'hide',
  // Cross-machine font rendering (local VM vs ubuntu-latest CI) differs at
  // the sub-pixel level even with DejaVu pinned; allow 1% differing pixels so
  // the suite stays green across machines while still catching real UI
  // regressions (fleet convention, same as Harness's visual suite).
  maxDiffPixelRatio: 0.01,
} as const;

/** Pin the wall clock to FROZEN_NOW_ISO in the page before any app code runs. */
async function freezeClock(page: Page): Promise<void> {
  await page.addInitScript((frozenIso: string) => {
    const frozen = new Date(frozenIso).getTime();
    const RealDate = Date;
    class FrozenDate extends RealDate {
      constructor(...args: unknown[]) {
        // @ts-expect-error spread into Date constructor
        super(...(args.length === 0 ? [frozen] : args));
      }
      static now(): number {
        return frozen;
      }
    }
    (globalThis as unknown as { Date: typeof Date }).Date = FrozenDate as typeof Date;
  }, FROZEN_NOW_ISO);
}

/** Force DejaVu rendering so baselines are portable across machines.
 *
 * MUST be called after page.goto(): navigation replaces the document and
 * wipes anything injected with page.addStyleTag() beforehand.  (The suite
 * called this pre-navigation until 2026-09-27, when CI showed 2-3% pixel
 * drift on text-heavy pages — the pinning had never applied and both
 * machines rendered with their own fallback fonts.)
 */
async function pinFonts(page: Page): Promise<void> {
  await page.addStyleTag({ path: DETERMINISM_CSS });
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

/** Intercept all API calls with fixed fixtures; block the outside world. */
async function stubApi(page: Page): Promise<void> {
  const zeroTelemetry = {
    days: 30,
    totalCostUsd: 0,
    estimatedApiEquivalentUsd: 0,
    pricedEventCount: 0,
    unpricedEventCount: 0,
    unclassifiedCostEventCount: 0,
    costCoverage: 'complete',
    totalRequests: 0,
    eventCount: 0,
    groups: [],
  };
  const emptyProjectSummary = {
    projects: [],
    summary: { totalSpentUsd: 0, unbudgetedSpentUsd: 0, unassignedSpentUsd: 0 },
  };
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    if (req.method() !== 'GET' && !(req.url().includes('/api/providers/refresh-stale'))) {
      // Login and other real mutations go through untouched.
      await route.continue();
      return;
    }
    if (req.url().includes('/api/providers/refresh-stale')) {
      await json(route, {});
      return;
    }
    if (req.url().includes('/api/providers')) {
      await json(route, []);
      return;
    }
    if (req.url().includes('/api/subscriptions')) {
      await json(route, []);
      return;
    }
    if (req.url().includes('/api/budget-status')) {
      await json(route, { providers: [] });
      return;
    }
    if (req.url().includes('/api/usage-events')) {
      await json(route, zeroTelemetry);
      return;
    }
    if (req.url().includes('/api/projects')) {
      await json(route, emptyProjectSummary);
      return;
    }
    if (/\/api\/settings\/?$/.test(req.url())) {
      await json(route, { notifications: { emailConfigured: false, minSeverity: 'warning' } });
      return;
    }
    // Anything unmapped passes through to the test server (fresh throwaway
    // SQLite), so pages never hang on an un-stubbed endpoint.
    await route.continue();
  });
  // Abort anything leaving the test origin entirely.
  await page.route(/^(https?:)?\/\/(?!127\.0\.0\.1|localhost).*/, (route) => route.abort());
}

/** Log in through the real login API so dashboard pages render authenticated. */
async function login(page: Page): Promise<void> {
  const password = process.env.E2E_TEST_PASSWORD;
  expect(password, 'E2E_TEST_PASSWORD must be set in the shell running the tests (CI sets it in the job env)').toBeTruthy();
  const response = await page.request.post('/api/auth/login', { data: { password } });
  expect(response.ok(), 'login should succeed with the test password').toBeTruthy();
}

/** Pre-navigation determinism: clock freeze + API stubs.  addInitScript and
 *  route handlers live for the page's lifetime, so these survive goto().
 *  Font pinning is separate (pinFonts) because style tags do NOT survive. */
async function settle(page: Page): Promise<void> {
  await freezeClock(page);
  await stubApi(page);
}

test.describe('visual: login page', () => {
  test('login form renders', async ({ page }) => {
    await settle(page);
    await page.goto('/login');
    await pinFonts(page);
    await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
    await expect(page).toHaveScreenshot('login.png', { ...stableShot, fullPage: true });
  });

  test('login form shows invalid-password error', async ({ page }) => {
    await settle(page);
    await page.goto('/login');
    await pinFonts(page);
    await page.getByLabel(/password/i).fill('definitely-wrong-password');
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).toHaveScreenshot('login-error.png', { ...stableShot, fullPage: true });
  });
});

test.describe('visual: dashboard', () => {
  test('dashboard home (empty account state)', async ({ page }) => {
    test.setTimeout(90_000);
    await settle(page);
    await login(page);
    await page.goto('/');
    await pinFonts(page);
    await page.waitForLoadState('networkidle');
    // Stable marker: the hero section renders once provider data settles.
    await expect(page.locator('main')).toBeVisible();
    await expect(page).toHaveScreenshot('dashboard.png', { ...stableShot, fullPage: true });
  });
});

test.describe('visual: providers page', () => {
  test('providers list (empty account state)', async ({ page }) => {
    test.setTimeout(90_000);
    await settle(page);
    await login(page);
    await page.goto('/providers');
    await pinFonts(page);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('main')).toBeVisible();
    await expect(page).toHaveScreenshot('providers.png', { ...stableShot, fullPage: true });
  });
});

test.describe('visual: money page', () => {
  test('money overview (empty account state)', async ({ page }) => {
    test.setTimeout(90_000);
    await settle(page);
    await login(page);
    await page.goto('/money');
    await pinFonts(page);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('main')).toBeVisible();
    await expect(page).toHaveScreenshot('money.png', { ...stableShot, fullPage: true });
  });
});

test.describe('visual: settings page', () => {
  test('settings (connections tab, empty account state)', async ({ page }) => {
    test.setTimeout(90_000);
    await settle(page);
    await login(page);
    await page.goto('/settings');
    await pinFonts(page);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('main')).toBeVisible();
    await expect(page).toHaveScreenshot('settings.png', { ...stableShot, fullPage: true });
  });
});
