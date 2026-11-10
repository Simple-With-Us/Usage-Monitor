import { test, expect } from '@playwright/test';

// Fleet rollout scaffold: one smoke test. Visits the public login page, expects HTTP 200 and a
// non-empty <title>. Expand into a real suite as the app needs it.
test('login smoke: HTTP 200 and non-empty title', async ({ page, request }) => {
  const response = await request.get('/login');
  expect(response.status(), 'GET /login should return HTTP 200').toBe(200);
  await page.goto('/login');
  await expect(page, 'page should have a non-empty <title>').toHaveTitle(/.+/);
});
