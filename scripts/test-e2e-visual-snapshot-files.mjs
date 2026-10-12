#!/usr/bin/env node
/**
 * Fail fast when visual.spec.ts references a screenshot baseline that is not
 * committed under tests/e2e/visual.spec.ts-snapshots/.  Playwright only
 * reports missing files at assertion time (#1615 landed fleet-budget shots
 * without PNGs).
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const specPath = join(root, "tests/e2e/visual.spec.ts");
const snapDir = join(root, "tests/e2e/visual.spec.ts-snapshots");
const spec = readFileSync(specPath, "utf8");
const re = /toHaveScreenshot\(\s*['"]([^'"]+)['"]/g;
const names = [...spec.matchAll(re)].map((match) => match[1]);
const missing = names.filter((name) => {
  const base = name.replace(/\.png$/i, "");
  return !existsSync(join(snapDir, `${base}-chromium-linux.png`));
});

if (missing.length > 0) {
  console.error("Missing committed Playwright visual baselines:");
  for (const name of missing) {
    console.error(`  ${name} -> ${snapDir}/${name.replace(/\.png$/i, "")}-chromium-linux.png`);
  }
  process.exit(1);
}

console.log(`ok: ${names.length} visual baseline PNG(s) present`);
