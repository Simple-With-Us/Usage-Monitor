import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  oxc: {
    jsx: { runtime: "automatic" },
  },
  test: {
    globals: true,
    hookTimeout: 60_000,
    testTimeout: 60_000,
    setupFiles: ["./vitest.setup.ts"],
    globalSetup: ["./vitest.global-setup.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.claude/**",
      // Sibling agent worktrees checked out inside this directory (this repo
      // is worked on by a multi-agent fleet) — their test files are not this
      // checkout's code and must not gate local `npm run verify`.
      "**/.worktrees/**",
      "**/tests/e2e/**", // Playwright owns these specs, not Vitest.
      "**/*.workers.test.*",
      // The iOS ship tooling is tested by Node's own test runner
      // (`node --test scripts/ios-fleet/*.test.mjs`) and by the iOS
      // credential step in CI.  Vitest cannot run them:  they are node:test
      // suites, and a file with no Vitest suite in it is a failed file.
      "**/scripts/ios-fleet/**",
      // Node's test runner owns backup cleanup repro suites (see test:backup-concurrent-startup).
      "**/scripts/__tests__/**",
    ],
    coverage: {
      provider: "v8",
      // Ratchet, not aspiration: measured 83.04/74.55/86.25/85.19 on
      // 2026-08-02 (full suite, @vitest/coverage-v8). Thresholds sit ~5
      // points under measured so legitimate refactors don't flap the gate,
      // while a real coverage regression fails CI. Raise them as the suite
      // grows; never lower without a recorded decision.
      thresholds: {
        statements: 78,
        branches: 70,
        functions: 81,
        lines: 80,
      },
      reporter: ["text", "lcov"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // The poller imports `server-only` so the admin key cannot land in a
      // client bundle.  Vitest is a Node runner; the package throws there.
      "server-only": path.resolve(__dirname, "./src/test-shims/server-only.ts"),
    },
  },
});
