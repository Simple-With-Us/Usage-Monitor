# Rollout — antigravity-usage N/A remaining is 0

**Why:** Owner 2026-09-04: N/A remaining means none remains.  The collector had stored Gemini N/A as remainingUnknown and did not skip.

**Fix:** Omitted `remainingPercentage` ingests as 0 credits and `isExhausted`.  `GET /api/quota-windows` skips those model ids.

**Verify:** `node scripts/test-antigravity-collector.mjs` and `npx vitest run src/lib/__tests__/quota-windows.test.ts`
