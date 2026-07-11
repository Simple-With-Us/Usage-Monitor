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
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
