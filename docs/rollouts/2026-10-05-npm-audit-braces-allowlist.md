# 2026-10-05 — npm audit high: braces GHSA allowlist (eslint-config-next / tailwindcss)

## Context

`npm audit --audit-level=high` began failing on `main` after GHSA-vfj7-8cjw-p6xm
(braces stack exhaustion) entered the advisory database.  Seven high findings share
that ID across dev-only paths: `tailwindcss@3.4.x` (chokidar) and
`eslint-config-next` → `@next/eslint-plugin-next` (fast-glob → micromatch → braces).
There is no patched `braces` release on npm (latest 3.0.3).  Bumping `eslint-config-next`
/`next` on the 16.3.x line does not remove `fast-glob` from the ESLint plugin.

PR #1589 temporarily scoped CI to `npm audit --omit=dev`, which hid dev-tree findings
without documenting the advisory.  This rollout restores a **full lockfile** audit via
`audit-ci` and a dated allowlist for the single unfixable GHSA.

## Changes

- `audit-ci.jsonc` — `high: true`, allowlist `GHSA-vfj7-8cjw-p6xm` with review date and path notes.
- `audit-ci@7.1.0` devDependency; `scripts/test-audit-ci.mjs` offline config guard + audit-ci run.
- `.github/workflows/ci.yml` — `npm run test:audit-ci` replaces `npm audit --omit=dev`.

## Verification

- `npm run test:audit-ci` exits 0 (full tree; allowlisted GHSA only).
- Production highs still fail the gate (no blanket ignore).
- Re-review when `braces` publishes a fix or Next removes the `fast-glob` dependency.

## Related

- Board `c59d7e2a0b544300ad31d359bc3d2467`
- Prior workaround: #1589 (`--omit=dev`)
