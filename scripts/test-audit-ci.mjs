#!/usr/bin/env node
/**
 * Offline gate: audit-ci.jsonc must allowlist GHSA-vfj7-8cjw-p6xm (braces, dev-only paths)
 * and audit-ci must pass at high severity.  Mirrors .github/workflows/ci.yml audit step.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const configPath = "audit-ci.jsonc";
const requiredGhsa = "GHSA-vfj7-8cjw-p6xm";
const config = readFileSync(configPath, "utf8");

if (!config.includes(requiredGhsa)) {
  console.error(`${configPath} must allowlist ${requiredGhsa}`);
  process.exit(1);
}
if (!/"high"\s*:\s*true/.test(config)) {
  console.error(`${configPath} must set "high": true`);
  process.exit(1);
}

const result = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["audit-ci", "--config", configPath],
  { stdio: "inherit", env: process.env },
);

process.exit(result.status === null ? 1 : result.status);
