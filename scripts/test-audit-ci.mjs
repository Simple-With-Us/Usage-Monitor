#!/usr/bin/env node
/**
 * Offline gate: audit-ci.jsonc must allowlist the unfixable picomatch advisory
 * (GHSA-fc5q-39xc-vjpf) and audit-ci must pass at high severity.  Mirrors
 * .github/workflows/ci.yml audit step.  Parses JSONC so a comment mention of
 * a withdrawn GHSA cannot satisfy the allowlist assertion.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const configPath = "audit-ci.jsonc";
const requiredGhsa = "GHSA-fc5q-39xc-vjpf";
const raw = readFileSync(configPath, "utf8");
const jsonc = raw
  .split("\n")
  .map((line) => (line.trim().startsWith("//") ? "" : line))
  .join("\n");
const config = JSON.parse(jsonc);
const allowlist = config.allowlist;

if (!Array.isArray(allowlist) || !allowlist.includes(requiredGhsa)) {
  console.error(`${configPath} allowlist must contain ${requiredGhsa}`);
  process.exit(1);
}
if (config.high !== true) {
  console.error(`${configPath} must set "high": true`);
  process.exit(1);
}

const result = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["audit-ci", "--config", configPath],
  { stdio: "inherit", env: process.env },
);

process.exit(result.status === null ? 1 : result.status);
