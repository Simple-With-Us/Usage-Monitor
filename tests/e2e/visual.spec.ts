import path from 'node:path';
import { BUDGET_VIEW } from '../../src/lib/fleet-budget/__tests__/view-fixture';
import type { AgentsOverviewResponse } from '../../src/lib/agents-overview';
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

const BUDGET_VISUAL = { ...BUDGET_VIEW, generatedAt: FROZEN_NOW_ISO, snapshot: { ...BUDGET_VIEW.snapshot, day: FROZEN_NOW_ISO.slice(0, 10) } };

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
    if (req.url().includes('/api/fleet-budget-status')) {
      await json(route, { ...BUDGET_VISUAL, snapshot: { ...BUDGET_VISUAL.snapshot,
        day: FROZEN_NOW_ISO.slice(0, 10), configured: false,
        settledPolicyMicros: '0', reservedPolicyMicros: '0', softLimitMicros: null, hardLimitMicros: null,
        providerCosts: BUDGET_VISUAL.snapshot.providerCosts.map((row) => ({ ...row,
          settledCalls: 0, outstandingCalls: 0, outstandingMaximumCostMicros: '0',
          estimatedCalls: 0, knownEstimatedCostMicros: null, providerReportedCalls: 0, knownProviderReportedCostMicros: null,
        })),
      } });
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
    if (req.url().includes('/api/agent-turns')) {
      await json(route, { ok: true, turns: [] });
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
    await expect(page.getByRole('heading', { name: 'Log In', exact: true })).toBeVisible();
    await expect(page).toHaveScreenshot('login.png', { ...stableShot, fullPage: true });
  });

  test('login form shows invalid-password error', async ({ page }) => {
    await settle(page);
    await page.goto('/login');
    await pinFonts(page);
    await page.getByLabel(/password/i).fill('definitely-wrong-password');
    await page.getByRole('button', { name: 'Log In', exact: true }).click();
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

  test('token telemetry keeps quantity separate from its dollar estimate', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 1000 });
    await settle(page);
    await page.route('**/api/providers?*', route => json(route, [{
      id: 'visual-openai', name: 'openai', displayName: 'OpenAI',
      type: 'api', groupId: null, label: null,
      isActive: true, plan: null, latestSnapshot: null, alerts: [],
      spentUsd: 0, projectedEomUsd: 0, monthlyBudgetUsd: 100,
      estimatedMonthlyCostUsd: 0, costCoverage: 'complete', spendCoverage: 'complete',
      pushedCostCoverage: 'complete', pushedPricedEventCount: 0, pushedUnpricedEventCount: 0,
      pushedUnclassifiedCostEventCount: 0, budgetStatus: 'ok',
    }]));
    await page.route('**/api/usage-events?*', route => json(route, {
      days: 30, totalCostUsd: 0, estimatedApiEquivalentUsd: 3,
      pricedEventCount: 0, unpricedEventCount: 1, unclassifiedCostEventCount: 0,
      costCoverage: 'unknown', totalRequests: 0, eventCount: 1,
      groups: [{
        sourceApp: 'opencode', environment: null, provider: 'openai', canonicalProvider: 'openai',
        service: 'opencode', projectId: null, metricType: 'usage', unit: 'token',
        eventCount: 1, pricedEventCount: 0, unpricedEventCount: 1, unclassifiedCostEventCount: 0,
        costCoverage: 'unknown', totalCostUsd: 0, estimatedApiEquivalentUsd: 3,
        totalRequests: 0, totalQuantity: 1_000_000, limit: null, limitWindow: null,
        latestAt: FROZEN_NOW_ISO,
      }],
    }));
    await login(page);
    await page.goto('/');
    await pinFonts(page);
    const details = page.locator('#portfolio details');
    await expect(details).toBeVisible();
    if (await details.getAttribute('open') === null) {
      await details.locator('summary').click();
    }
    await expect(details).toHaveAttribute('open', '');
    // Exercise the existing recovery action if initial loading fails.
    // This fixture verifies the populated token row after delivery succeeds.
    const loadError = details.getByRole('status').filter({ hasText: 'External app telemetry is temporarily unavailable.' });
    await expect(details.getByTestId('external-telemetry-panel').or(loadError)).toBeVisible();
    if (await loadError.isVisible()) {
      await loadError.getByRole('button', { name: 'Retry', exact: true }).click();
    }
    const panel = page.getByTestId('external-telemetry-panel');
    const row = panel.getByRole('row').filter({ hasText: 'opencode' });
    await expect(row.getByText('1,000,000', { exact: true })).toBeVisible();
    await expect(row.getByText('API-equivalent estimate: $3.00 · excluded from cash spend', { exact: true }))
      .toBeVisible();
    await expect(panel).toHaveScreenshot('token-quantity-and-estimate.png', stableShot);
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

test.describe('fleet budget monitoring', () => {
  test('blocked budget and unknown MiniMax costs stay honest on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await settle(page);
    await page.route('**/api/fleet-budget-status', (route) => json(route, {
      ...BUDGET_VISUAL, enabled: true, admissionEnabled: false,
      snapshot: { ...BUDGET_VISUAL.snapshot, blocked: true },
    }));
    await login(page);
    await page.goto('/money');
    await pinFonts(page);
    await expect(page.getByText('DeepSeek Blocked', { exact: true })).toBeVisible();
    const card = page.getByRole('region', { name: 'Fleet Daily Budget' });
    await expect(card.getByText('Unknown', { exact: true })).toHaveCount(2);
    // Capture the page from its normal position: an oversized element-only
    // screenshot scrolls the card title beneath the app's sticky mobile header.
    await expect(page).toHaveScreenshot('fleet-budget-mobile.png', { ...stableShot, fullPage: true });
  });
  test('refresh failure clears figures and Retry Budget restores them', async ({ page }) => {
    await settle(page);
    let calls = 0;
    await page.route('**/api/fleet-budget-status', (route) => ++calls === 2
      ? json(route, { error: 'synthetic unavailable' }, 503) : json(route, BUDGET_VISUAL));
    await login(page);
    await page.goto('/money');
    await pinFonts(page);
    const card = page.getByRole('region', { name: 'Fleet Daily Budget' });
    await expect(card.getByText('$1.50', { exact: true })).toBeVisible();
    await card.getByRole('button', { name: 'Refresh Budget' }).click();
    await expect(card.getByRole('alert')).toBeVisible();
    await expect(card.getByText('$1.50', { exact: true })).toHaveCount(0);
    await card.getByRole('button', { name: 'Retry Budget' }).click();
    await expect(card.getByText('$1.50', { exact: true })).toBeVisible();
    await expect(card).toHaveScreenshot('fleet-budget-desktop.png', stableShot);
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


test('visual: coding platform notes preserve sentence gaps', async ({ page }) => {
  const overview: AgentsOverviewResponse = {
    ok: true, windowDays: 30, windowLabel: 'Last 30 Days', generatedAt: FROZEN_NOW_ISO,
    macHostname: 'Office Mac', macChip: 'Apple Silicon',
    summary: {
      activeAgentCount: 4, totalAgentCount: 4, totalTokens: 40000,
      totalApiEquivalentCostUsd: 0.04, apiEquivalentCostComplete: true, unpricedModelCount: 0,
      totalSubscriptionCostUsd: 0, totalNetSavingsUsd: 0, savingsMultiplier: 0,
      topModel: null, telemetryIncomplete: false, telemetryIncompleteNote: null,
      unreliablePlatformIds: [],
    },
    burn5h: { tokens5h: 0, costEstimate5hUsd: 0, costEstimateComplete: true,
      burnRateTokensPerHour: 0, burnRateUsdPerHour: 0 },
    platforms: [{
      id: 'opencode', name: 'OpenCode', provider: 'Multi-Provider', isRunningOnMac: true,
      macStatus: 'running', dataCapability: 'Local session token receipts', fidelityTier: 'session_jsonl',
      notes: 'Local session usage is reported.  Cloud sessions require separate receipts.',
      monthlySeatCostUsd: 0, billedMonthlySeatCostUsd: 0, seatPlanName: 'No Fixed Seat',
      seatPlanNote: null, seatPlanSource: 'unknown', listMonthlySeatCostUsd: 0,
      bundledOffsetUsd: null, bundledOffsetLabel: null, seatCostNote: null,
      telemetryAccuracy: 'reported', telemetryAccuracyLabel: 'Reported',
      telemetryAccuracyNote: 'Exact token counts from local session receipts.', usageIsReliable: true,
      totalTokens: 10000, inputTokens: 8000, outputTokens: 2000,
      cacheReadTokens: 0, cacheCreationTokens: 0, apiEquivalentCostUsd: 0.04,
      apiEquivalentCostComplete: true, tokenDerivedCostUsd: 0.04, reportedCostUsd: 0,
      estimatedCostUsd: 0.04, netSavingsUsd: 0, modelsUsed: [],
    }],
    modelDistribution: [],
  };
  overview.platforms.push(...[
    { id: 'claude-code', name: 'Claude Code', provider: 'Anthropic',
      dataCapability: 'Full real-time OTLP telemetry',
      notes: 'Native OTLP metrics report tokens and cost estimates from Claude processes.' },
    { id: 'openai-codex', name: 'OpenAI Codex', provider: 'OpenAI',
      dataCapability: 'Incremental local session parsing',
      notes: 'Local CLI session telemetry.  Cloud and separate Desktop coverage require their own receipts.' },
    { id: 'fx', name: 'Fx', provider: 'xAI',
      dataCapability: 'Generation token and cache parsing',
      notes: 'Reads Fx generation facts.  Input includes cached tokens; reasoning is included in output.' },
  ].map(platform => ({ ...overview.platforms[0], ...platform })));
  await settle(page);
  await page.route('**/api/agents-overview?*', route => json(route, overview));
  await page.route('**/api/quota-windows', route => json(route, { windows: [] }));
  await login(page);
  await page.goto('/agents');
  await pinFonts(page);
  const card = page.getByTestId('agent-platform-opencode');
  await expect(card.getByText('Local session usage is reported.', { exact: false }))
    .toHaveJSProperty('textContent', 'Local session usage is reported.\u00a0 Cloud sessions require separate receipts.');
  await expect(card.getByRole('heading', { name: 'OpenCode', exact: true })).toBeVisible();
  await expect(card).toHaveScreenshot('coding-platform-notes.png', stableShot);
  const claude = page.getByTestId('agent-platform-claude-code');
  await expect(claude.getByRole('heading', { name: 'Claude Code', exact: true })).toBeVisible();
  await expect(claude).toHaveScreenshot('claude-code-platform.png', stableShot);
  await expect(page.getByTestId('agent-platform-openai-codex'))
    .toHaveScreenshot('codex-platform.png', stableShot);
  await expect(page.getByTestId('agent-platform-fx'))
    .toHaveScreenshot('fx-platform.png', stableShot);
});

test('visual: quota provenance distinguishes conflicting readings', async ({ page }) => {
  await settle(page);
  await page.route('**/api/agents-overview?*', route => json(route, {}, 503));
  await page.route('**/api/quota-windows', route => json(route, {
    windows: [
      { id: 'first', provider: 'anthropic', label: '5h window', remainingPercent: 83,
        status: 'available', source: 'Provider API', collector: 'CodeCaps', sourceApp: 'claude-code', machine: 'Office Mac',
        occurredAt: '2026-09-27T19:50:00.000Z', resetAt: '2026-09-27T23:00:00.000Z' },
      { id: 'second', provider: 'anthropic', label: '5h window', remainingPercent: 98,
        status: 'available', source: 'Local Collector', machine: 'Laptop',
        occurredAt: '2026-09-27T19:30:00.000Z', resetAt: '2026-09-27T23:00:00.000Z' },
    ],
  }));
  await login(page);
  await page.goto('/agents');
  await pinFonts(page);
  await expect(page.getByText(/Source: Provider API/)).toBeVisible();
  await expect(page.getByText(/Source: Local Collector/)).toBeVisible();
  await expect(page.getByRole('heading', { name: '5h Window', exact: true })).toHaveCount(2);
  await expect(page).toHaveScreenshot('quota-provenance.png', { ...stableShot, fullPage: true });
});

// Merged quotaGroups path (CodeCaps parity, #1674): pool-scoped hiding of
// short windows under an exhausted week, the Muse Assist "+ extra" balance
// row, legacy 1w/7d rows collapsed onto one canonical 7-day row, and the
// MiniMax 4-hour data error never shown.
test('visual: subscription quotas merged windows match CodeCaps', async ({ page }) => {
  const reading = (remainingPercent: number, resetAt: string) => ({
    source: 'codecaps', sourceLabel: 'CodeCaps', machine: 'Office Mac', collector: 'codecaps',
    remainingPercent, remainingUnknown: false, isExhausted: remainingPercent <= 0,
    resetAt, reportedAt: '2026-09-27T19:55:00.000Z', freshness: 'fresh',
  });
  const win = (windowKey: string, displayName: string, remainingPercent: number,
    resetAt: string, platformTitle: string | null = null) => ({
    windowKey, displayName, rawKey: windowKey, platformTitle,
    primary: reading(remainingPercent, resetAt), sources: [reading(remainingPercent, resetAt)],
  });
  const in5h = '2026-09-27T23:00:00.000Z';
  const in3d = '2026-09-30T20:00:00.000Z';
  await settle(page);
  await page.route('**/api/agents-overview?*', route => json(route, {}, 503));
  await page.route('**/api/quota-windows', route => json(route, {
    windows: [],
    quotaGroups: [
      { provider: 'anthropic', providerLabel: 'Claude', windows: [
        win('5h', '5-hour', 72, in5h),
        win('1w', '1w', 41, in3d),
        win('7d', '7-day', 41, in3d),
      ] },
      { provider: 'google-antigravity', providerLabel: 'Antigravity', windows: [
        win('7d', '7-day', 0, in3d, 'Antigravity · Gemini'),
        win('5h', '5-hour', 55, in5h, 'Antigravity · Gemini'),
        win('7d', '7-day', 60, in3d, 'Antigravity · Third-Party'),
        win('5h', '5-hour', 80, in5h, 'Antigravity · Third-Party'),
      ] },
      { provider: 'minimax', providerLabel: 'MiniMax', windows: [
        win('4h', '4-hour', 90, in5h),
        win('5h', '5-hour', 45, in5h),
      ] },
      { provider: 'muse', providerLabel: 'Muse Assist', windows: [
        win('7d', '7-day', 35, in3d),
        win('balance', 'balance', 64, in3d),
      ] },
    ],
  }));
  await login(page);
  await page.goto('/agents');
  await pinFonts(page);
  const card = page.getByRole('heading', { name: 'Subscription Quotas' })
    .locator('xpath=ancestor::div[contains(@class, "rounded-xl")][1]');
  await expect(card.getByText('Antigravity · Third-Party', { exact: true })).toBeVisible();
  await expect(card.getByText('extra', { exact: true })).toBeVisible();
  await expect(card.getByText('+', { exact: true })).toBeVisible();
  await expect(card.getByText('4-hour', { exact: true })).toHaveCount(0);
  // Claude 5h, Antigravity Third-Party 5h, MiniMax 5h; the Gemini 5h is hidden.
  await expect(card.getByText('5-hour', { exact: true })).toHaveCount(3);
  // Claude (1w and 7d collapsed), both Antigravity pools, Muse Assist.
  await expect(card.getByText('7-day', { exact: true })).toHaveCount(4);
  await expect(card).toHaveScreenshot('subscription-quotas-merged.png', stableShot);
});

// Owner-expense duplicate quarantine (#1686): the Receipt Inbox card's
// "Held Duplicates" panel with one held entry, its match reason, the matched
// ledger row, and the Post Anyway / Discard actions.  /api/operations still
// comes from the test server so every other card keeps its real shape; only
// the receiptInbox slice is pinned, and the quarantine list is stubbed.
test('visual: receipt inbox held duplicates panel', async ({ page }) => {
  test.setTimeout(90_000);
  await settle(page);
  await page.route('**/api/operations', async (route) => {
    const upstream = await route.fetch();
    const body = (await upstream.json()) as Record<string, unknown>;
    await json(route, {
      ...body,
      receiptInbox: {
        configured: true,
        state: 'healthy',
        evidenceActionsConfigured: false,
        needsReviewCount: 0,
        countIsLowerBound: false,
        latestReceivedAt: '2026-09-27T18:00:00.000Z',
        fetchedAt: FROZEN_NOW_ISO,
        items: [],
      },
    });
  });
  await page.route('**/api/owner-expenses/quarantine', (route) => json(route, {
    quarantined: [{
      id: '11111111-2222-4333-8444-555555555555',
      quarantinedAt: '2026-09-27T19:00:00.000Z',
      provider: 'Anthropic',
      amountUsd: 213.2,
      occurredAt: '2026-09-26T12:00:00.000Z',
      kind: 'subscription',
      label: 'Anthropic Max 20x Sep 26',
      notes: null,
      receiptInboxId: null,
      matchedEntries: [{
        idempotencyKey: 'owner-recorded-expense:v1:visual-fixture',
        provider: 'Anthropic',
        amountUsd: 213.2,
        occurredAt: '2026-09-26T12:00:00.000Z',
        label: 'Anthropic Max plan - 20x',
        matchedOn: 'vendor_amount_date',
      }],
      matchReason: 'Same vendor, amount, and charge date already posted: Anthropic $213.20 on 2026-09-26 (“Anthropic Max plan - 20x”).',
    }],
  }));
  await login(page);
  await page.goto('/ops');
  await pinFonts(page);
  const card = page.locator('section[aria-labelledby="receipt-inbox-heading"]');
  await card.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(card.getByText('Held Duplicates (1)')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Post Anyway' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Discard' })).toBeVisible();
  await expect(card).toHaveScreenshot('receipt-inbox-held-duplicates.png', stableShot);
});

// Fleet Alerts card on /ops (#1715, Kody rule [4]): new visible UI element gets
// a pinned screenshot.  /api/fleet-alerts is stubbed with a fixed two-topic
// payload (one firing, one clear); every other card keeps its test-server shape.
test('visual: fleet alerts card with firing topic', async ({ page }) => {
  test.setTimeout(90_000);
  await settle(page);
  const frozenEpoch = Date.parse(FROZEN_NOW_ISO) / 1000;
  await page.route('**/api/fleet-alerts', (route) => json(route, {
    configured: true,
    generatedAt: FROZEN_NOW_ISO,
    ok: true,
    summary: { topics: 2, alerts: 3, firing: 1 },
    topics: {
      'quota-burn': {
        firing: 1,
        total: 2,
        alerts: [
          { key: 'runaway|openai|5h', service: 'OpenAI', phase: 'alerting', severity: 'SEVERE', text: '5h window at 92% (burn 3.1x)', link: '', since: frozenEpoch - 900, updated: frozenEpoch - 60, prodDown: false },
          { key: 'watch|anthropic|7d', service: 'Anthropic', phase: 'pending', severity: 'MODERATE', text: '7d window trending to cap', link: '', since: frozenEpoch - 3600, updated: frozenEpoch - 120, prodDown: false },
        ],
      },
      'ship-pipeline': {
        firing: 0,
        total: 1,
        alerts: [
          { key: 'ship|ios|testflight', service: 'TestFlight', phase: 'ok', severity: 'INFO', text: 'Last ship green', link: '', since: frozenEpoch - 7200, updated: frozenEpoch - 300, prodDown: false },
        ],
      },
    },
  }));
  await login(page);
  await page.goto('/ops');
  await pinFonts(page);
  const card = page.getByTestId('fleet-alerts-card');
  // The card only mounts once the /ops payload resolves, so wait for it
  // instead of asserting on its contents straight after navigation.
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText('5h window at 92% (burn 3.1x)')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Refresh Fleet Alerts' })).toBeVisible();
  await expect(card.getByText('quota-burn')).toBeVisible();
  await expect(card.getByText('ship-pipeline')).toBeVisible();
  await expect(card).toHaveScreenshot('fleet-alerts-card.png', stableShot);
});

// Fleet Backups card offline state (#1715, Kody rule [4]): pin the card
// against a FROZEN offline payload - the real e2e server's fleetBackups rows
// derive from runner-local backup state (filesystem snapshots, litestream
// side-channel), which would make the baseline machine-specific. The rest of
// /api/operations still comes from the test server, so the page renders its
// other cards normally. asOf is pinned to FROZEN_NOW_ISO and the page clock
// is frozen, so the relative time renders deterministically.
test('visual: fleet backups card offline', async ({ page }) => {
  test.setTimeout(90_000);
  await settle(page);
  const offlineRow = (id: string, label: string) => ({
    id, label,
    ok: null, present: false, unknown: true,
    latestAgeSeconds: null, bytes: null, fileCount: null,
    reason: 'peer_health_offline',
  });
  // Registered after settle() so it wins over the catch-all /api/** route.
  await page.route('**/api/operations', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.fleetBackups = {
      configured: false,
      offline: true,
      ok: false,
      asOf: FROZEN_NOW_ISO,
      cacheAgeSeconds: 0,
      apps: [
        { id: 'usage-monitor', label: 'Usage Monitor', self: true, ok: false, locations: [
          offlineRow('local-snapshots', 'Local Snapshots'),
          offlineRow('b2-litestream', 'B2 Litestream'),
        ]},
        { id: 'socratic-trade', label: 'Socratic Trade', self: false, ok: false, locations: [
          offlineRow('peer-litestream', 'Live Litestream'),
          offlineRow('b2-litestream', 'B2 Litestream'),
        ]},
      ],
      warnings: ['Backblaze monitor check skipped (offline mode); B2 dump and LTX inventory unavailable.'],
    };
    await route.fulfill({ response, json: body });
  });
  await login(page);
  await page.goto('/ops');
  await pinFonts(page);
  const card = page.locator('section[aria-labelledby="fleet-backups-heading"]');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText('Backup checks skipped (offline mode)')).toBeVisible();
  // Expand the details and pin the per-location offline rows themselves:
  // unobserved rows must read Unavailable, never Healthy or Missing.
  await card.getByRole('button', { name: 'Details' }).click();
  await expect(card.locator('#fleet-backups-detail')).toBeVisible();
  await expect(card.locator('#fleet-backups-detail li').filter({ hasText: 'Unavailable' }).first()).toBeVisible();
  await expect(card).toHaveScreenshot('fleet-backups-offline.png', stableShot);
});
