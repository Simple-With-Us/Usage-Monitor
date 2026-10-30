# Host-Isolated Unit Tests

## Summary

Usage Monitor tests now keep R2 emergency-state files in a private per-process directory whenever `NODE_ENV=test`.

A test run on a host with `/data` can no longer read, delete, or overwrite live R2 guard state.

Permission-rejection fixtures now apply their intended `0644` mode explicitly after file creation.

This preserves the security assertions when the test runner uses a restrictive umask such as `0077`.

## Files

- `src/lib/r2-usage.ts`
- `src/lib/__tests__/r2-usage.test.ts`
- `src/lib/__tests__/local-keys-bundle.test.ts`
- `src/lib/__tests__/private-billing-receipt-import.test.mjs`

## Verification

- `npx vitest run src/lib/__tests__/r2-usage.test.ts src/lib/__tests__/platform-status-storage.test.ts src/lib/__tests__/usage-maintenance.test.ts src/lib/__tests__/local-keys-bundle.test.ts src/lib/__tests__/private-billing-receipt-import.test.mjs` — 116 passed
- `npm test` — 3,328 passed and 1 skipped
- `npm run typecheck` — passed
- `npm run lint` — 0 errors and 13 pre-existing warnings
- `git diff --check` — passed
- `npm run verify` — reached `test:migrate-safe`, then stopped at Prisma's Codex consent gate for the script's throwaway `/tmp` database

## Follow-Up

None.
